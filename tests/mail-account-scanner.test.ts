import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { dangerousAttachmentFilename, scanMail, SCAN_LIMITS, type MailScannerEnvironment } from '../apps/mail/src/server/scanner';
import scannerWorker, { MailScannerContainer } from '../apps/mail/scanner-worker';

const bytes = new TextEncoder().encode('From: sender@example.com\r\n\r\nmessage');
async function fixture() {
  const blobId = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  const input = { accountId: 'account', blobId, size: bytes.byteLength, expectedSha256: blobId };
  const receipt = { status: 'clean', complete: true, sha256: blobId, size: bytes.byteLength, engine: 'clamav', signatureVersion: 'daily-123', threats: [] as string[], limits: SCAN_LIMITS };
  const get = vi.fn(async () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }));
  const fetcher = vi.fn(async () => Response.json(receipt));
  const env: MailScannerEnvironment = { MAIL_BLOBS: { get }, MAIL_SCANNER: { fetch: fetcher } };
  return { input, receipt, env, get, fetcher };
}
describe('Cloudflare malware scanner quarantine boundary', () => {
  const streamedStore = (size: number, actualSize = size) => ({
    size, arrayBuffer: vi.fn(async (): Promise<ArrayBuffer> => { throw new Error('must never buffer R2'); }),
    body: new ReadableStream<Uint8Array>({
      start() {},
      pull(controller) {
        const chunk = Math.min(65536, actualSize);
        if (!chunk) { controller.close(); return; }
        actualSize -= chunk; controller.enqueue(new Uint8Array(chunk));
      },
    }),
  });
  const streamedScanner = vi.fn(async (_url: Request | string, options?: RequestInit) => {
    const reader = (options!.body as ReadableStream<Uint8Array>).getReader(); const hash = createHash('sha256'); let size = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; hash.update(next.value); size += next.value.byteLength; }
    return Response.json({ status: 'clean', complete: true, sha256: hash.digest('hex'), size, engine: 'ClamAV', signatureVersion: 'daily-123', threats: [], limits: SCAN_LIMITS });
  });
  it('streams 50 MiB R2 bodies in two bounded passes when no trusted hash exists', async () => {
    const stores: ReturnType<typeof streamedStore>[] = []; const size = 50 * 1024 * 1024;
    const get = vi.fn(async () => { const blob = streamedStore(size); stores.push(blob); return blob; });
    const result = await scanMail({ accountId: 'account', blobId: 'opaque-raw', size }, { MAIL_BLOBS: { get }, MAIL_SCANNER: { fetch: streamedScanner } });
    expect(result).toMatchObject({ status: 'clean', blobId: 'opaque-raw', size }); expect(get).toHaveBeenCalledTimes(2);
    stores.forEach(blob => expect(blob.arrayBuffer).not.toHaveBeenCalled());
  });
  it('streams one R2 pass when the server has already persisted the expected SHA', async () => {
    const size = 2 * 1024 * 1024; const expectedSha256 = createHash('sha256').update(new Uint8Array(size)).digest('hex');
    const store = streamedStore(size); const get = vi.fn(async () => store);
    expect((await scanMail({ accountId: 'account', blobId: 'uuid-raw', size, expectedSha256 }, { MAIL_BLOBS: { get }, MAIL_SCANNER: { fetch: streamedScanner } })).status).toBe('clean');
    expect(get).toHaveBeenCalledTimes(1); expect(store.arrayBuffer).not.toHaveBeenCalled();
  });
  it('refuses large legacy stores that cannot supply a stream before allocating bytes', async () => {
    const f = await fixture(); f.get.mockResolvedValue({ size: 2 * 1024 * 1024, arrayBuffer: vi.fn(async () => { throw new Error('must not allocate'); }) });
    expect(await scanMail({ ...f.input, size: 2 * 1024 * 1024 }, f.env)).toMatchObject({ status: 'unavailable', reason: 'blobStreamRequired' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects truncated streams and mutation between opaque-ID hashing and forwarding', async () => {
    const truncated = await scanMail({ accountId: 'account', blobId: 'raw', size: 5 }, { MAIL_BLOBS: { get: async () => streamedStore(5, 4) }, MAIL_SCANNER: { fetch: streamedScanner } });
    expect(truncated.status).toBe('unavailable');
    let reads = 0;
    const changed = await scanMail({ accountId: 'account', blobId: 'raw', size: 5 }, { MAIL_BLOBS: { get: async () => {
      const store = streamedStore(5); if (++reads === 2) store.body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 0, 0, 0, 0])); controller.close(); } }); return store;
    } }, MAIL_SCANNER: { fetch: streamedScanner } });
    expect(changed).toMatchObject({ status: 'unavailable', reason: 'blobDigestMismatch' });
  });
  it('certifies only bounded complete scans for the exact stored bytes and persists a receipt digest', async () => {
    const f = await fixture(); const result = await scanMail(f.input, f.env);
    expect(result).toMatchObject({ status: 'clean', sha256: f.input.blobId, engine: 'clamav', signatureVersion: 'daily-123' });
    expect(result.scannerReceiptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.get).toHaveBeenCalledWith(`account/blobs/${f.input.blobId}`);
    const [url, options] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mail-scanner.internal/scan'); expect(options.redirect).toBe('manual');
    expect(options.body).toEqual(bytes); expect(JSON.parse((options.headers as Record<string, string>)['X-Mail-Scan-Limits'])).toEqual(SCAN_LIMITS);
  });
  it('fails closed without a deployed scanner instead of guessing clean from MIME', async () => {
    const f = await fixture(); delete f.env.MAIL_SCANNER;
    expect(await scanMail(f.input, f.env)).toMatchObject({ status: 'unavailable', reason: 'scannerNotConfigured' });
    expect(f.get).not.toHaveBeenCalled();
  });
  it('rejects cross-account traversal, unsafe opaque identifiers and invalid expected digests before reading storage', async () => {
    const f = await fixture();
    expect((await scanMail({ ...f.input, accountId: '../other' }, f.env)).status).toBe('unavailable');
    expect((await scanMail({ ...f.input, blobId: '../mime' }, f.env)).status).toBe('unavailable');
    expect((await scanMail({ ...f.input, expectedSha256: 'not-a-sha256' }, f.env)).status).toBe('unavailable'); expect(f.get).not.toHaveBeenCalled();
  });
  it.each(['57b59d13-b783-4db2-a15c-ae55fcb20240', 'migration-operation-1'])('scans opaque JMAP/import blob identity %s against actual bytes', async blobId => {
    const f = await fixture();
    const result = await scanMail({ accountId: f.input.accountId, blobId, size: f.input.size }, f.env);
    expect(result).toMatchObject({ status: 'clean', blobId, sha256: f.input.expectedSha256 });
    expect(f.get).toHaveBeenCalledWith(`account/blobs/${blobId}`);
  });
  it('does not mistake a hash-shaped opaque identifier for an expected content digest', async () => {
    const f = await fixture(); const blobId = '0'.repeat(64);
    expect(await scanMail({ accountId: 'account', blobId, size: bytes.byteLength }, f.env)).toMatchObject({ status: 'clean', blobId, sha256: f.input.expectedSha256 });
  });
  it('rejects tampering under an opaque identifier when a trusted server-derived hash is provided', async () => {
    const f = await fixture();
    expect(await scanMail({ ...f.input, blobId: '57b59d13-b783-4db2-a15c-ae55fcb20240', expectedSha256: '0'.repeat(64) }, f.env)).toMatchObject({ status: 'unavailable', reason: 'blobDigestMismatch' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('keeps infected messages quarantined and reports bounded threat names', async () => {
    const f = await fixture(); f.fetcher.mockImplementation(async () => Response.json({ ...f.receipt, status: 'infected', threats: ['Eicar-Test-Signature'] }));
    expect(await scanMail(f.input, f.env)).toMatchObject({ status: 'infected', threats: ['Eicar-Test-Signature'], sha256: f.input.blobId });
  });
  it.each([
    { complete: false }, { sha256: '0'.repeat(64) }, { size: 1 }, { signatureVersion: '' },
    { threats: ['contradicts clean'] }, { limits: { ...SCAN_LIMITS, maxExpandedBytes: SCAN_LIMITS.maxExpandedBytes + 1 } },
    { limits: { ...SCAN_LIMITS, maxDepth: 6 } }, { limits: { ...SCAN_LIMITS, maxEntries: 1001 } },
  ])('rejects incomplete, stale or unsafe scanner receipt %j', async patch => {
    const f = await fixture(); f.fetcher.mockImplementation(async () => Response.json({ ...f.receipt, ...patch }));
    expect(await scanMail(f.input, f.env)).toMatchObject({ status: 'unavailable', reason: 'invalidScannerReceipt' });
  });
  it('does not invoke the scanner for messages exceeding the inbound bound', async () => {
    const f = await fixture(); expect((await scanMail({ ...f.input, size: SCAN_LIMITS.maxBytes + 1 }, f.env)).status).toBe('oversized');
    expect(f.get).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('detects altered or truncated storage before the scanner receives bytes', async () => {
    const f = await fixture(); f.get.mockResolvedValue({ size: bytes.byteLength, arrayBuffer: async () => new Uint8Array(bytes.byteLength).buffer });
    expect(await scanMail(f.input, f.env)).toMatchObject({ status: 'unavailable', reason: 'blobDigestMismatch' }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([429, 503, 302])('keeps provider HTTP %i outcomes unavailable', async status => {
    const f = await fixture(); f.fetcher.mockImplementation(async () => new Response('', { status }));
    expect((await scanMail(f.input, f.env)).status).toBe('unavailable'); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds the response even when the scanner omits a Content-Length', async () => {
    const f = await fixture(); f.fetcher.mockImplementation(async () => new Response('x'.repeat(32769)));
    expect((await scanMail(f.input, f.env)).status).toBe('unavailable');
  });
  it('times out an unresponsive service binding without authorizing access', async () => {
    const f = await fixture(); vi.useFakeTimers();
    try {
      f.fetcher.mockImplementation(() => new Promise(() => {}));
      const pending = scanMail(f.input, f.env); await vi.advanceTimersByTimeAsync(45_000);
      expect(await pending).toMatchObject({ status: 'unavailable', reason: 'scannerTimedOut' });
    } finally { vi.useRealTimers(); }
  });
  it('identifies dangerous extension risk without equating it with malware', () => {
    expect(dangerousAttachmentFilename('invoice.PDF.exe')).toBe(true); expect(dangerousAttachmentFilename('macro.docm')).toBe(true);
    expect(dangerousAttachmentFilename('photo.png')).toBe(false);
  });
});

describe('private scanner Container routing', () => {
  it('rejects unsupported, unbounded and invalid-digest requests before starting compute', async () => {
    const get = vi.fn(); const env = { SCANNER: { idFromName: vi.fn(), get } };
    expect((await scannerWorker.fetch(new Request('https://scanner/scan', { method: 'POST' }), env)).status).toBe(411);
    expect((await scannerWorker.fetch(new Request('https://scanner/scan', { method: 'POST', headers: { 'Content-Length': String(SCAN_LIMITS.maxBytes + 1) } }), env)).status).toBe(413);
    expect((await scannerWorker.fetch(new Request('https://scanner/scan', { method: 'POST', headers: { 'Content-Length': '0' } }), env)).status).toBe(400);
    expect((await scannerWorker.fetch(new Request('https://scanner/unknown'), env)).status).toBe(404); expect(get).not.toHaveBeenCalled();
  });
  it('starts the real configured native Container API and forwards to the private port', async () => {
    const forward = vi.fn(async () => Response.json({ ready: true }));
    const start = vi.fn(); const setInactivityTimeout = vi.fn(async () => {});
    const getTcpPort = vi.fn(() => ({ fetch: forward }));
    const instance = new MailScannerContainer({ container: { running: false, start, setInactivityTimeout, getTcpPort }, blockConcurrencyWhile: async task => task() });
    const request = new Request('https://scanner/health'); expect((await instance.fetch(request)).status).toBe(200);
    expect(start).toHaveBeenCalledWith({ enableInternet: true }); expect(setInactivityTimeout).toHaveBeenCalledWith(300_000);
    expect(getTcpPort).toHaveBeenCalledWith(8080); expect(forward).toHaveBeenCalledWith(request);
  });
  it('fails closed when the Container is not configured or cannot start', async () => {
    const absent = new MailScannerContainer({ blockConcurrencyWhile: async task => task() });
    expect((await absent.fetch(new Request('https://scanner/health'))).status).toBe(503);
    const broken = new MailScannerContainer({ container: { running: false, start: () => { throw new Error('not available'); }, setInactivityTimeout: async () => {}, getTcpPort: () => { throw new Error('not reached'); } }, blockConcurrencyWhile: async task => task() });
    expect((await broken.fetch(new Request('https://scanner/health'))).status).toBe(503);
  });
});
