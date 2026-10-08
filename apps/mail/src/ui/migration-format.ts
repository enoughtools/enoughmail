/** Import/export uses bytes: decoding whole messages would corrupt binary MIME bodies. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_MESSAGES = 10000;
export interface MigrationMailbox { id: string; name: string; parentId?: string | null; role?: string | null; color?: string }
export interface ImportMessage { bytes: Uint8Array; keywords: Record<string, boolean>; receivedAt?: string; mailboxIds?: Record<string, boolean>; mailboxes?: MigrationMailbox[] }
const decoder = new TextDecoder();
function metadata(bytes: Uint8Array, envelope?: string): Omit<ImportMessage, 'bytes'> {
  const headers = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 65536))).split(/\r?\n\r?\n/)[0];
  const status = /^Status:\s*(.*)$/im.exec(headers)?.[1] || '';
  const extended = /^X-Status:\s*(.*)$/im.exec(headers)?.[1] || '';
  const keywords: Record<string, boolean> = {};
  const saved = /^X-Enough-Mail-Metadata:\s*(.*)$/im.exec(headers)?.[1];
  let savedDate: string | undefined; let hasSavedKeywords = false; let mailboxIds: Record<string, boolean> | undefined; let mailboxes: MigrationMailbox[] | undefined;
  if (saved) { try { const parsed = JSON.parse(saved);
    if (parsed.mailboxIds && typeof parsed.mailboxIds === 'object' && !Array.isArray(parsed.mailboxIds)) mailboxIds = Object.fromEntries(Object.entries(parsed.mailboxIds).filter(([id, selected]) => id.length <= 255 && !['__proto__', 'constructor', 'prototype'].includes(id) && selected === true).map(([id]) => [id, true]));
    if (Array.isArray(parsed.mailboxes) && parsed.mailboxes.length <= 256) mailboxes = parsed.mailboxes.filter((box: MigrationMailbox) => typeof box.id === 'string' && box.id.length <= 255 && !['__proto__', 'constructor', 'prototype'].includes(box.id) && typeof box.name === 'string' && box.name.length <= 255 && (box.parentId == null || typeof box.parentId === 'string') && (box.role == null || typeof box.role === 'string')).map((box: MigrationMailbox) => ({ id: box.id, name: box.name, parentId: box.parentId || null, role: box.role || null, ...(typeof box.color === 'string' ? { color: box.color } : {}) }));
    hasSavedKeywords = Boolean(parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)); if (typeof parsed.receivedAt === 'string' && Number.isFinite(Date.parse(parsed.receivedAt))) savedDate = parsed.receivedAt; for (const [key, value] of Object.entries(parsed.keywords || {})) if (value === true && key.length <= 255) keywords[key] = true; } catch { /* Legacy exports can omit this optional metadata. */ } }
  if (!hasSavedKeywords && status.includes('R')) keywords['$seen'] = true;
  if (!hasSavedKeywords && extended.includes('F')) keywords['$flagged'] = true;
  if (!hasSavedKeywords && extended.includes('A')) keywords['$answered'] = true;
  if (!hasSavedKeywords && extended.includes('T')) keywords['$draft'] = true;
  const date = savedDate || envelope?.replace(/^From\s+\S+\s+/, '') || /^Date:\s*(.*)$/im.exec(headers)?.[1];
  // Traditional mbox envelopes omit a timezone; use UTC rather than the browser's local timezone.
  const normalizedDate = date && !savedDate && envelope && !/(?:GMT|UTC|[+-]\d{4})\b/.test(date) ? `${date} UTC` : date;
  const stamp = normalizedDate ? Date.parse(normalizedDate) : NaN;
  return { keywords, ...(mailboxIds ? { mailboxIds } : {}), ...(mailboxes ? { mailboxes } : {}), ...(Number.isFinite(stamp) ? { receivedAt: new Date(stamp).toISOString() } : {}) };
}
function validate(bytes: Uint8Array): void {
  if (!bytes.length || bytes.length > MAX_MESSAGE_BYTES) throw new Error('Each message must contain 1 byte to 25 MB.');
  const headers = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  if (!/^[!-9;-~]+:/m.test(headers)) throw new Error('The file contains a message without valid email headers.');
}
/** mboxrd: separators start at a line boundary; remove precisely one quoting >. */
export function parseImport(bytes: Uint8Array, isMbox: boolean): ImportMessage[] {
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES) throw new Error('Choose a non-empty email file up to 100 MB.');
  if (!isMbox) { validate(bytes); return [{ bytes, ...metadata(bytes) }]; }
  const result: ImportMessage[] = []; let parts: Uint8Array[] = []; let length = 0; let envelope: string | undefined;
  function finish() {
    if (!envelope) return;
    const message = new Uint8Array(length); let offset = 0;
    for (const part of parts) { message.set(part, offset); offset += part.length; }
    const details = metadata(message, envelope);
    // Enough exports carry the exact original byte length: strip only our leading metadata line and mbox separator padding.
    let original = message;
    const firstEnd = message.indexOf(10);
    if (firstEnd >= 0) { const first = decoder.decode(message.subarray(0, firstEnd)).replace(/\r$/, ''); const encoded = /^X-Enough-Mail-Metadata:\s*(.*)$/.exec(first)?.[1]; if (encoded) { try { const size = JSON.parse(encoded).rawSize; const payload = message.subarray(firstEnd + 1); if (Number.isInteger(size) && size > 0 && size <= payload.length) original = payload.subarray(0, size); } catch { /* Generic mbox files keep their original headers. */ } } }
    validate(original); result.push({ bytes: original, ...details });
    if (result.length > MAX_IMPORT_MESSAGES) throw new Error('An import can contain at most 10,000 messages. Split the source file into smaller files.');
    parts = []; length = 0;
  }
  for (let start = 0; start < bytes.length;) {
    let end = start; while (end < bytes.length && bytes[end] !== 10) end++;
    if (end < bytes.length) end++;
    const line = { start, end }; start = end;
    const prefix = decoder.decode(bytes.subarray(line.start, Math.min(line.start + 512, line.end))).replace(/\r?\n$/, '');
    if (/^From \S+\s+.+$/.test(prefix)) { finish(); envelope = prefix; continue; }
    if (!envelope) throw new Error('This is not an mbox file: the first line must be a From separator.');
    const unquote = /^>+From /.test(prefix) ? 1 : 0;
    const part = bytes.subarray(line.start + unquote, line.end); length += part.length;
    if (length > MAX_MESSAGE_BYTES + 65536) throw new Error('A message exceeds the 25 MB import limit.');
    if (parts.length >= 100000) throw new Error('A message contains too many lines to import safely.');
    parts.push(part);
  }
  finish(); if (!result.length) throw new Error('No messages were found in the mbox file.'); return result;
}

export function mboxMessage(bytes: Uint8Array, email: { receivedAt: string; keywords: Record<string, boolean>; mailboxIds: Record<string, boolean>; mailboxes?: MigrationMailbox[] }): Uint8Array[] {
  const date = new Date(email.receivedAt);
  const encoder = new TextEncoder();
  const metadata = JSON.stringify({ ...email, rawSize: bytes.length }); if (metadata.length > 60000) throw new Error('Mailbox metadata is too large to preserve in this mbox message.');
  const header = encoder.encode(`From enough-mail ${Number.isNaN(date.getTime()) ? new Date(0).toUTCString() : date.toUTCString()}\r\nX-Enough-Mail-Metadata: ${metadata}\r\n`);
  const parts: Uint8Array[] = [header];
  for (let start = 0; start < bytes.length;) {
    let end = start; while (end < bytes.length && bytes[end] !== 10) end++; if (end < bytes.length) end++;
    const prefix = decoder.decode(bytes.subarray(start, Math.min(start + 100, end)));
    if (/^>*From /.test(prefix)) parts.push(encoder.encode('>'));
    if (parts.length >= 100000) throw new Error('A message contains too many lines to export safely.');
    parts.push(bytes.subarray(start, end)); start = end;
  }
  parts.push(encoder.encode(bytes.at(-1) === 10 ? '\r\n' : '\r\n\r\n'));
  return parts;
}
