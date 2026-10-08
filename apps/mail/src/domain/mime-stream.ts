import { buildMime, parseMime, type MimeBodyPart, type ParsedMime } from './mime';
export interface MimeStreamRange { offset: number; length: number }
export interface MimeStreamSource {
  size: number;
  read(range?: MimeStreamRange): Promise<ReadableStream<Uint8Array>>;
}
export interface StreamMimePart extends MimeBodyPart { encodedRange?: MimeStreamRange; transferEncoding?: string }
export interface MimeStreamOptions {
  /** Aggregate retained UTF-8 body value budget. Full decoded leaves remain available as blobs. */
  maxBodyValueBytes?: number;
  onLeaf?: (part: StreamMimePart, decoded: ReadableStream<Uint8Array>) => Promise<{ blobId?: string } | void>;
}
const MAX_RAW = 64 * 1024 * 1024, CHUNK = 64 * 1024, MAX_HEADERS = 128 * 1024, MAX_TOTAL_HEADERS = 256 * 1024, MAX_METADATA = 2 * 1024 * 1024;
const utf8 = new TextEncoder();
const ascii = (bytes: Uint8Array) => { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return value; };
const bytes = (value: string) => Uint8Array.from(value, c => c.charCodeAt(0));
const header = (part: MimeBodyPart, name: string) => (part.headers || []).filter(h => h.name.toLowerCase() === name).map(h => h.value.replace(/\r?\n[ \t]+/g, ' ').trim()).join(', ');
/** A transfer decoder keeps only a base64 quartet or incomplete QP escape between calls. */
class TransferDecoder {
  private pending = '';
  private padded = false;
  constructor(private encoding: string) {}
  push(chunk: Uint8Array, final = false): Uint8Array {
    if (this.encoding === 'base64') {
      const incoming = ascii(chunk).replace(/[\t\r\n ]/g, '');
      if (this.padded && incoming) throw new Error('Data after MIME base64 padding');
      const input = this.pending + incoming;
      if (/[^A-Za-z0-9+/=]/.test(input)) throw new Error('Invalid MIME base64 content');
      const count = final ? input.length : input.length - input.length % 4;
      const usable = input.slice(0, count); this.pending = input.slice(count);
      if (usable.includes('=')) this.padded = true;
      try { return bytes(atob(usable)); } catch { throw new Error('Invalid MIME base64 content'); }
    }
    if (this.encoding === 'quoted-printable') {
      const input = this.pending + ascii(chunk);
      let end = input.length;
      if (!final) {
        const eq = input.lastIndexOf('=');
        if (eq >= input.length - 2) end = eq;
      }
      this.pending = input.slice(end);
      return bytes(input.slice(0, end).replace(/=\r?\n/g, '').replace(/=([a-f\d]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    }
    return chunk;
  }
}
interface LinePiece { data: Uint8Array; start: number; first: boolean; complete: boolean }
/** Emits bounded fragments even when a binary body has no newline for many megabytes. */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<LinePiece> {
  const reader = stream.getReader(); let position = 0, first = true;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      const chunk = item.value;
      for (let offset = 0; offset < chunk.length;) {
        const newline = chunk.indexOf(10, offset);
        const end = Math.min(newline < 0 ? chunk.length : newline + 1, offset + CHUNK);
        const complete = newline >= 0 && end === newline + 1;
        yield { data: chunk.subarray(offset, end), start: position + offset, first, complete };
        first = complete; offset = end;
      }
      position += chunk.length;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Stream-decode a recorded raw part range. Output chunks never exceed 64 KiB. */
export async function decodedMimePart(source: MimeStreamSource, part: StreamMimePart): Promise<ReadableStream<Uint8Array>> {
  if (!part.encodedRange) throw new Error('MIME part has no encoded range');
  if (!part.encodedRange.length) return new ReadableStream({ start(controller) { controller.close(); } });
  const input = await source.read(part.encodedRange), reader = input.getReader();
  const decoder = new TransferDecoder(part.transferEncoding || '');
  let buffered: Uint8Array | undefined, offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!buffered || offset >= buffered.length) {
            const item = await reader.read();
            if (item.done) { const end = decoder.push(new Uint8Array(), true); if (end.length) controller.enqueue(end); controller.close(); reader.releaseLock(); return; }
            buffered = item.value; offset = 0;
          }
          const chunk = buffered.subarray(offset, offset + CHUNK); offset += chunk.length;
          const output = decoder.push(chunk);
          if (output.length) { controller.enqueue(output); return; }
        }
      } catch (error) { controller.error(error); await reader.cancel().catch(() => {}); }
    }, async cancel(reason) { await reader.cancel(reason); },
  });
}
/** Two-pass MIME parser: bounded scanning followed by independent decoded leaf streams. */
export async function parseMimeStream(source: MimeStreamSource, blobId: string, options: MimeStreamOptions = {}): Promise<ParsedMime> {
  if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > MAX_RAW) throw new Error('Message exceeds MIME size limit');
  let budget = Math.max(0, Math.min(options.maxBodyValueBytes ?? 1024 * 1024, 1024 * 1024));
  let result: ParsedMime | undefined, root: StreamMimePart | undefined;
  const stack: { part: StreamMimePart; boundary: string; path: string; count: number }[] = [];
  const leaves: StreamMimePart[] = [];
  let headers: Uint8Array[] = [], headerSize = 0, inHeaders = true, path = '1', parent: StreamMimePart | undefined;
  let active: { part: StreamMimePart; decoder: TransferDecoder; tail: Uint8Array; text?: TextDecoder; value: string; problem: boolean; truncated: boolean; pendingCR: boolean } | undefined;
  let observed = 0, count = 0, totalHeaders = 0;
  const retain = (output: Uint8Array, final = false) => {
    if (!active) return;
    active.part.size += output.length;
    if (!active.text) return;
    let decoded = (active.pendingCR ? '\r' : '') + active.text.decode(output, { stream: !final });
    active.pendingCR = !final && decoded.endsWith('\r');
    if (active.pendingCR) decoded = decoded.slice(0, -1);
    const value = decoded.replace(/\r\n/g, '\n');
    if (active.part.charset === 'us-ascii' && output.some(b => b > 127)) active.problem = true;
    if (value.includes('\ufffd')) active.problem = true;
    const encoded = utf8.encode(value);
    if (encoded.length <= budget) { active.value += value; budget -= encoded.length; }
    else {
      const allowed = encoded.subarray(0, budget);
      let length = allowed.length;
      // Trim an incomplete final UTF-8 sequence rather than emitting a replacement character.
      while (length > 0) { try { active.value += new TextDecoder('utf-8', { fatal: true }).decode(allowed.subarray(0, length)); break; } catch { length--; } }
      budget = 0; active.truncated = true;
    }
  };
  const payload = (data: Uint8Array) => {
    if (!active) return;
    const joined = new Uint8Array(active.tail.length + data.length); joined.set(active.tail); joined.set(data, active.tail.length);
    const usable = Math.max(0, joined.length - 2);
    retain(active.decoder.push(joined.subarray(0, usable)));
    active.tail = joined.slice(usable);
  };
  const finish = (end: number, boundary: boolean) => {
    if (!active) return;
    let tail = active.tail;
    const trim = boundary && tail.at(-1) === 10 ? tail.at(-2) === 13 ? 2 : 1 : 0;
    retain(active.decoder.push(tail.subarray(0, tail.length - trim)));
    retain(active.decoder.push(new Uint8Array(), true), true);
    active.part.encodedRange!.length = end - active.part.encodedRange!.offset - trim;
    if (active.text) result!.bodyValues[active.part.partId!] = { value: active.value, isEncodingProblem: active.problem, isTruncated: active.truncated };
    active = undefined;
  };
  const finishHeaders = (end: number) => {
    if (++count > 200) throw new Error('Too many MIME parts');
    totalHeaders += headerSize;
    if (totalHeaders > MAX_TOTAL_HEADERS) throw new Error('Aggregate MIME headers exceed limit');
    const data = new Uint8Array(headerSize + 2); let offset = 0;
    for (const chunk of headers) { data.set(chunk, offset); offset += chunk.length; } data.set([13, 10], offset);
    const parsed = parseMime(data, blobId), part = parsed.bodyStructure as StreamMimePart;
    delete part.bytes; part.size = 0; part.partId = part.type.startsWith('multipart/') ? null : path;
    part.blobId = part.partId ? `${blobId}:${path}` : null;
    if (!result) { result = parsed; result.bodyValues = {}; root = part; }
    if (parent) parent.subParts!.push(part);
    headers = []; headerSize = 0; inHeaders = false;
    if (part.type.startsWith('multipart/')) {
      const content = header(part, 'content-type');
      const match = /;\s*boundary\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(content);
      const boundary = (match?.[1] ?? match?.[2] ?? '').replace(/\\(.)/g, '$1');
      if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new Error('Invalid MIME multipart boundary');
      if (stack.length >= 20) throw new Error('MIME nesting exceeds limit');
      part.subParts = []; stack.push({ part, boundary, path, count: 0 });
    } else {
      part.encodedRange = { offset: end, length: 0 }; part.transferEncoding = header(part, 'content-transfer-encoding').toLowerCase();
      leaves.push(part); let text: TextDecoder | undefined, problem = false;
      if (part.type.startsWith('text/')) { try { text = new TextDecoder(part.charset || 'us-ascii'); } catch { text = new TextDecoder(); problem = true; } }
      active = { part, decoder: new TransferDecoder(part.transferEncoding), tail: new Uint8Array(), text, value: '', problem: problem || !['', '7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(part.transferEncoding), truncated: false, pendingCR: false };
    }
  };
  // Boundary/header lines can span input chunks: retain only short candidate lines.
  let short: LinePiece | undefined;
  const consume = (piece: LinePiece) => {
    observed = piece.start + piece.data.length;
    if (observed > MAX_RAW) throw new Error('Message exceeds MIME size limit');
    if (inHeaders) {
      headers.push(piece.data.slice()); headerSize += piece.data.length;
      if (headerSize > MAX_HEADERS) throw new Error('MIME headers exceed limit');
      if (totalHeaders + headerSize > MAX_TOTAL_HEADERS) throw new Error('Aggregate MIME headers exceed limit');
      if (piece.first && piece.complete && (ascii(piece.data) === '\r\n' || ascii(piece.data) === '\n')) finishHeaders(observed);
      return;
    }
    if (piece.first && piece.complete && piece.data.length <= 2048) {
      const line = ascii(piece.data).replace(/\r?\n$/, '').trimEnd();
      let index = -1;
      for (let i = stack.length - 1; i >= 0; i--) { if (line === `--${stack[i].boundary}` || line === `--${stack[i].boundary}--`) { index = i; break; } }
      if (index >= 0) {
        finish(piece.start, true); stack.splice(index + 1);
        const scope = stack[index];
        if (line === `--${scope.boundary}--`) { stack.pop(); parent = undefined; }
        else { path = `${scope.path}.${++scope.count}`; parent = scope.part; inHeaders = true; }
        return;
      }
    }
    payload(piece.data);
  };
  for await (const piece of lines(await source.read())) {
    if (short) {
      const joined = new Uint8Array(short.data.length + piece.data.length); joined.set(short.data); joined.set(piece.data, short.data.length);
      short = { data: joined, start: short.start, first: true, complete: piece.complete };
      if (piece.complete || joined.length > 2048) { consume(short); short = undefined; }
    } else if (piece.first && !piece.complete && piece.data.length <= 2048) short = piece;
    else consume(piece);
  }
  if (short) consume(short);
  if (observed !== source.size) throw new Error('MIME source size mismatch');
  if (inHeaders) finishHeaders(observed);
  finish(observed, false);
  if (!result || !root) throw new Error('Invalid MIME message');
  result.bodyStructure = root;
  const media = (p: MimeBodyPart) => /^(image|audio|video)\//.test(p.type);
  const display = (part: MimeBodyPart, prefer: string): MimeBodyPart[] => {
    if (part.disposition === 'attachment') return [];
    if (!part.subParts) return ['text/plain', 'text/html'].includes(part.type) || media(part) ? [part] : [];
    if (part.type === 'multipart/alternative') { const candidates = part.subParts.map(p => display(p, prefer)).filter(p => p.length); return (candidates.filter(p => p.some(p => p.type === prefer)).at(-1) || candidates.at(-1)) ?? []; }
    if (part.type === 'multipart/related') return part.subParts[0] ? display(part.subParts[0], prefer) : [];
    return part.subParts.flatMap((p, i) => i && p.name && !p.subParts && !media(p) ? [] : display(p, prefer));
  };
  result.textBody = display(root, 'text/plain'); result.htmlBody = display(root, 'text/html');
  result.attachments = leaves.filter(p => (!result!.textBody.includes(p) && !result!.htmlBody.includes(p)) || (media(p) && !(result!.textBody.includes(p) && result!.htmlBody.includes(p))));
  result.preview = result.textBody.map(p => (result!.bodyValues[p.partId!]?.value || '').replace(/<[^>]*>/g, ' ')).join(' ').replace(/\s+/g, ' ').trim().slice(0, 256);
  if (utf8.encode(JSON.stringify(result)).length > MAX_METADATA) throw new Error('MIME metadata exceeds limit');
  if (options.onLeaf) for (const part of leaves) { const saved = await options.onLeaf(part, await decodedMimePart(source, part)); if (saved && saved.blobId) part.blobId = saved.blobId; }
  if (utf8.encode(JSON.stringify(result)).length > MAX_METADATA) throw new Error('MIME metadata exceeds limit');
  return result;
}
export interface MimeComposeOptions { boundary?: string }
/** Freezes headers, body strings and boundaries so a count pass and write pass are identical. */
export function prepareMimeStream(email: Record<string, unknown>, resolveAttachment: (part: MimeBodyPart) => Promise<ReadableStream<Uint8Array>>, options: MimeComposeOptions = {}): { stream(): ReadableStream<Uint8Array> } {
  const attachments = ((email.attachments || []) as MimeBodyPart[]).map(part => ({ ...part }));
  const boundary = options.boundary || `enough-stream-${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(boundary)) throw new Error('Invalid MIME composition boundary');
  const alternate = `${boundary}-alt`;
  // Reject oversized header input before the legacy validator encodes any of it.
  let headerChars = 0;
  const countHeader = (value: unknown): void => {
    if (typeof value === 'string') headerChars += value.length;
    else if (Array.isArray(value)) value.forEach(countHeader);
    else if (value && typeof value === 'object') { const address = value as Record<string, unknown>; countHeader(address.name); countHeader(address.email); }
    if (headerChars > MAX_HEADERS) throw new Error('MIME composition headers exceed limit');
  };
  for (const field of ['subject', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'sentAt', 'messageId', 'inReplyTo', 'references']) countHeader(email[field]);
  for (const part of attachments) { countHeader(part.name); countHeader(part.type); countHeader(part.cid); }
  const frozen = { ...email, sentAt: email.sentAt || new Date().toISOString(), attachments: [], text: '', html: '', textBody: [], htmlBody: [], bodyValues: {} };
  // This call only validates and creates small envelope headers, never large body strings.
  const base = buildMime(frozen);
  const separator = ascii(base).indexOf('\r\nContent-Type:');
  if (separator < 0 || separator > MAX_TOTAL_HEADERS) throw new Error('MIME composition headers exceed limit');
  const envelope = base.slice(0, separator + 2);
  const values = email.bodyValues as Record<string, { value: string }> | undefined;
  const segments = (field: 'textBody' | 'htmlBody', alias: 'text' | 'html'): string[] => {
    if (typeof email[alias] === 'string') return [email[alias] as string];
    if (typeof email[field] === 'string') return [email[field] as string];
    return Array.isArray(email[field]) ? (email[field] as MimeBodyPart[]).map(p => values?.[p.partId!]?.value || '') : [];
  };
  const plain = segments('textBody', 'text'), html = segments('htmlBody', 'html');
  const hasHtml = html.some(value => value.length > 0);
  const attachmentHeaders = attachments.map(part => {
    const sample = ascii(buildMime({ attachments: [{ ...part, bytes: new Uint8Array() }] }));
    const start = sample.indexOf(`Content-Type: ${part.type || 'application/octet-stream'}\r\nContent-Disposition:`);
    const end = sample.indexOf('\r\n\r\n', start);
    if (start < 0 || end < 0) throw new Error('Invalid MIME attachment metadata');
    return utf8.encode(sample.slice(start, end) + '\r\n\r\n');
  });
  if (attachmentHeaders.reduce((sum, header) => sum + header.length, envelope.length) > MAX_TOTAL_HEADERS) throw new Error('Aggregate MIME headers exceed limit');
  async function* textBytes(strings: string[]): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < strings.length; index++) {
      if (index) yield utf8.encode('\n');
      const value = strings[index];
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(offset + 16384, value.length);
        const last = value.charCodeAt(end - 1);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
        yield utf8.encode(value.slice(offset, end)); offset = end;
      }
    }
  }
  async function* encoded(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    let carry = new Uint8Array(), column = 0;
    const encode = (data: Uint8Array) => {
      const value = btoa(ascii(data)); let result = '';
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(76 - column, value.length - offset);
        result += value.slice(offset, offset + count); column += count; offset += count;
        if (column === 76) { result += '\r\n'; column = 0; }
      }
      return utf8.encode(result);
    };
    for await (const item of input) for (let i = 0; i < item.length; i += CHUNK) {
      const fragment = item.subarray(i, i + CHUNK), joined = new Uint8Array(carry.length + fragment.length);
      joined.set(carry); joined.set(fragment, carry.length);
      const length = joined.length - joined.length % 3;
      if (length) yield encode(joined.subarray(0, length)); carry = joined.slice(length);
    }
    if (carry.length) yield encode(carry);
  }
  async function* attachmentBytes(part: MimeBodyPart): AsyncGenerator<Uint8Array> {
    const reader = (await resolveAttachment(part)).getReader();
    try { while (true) { const item = await reader.read(); if (item.done) return; yield item.value; } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function* bodyPart(type: string, values: string[]): AsyncGenerator<Uint8Array> {
    yield utf8.encode(`Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
    yield* encoded(textBytes(values));
  }
  async function* output(): AsyncGenerator<Uint8Array> {
    yield envelope;
    if (attachments.length) yield utf8.encode(`Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n`);
    if (hasHtml) yield utf8.encode(`Content-Type: multipart/alternative; boundary="${alternate}"\r\n\r\n--${alternate}\r\n`);
    yield* bodyPart('text/plain', plain);
    if (hasHtml) {
      yield utf8.encode(`\r\n--${alternate}\r\n`); yield* bodyPart('text/html', html);
      yield utf8.encode(`\r\n--${alternate}--`);
    }
    for (let index = 0; index < attachments.length; index++) {
      yield utf8.encode(`\r\n--${boundary}\r\n`); yield attachmentHeaders[index];
      yield* encoded(attachmentBytes(attachments[index]));
    }
    yield utf8.encode(attachments.length ? `\r\n--${boundary}--\r\n` : '\r\n');
  }
  return { stream() {
    const iterator = output(); let total = 0;
    return new ReadableStream({ async pull(c) {
      try { const item = await iterator.next(); if (item.done) c.close(); else {
        total += item.value.length; if (total > MAX_RAW) throw new Error('Message exceeds MIME size limit'); c.enqueue(item.value);
      } } catch (error) { c.error(error); await iterator.return(undefined); }
    }, async cancel() { await iterator.return(undefined); } });
  } };
}
/** Backwards-compatible one-shot stream; pass a stable boundary for counted two-pass callers. */
export function buildMimeStream(email: Record<string, unknown>, resolveAttachment: (part: MimeBodyPart) => Promise<ReadableStream<Uint8Array>>, options: MimeComposeOptions = {}): ReadableStream<Uint8Array> {
  return prepareMimeStream(email, resolveAttachment, options).stream();
}
