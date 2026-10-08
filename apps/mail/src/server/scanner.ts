import { createHash } from 'node:crypto';

export const SCAN_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxExpandedBytes: 100 * 1024 * 1024, maxDepth: 5, maxEntries: 1000 });
const MAX_BUFFERED_FALLBACK_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const SCAN_TIMEOUT_MS = 45_000;
export interface MailScannerEnvironment {
  MAIL_BLOBS: { get(key: string): Promise<{ size: number; body?: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> } | null> };
  /** Internal Cloudflare service binding to the scanner Container adapter. No public URL fallback. */
  MAIL_SCANNER?: { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}
export interface MailScanResult {
  status: 'clean' | 'infected' | 'unavailable' | 'oversized';
  blobId: string;
  size: number;
  sha256?: string;
  reason?: string;
  engine?: string;
  signatureVersion?: string;
  threats?: string[];
  /** SHA-256 of the bounded scanner receipt, suitable for immutable audit persistence. */
  scannerReceiptDigest?: string;
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), b => b.toString(16).padStart(2, '0')).join('');
}
/** Hash without retaining chunks. Never tee: a faster hash branch could buffer the whole mail. */
async function hashBlobStream(source: ReadableStream<Uint8Array>, size: number, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256'); const reader = source.getReader(); let received = 0;
  const abort = () => { void reader.cancel('scanTimedOut').catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('scannerTimedOut');
      const next = await reader.read(); if (next.done) break;
      received += next.value.byteLength;
      if (received > size || received > SCAN_LIMITS.maxBytes) throw new Error('blobSizeMismatch');
      hash.update(next.value);
    }
    if (signal.aborted) throw new Error('scannerTimedOut');
    if (received !== size) throw new Error('blobSizeMismatch');
    return hash.digest('hex');
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function scanBodyStream(source: ReadableStream<Uint8Array>, size: number, signal: AbortSignal) {
  const hash = createHash('sha256'); const reader = source.getReader(); let received = 0; let sha256: string | undefined;
  let released = false;
  const release = () => { signal.removeEventListener('abort', abort); if (!released) { released = true; reader.releaseLock(); } };
  const abort = () => { void reader.cancel('scanTimedOut').catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) throw new Error('scannerTimedOut');
        const next = await reader.read();
        if (next.done) {
          if (received !== size) throw new Error('blobSizeMismatch');
          sha256 = hash.digest('hex'); release(); controller.close(); return;
        }
        received += next.value.byteLength;
        if (received > size || received > SCAN_LIMITS.maxBytes) throw new Error('blobSizeMismatch');
        hash.update(next.value); controller.enqueue(next.value);
      } catch (error) { await reader.cancel(error).catch(() => {}); release(); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); release(); },
  });
  return { body, sha256: () => sha256 };
}
async function boundedReceipt(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('emptyReceipt');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RECEIPT_BYTES) { await reader.cancel(); throw new Error('receiptTooLarge'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
/** File type risk is separate from malware detection; this never certifies a file as clean. */
export function dangerousAttachmentFilename(name: string): boolean {
  return /\.(?:exe|com|scr|pif|bat|cmd|msi|msp|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|jar|iso|img|docm|xlsm|pptm)\s*$/i.test(name);
}
/** Unknown, incomplete, throttled and unconfigured scans remain quarantined. */
export async function scanMail(input: { accountId: string; blobId: string; size: number; expectedSha256?: string }, env: MailScannerEnvironment): Promise<MailScanResult> {
  const base = { blobId: input.blobId, size: input.size };
  const unavailable = (reason: string): MailScanResult => ({ ...base, status: 'unavailable', reason });
  // JMAP upload/import IDs are opaque; only a separately persisted server-derived
  // hash may be treated as an expected content digest. Never infer it from the ID.
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.accountId) || !/^[a-zA-Z0-9_.-]{1,256}$/.test(input.blobId) || ['.', '..'].includes(input.blobId)
    || (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedSha256))
    || !Number.isSafeInteger(input.size) || input.size < 0) return unavailable('invalidScanRequest');
  if (input.size > SCAN_LIMITS.maxBytes) return { ...base, status: 'oversized', reason: 'messageTooLarge' };
  if (!env.MAIL_SCANNER) return unavailable('scannerNotConfigured');
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<MailScanResult> => {
    const key = `${input.accountId}/blobs/${input.blobId}`;
    const blob = await env.MAIL_BLOBS.get(key);
    if (!blob) return unavailable('blobNotFound');
    if (blob.size > SCAN_LIMITS.maxBytes) return { ...base, status: 'oversized', reason: 'messageTooLarge' };
    if (blob.size !== input.size) return unavailable('blobSizeMismatch');
    let sha256: string; let body: BodyInit; let streamed: ReturnType<typeof scanBodyStream> | undefined; let forwarding: Promise<void> | undefined;
    if (blob.body) {
      // Trusted server-derived hashes allow a single R2 pass. Otherwise use two
      // bounded passes so the Container can require the digest before reading MIME.
      sha256 = input.expectedSha256 ?? await hashBlobStream(blob.body, input.size, controller.signal);
      const scanBlob = input.expectedSha256 ? blob : await env.MAIL_BLOBS.get(key);
      if (!scanBlob?.body || scanBlob.size !== input.size) return unavailable('blobSizeMismatch');
      streamed = scanBodyStream(scanBlob.body, input.size, controller.signal); body = streamed.body;
      // Workers ignores a manually assigned Content-Length for an ordinary stream.
      // FixedLengthStream preserves HTTP framing to the private Container port.
      const FixedLength = (globalThis as typeof globalThis & { FixedLengthStream?: new (size: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).FixedLengthStream;
      if (FixedLength) {
        const fixed = new FixedLength(input.size); forwarding = streamed.body.pipeTo(fixed.writable);
        void forwarding.catch(() => controller.abort()); body = fixed.readable;
      }
    } else {
      // Small compatibility adapters may lack R2.body; never buffer large mail in a Worker.
      if (blob.size > MAX_BUFFERED_FALLBACK_BYTES) return unavailable('blobStreamRequired');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.byteLength !== input.size) return unavailable('blobSizeMismatch');
      sha256 = await digest(bytes);
      if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) return unavailable('blobDigestMismatch');
      body = bytes as BodyInit;
    }
    if (controller.signal.aborted) return unavailable('scannerTimedOut');
    const response = await env.MAIL_SCANNER!.fetch('https://mail-scanner.internal/scan', {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'message/rfc822', 'Content-Length': String(input.size), 'X-Mail-Account': input.accountId, 'X-Mail-SHA256': sha256, 'X-Mail-Scan-Limits': JSON.stringify(SCAN_LIMITS) },
      body, ...({ duplex: 'half' } as RequestInit),
    });
    if (!response.ok) { await response.body?.cancel(); return unavailable(response.status === 429 ? 'scannerThrottled' : `scannerHttp${response.status}`); }
    if (forwarding) await forwarding;
    if (streamed && streamed.sha256() !== sha256) { await response.body?.cancel(); return unavailable(streamed.sha256() ? 'blobDigestMismatch' : 'incompleteBlobStream'); }
    const receiptBytes = await boundedReceipt(response);
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes));
    const limits = receipt?.limits;
    if (!receipt || !['clean', 'infected'].includes(receipt.status) || receipt.complete !== true || receipt.sha256 !== sha256 || receipt.size !== input.size
      || typeof receipt.engine !== 'string' || !receipt.engine.length || receipt.engine.length > 128
      || typeof receipt.signatureVersion !== 'string' || !receipt.signatureVersion.length || receipt.signatureVersion.length > 128
      || !limits || !Object.entries(SCAN_LIMITS).every(([key, value]) => Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= value)
      || !Array.isArray(receipt.threats) || receipt.threats.length > 100 || receipt.threats.some((v: unknown) => typeof v !== 'string' || !v.length || v.length > 256)
      || (receipt.status === 'clean' && receipt.threats.length !== 0) || (receipt.status === 'infected' && receipt.threats.length === 0)) return unavailable('invalidScannerReceipt');
    return { ...base, status: receipt.status, sha256, engine: receipt.engine, signatureVersion: receipt.signatureVersion, threats: receipt.threats, scannerReceiptDigest: await digest(receiptBytes) };
  };
  try {
    return await Promise.race([work(), new Promise<MailScanResult>(resolve => {
      timeout = setTimeout(() => { controller.abort(); resolve(unavailable('scannerTimedOut')); }, SCAN_TIMEOUT_MS);
    })]);
  } catch { return unavailable('scannerUnavailable'); }
  finally { if (timeout !== undefined) clearTimeout(timeout); controller.abort(); }
}
