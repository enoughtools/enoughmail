/** Cloudflare Email Service adapter. A provider acceptance is not final delivery. */
export const MAX_OUTBOUND_BYTES = 5 * 1024 * 1024;
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
export interface MailBlobStore {
  put(key: string, value: Uint8Array, options?: { customMetadata: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
export interface CloudflareMailEnvironment {
  MAIL_BLOBS: MailBlobStore;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}
export interface StoredEnvelope { blobId: string; objectKey: string; size: number; from: string; to: string }
export interface DeliveryResult {
  status: 'accepted' | 'rejected' | 'unknown';
  providerId?: string;
  error?: string;
  delivered?: string[];
  queued?: string[];
  permanentBounces?: string[];
  suppressed?: string[];
}
export function validAddress(value: string): boolean {
  return value.length <= 254 && /^[^\s<>@\r\n]+@[^\s<>@\r\n]+\.[^\s<>@\r\n]+$/.test(value);
}
async function readBounded(raw: ReadableStream<Uint8Array> | Uint8Array, max: number): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) { if (raw.length > max) throw new Error('messageTooLarge'); return raw; }
  const reader = raw.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > max) { await reader.cancel(); throw new Error('messageTooLarge'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
/** Caller resolves the authorized recipient account before reading/storing any raw bytes. */
export async function receiveMail(env: CloudflareMailEnvironment,
  envelope: { accountId: string; from: string; to: string; raw: ReadableStream<Uint8Array> | Uint8Array },
  commit: (stored: StoredEnvelope) => Promise<void>): Promise<StoredEnvelope> {
  if (!validAddress(envelope.to) || (envelope.from !== '' && !validAddress(envelope.from))) throw new Error('invalidEnvelope');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(envelope.accountId)) throw new Error('invalidAccount');
  const bytes = await readBounded(envelope.raw, MAX_INBOUND_BYTES);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  const blobId = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
  const objectKey = `${envelope.accountId}/blobs/${blobId}`;
  // MIME is content addressed; envelope belongs to the account's immutable receipt.
  await env.MAIL_BLOBS.put(objectKey, bytes);
  const stored = { blobId, objectKey, size: bytes.length, from: envelope.from, to: envelope.to };
  await commit(stored); // Throw to reject acceptance if account persistence failed. Retain recoverable R2 bytes.
  return stored;
}
/** No automatic retry: network failures and server errors may have accepted the message. */
export async function sendRawMail(env: CloudflareMailEnvironment,
  message: { from: string; to: string[]; blobId: string; accountId?: string; objectKey?: string },
  beforeAttempt: () => Promise<void> = async () => {}, fetcher: typeof fetch = fetch): Promise<DeliveryResult> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return { status: 'rejected', error: 'sendingNotConfigured' };
  if (!validAddress(message.from) || !message.to.length || message.to.some(v => !validAddress(v))) return { status: 'rejected', error: 'invalidEnvelope' };
  const key = message.objectKey ?? (message.accountId ? `${message.accountId}/blobs/${message.blobId}` : message.blobId);
  const blob = await env.MAIL_BLOBS.get(key);
  if (!blob) return { status: 'rejected', error: 'blobNotFound' };
  if (blob.size > MAX_OUTBOUND_BYTES) return { status: 'rejected', error: 'messageTooLarge' };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > MAX_OUTBOUND_BYTES) return { status: 'rejected', error: 'messageTooLarge' };
  let mime: string;
  try { mime = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { status: 'rejected', error: 'invalidMimeEncoding' }; }
  // Durable pending/attempted state MUST be committed before the non-idempotent provider call.
  await beforeAttempt();
  try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/email/sending/send_raw`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: message.from, recipients: message.to, mime_message: mime }), redirect: 'manual',
    });
    if (!response.ok) return { status: response.status >= 500 || response.status === 408 || response.status >= 300 && response.status < 400 ? 'unknown' : 'rejected', error: `providerHttp${response.status}` };
    const body = await response.json() as { success?: boolean; result?: { message_id?: string; delivered?: string[]; queued?: string[]; permanent_bounces?: string[]; suppressed_recipients?: string[] } };
    if (body.success === false) return { status: 'rejected', error: 'providerRejected' };
    if (body.success !== true || !body.result) return { status: 'unknown', error: 'invalidProviderResponse' };
    return { status: 'accepted', providerId: body.result.message_id, delivered: body.result.delivered, queued: body.result.queued,
      permanentBounces: body.result.permanent_bounces, suppressed: body.result.suppressed_recipients };
  } catch { return { status: 'unknown', error: 'providerOutcomeUnknown' }; }
}
