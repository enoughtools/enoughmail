/** Product-owned MIME conversion. HTML values remain untrusted and must be sanitized by the UI. */
export interface MimeAddress { name: string | null; email: string }
export interface MimeBodyPart {
  partId: string | null; blobId: string | null; type: string; size: number; name: string | null;
  charset: string | null; disposition: string | null; cid: string | null;
  headers?: { name: string; value: string }[]; language?: string[] | null;
  location?: string | null; subParts?: MimeBodyPart[] | null;
  bytes?: Uint8Array;
}
export interface MimeBodyValue { value: string; isEncodingProblem: boolean; isTruncated: boolean }
export interface ParsedMime {
  subject: string; sender: MimeAddress[] | null; from: MimeAddress[]; to: MimeAddress[]; cc: MimeAddress[]; bcc: MimeAddress[];
  replyTo: MimeAddress[]; sentAt: string | null; messageId: string[]; inReplyTo: string[];
  references: string[]; bodyStructure: MimeBodyPart; preview: string; textBody: MimeBodyPart[]; htmlBody: MimeBodyPart[];
  bodyValues: Record<string, MimeBodyValue>; attachments: MimeBodyPart[];
  headers: { name: string; value: string }[];
}
const MAX_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
function binary(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}
function octets(value: string): Uint8Array { return Uint8Array.from(value, c => c.charCodeAt(0) & 255); }
function decode(bytes: Uint8Array, charset = 'utf-8'): string {
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}
function quotedPrintable(value: string): Uint8Array {
  return octets(value.replace(/=\r?\n/g, '').replace(/=([a-f\d]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
}
function transfer(value: string, encoding: string): Uint8Array {
  if (encoding.toLowerCase() === 'base64') {
    try { return octets(atob(value.replace(/\s/g, ''))); } catch { throw new Error('Invalid MIME base64 content'); }
  }
  return encoding.toLowerCase() === 'quoted-printable' ? quotedPrintable(value) : octets(value);
}
function headerText(value: string): string {
  // RFC 6532 permits UTF-8 directly in headers. Keep legacy bytes if not valid UTF-8.
  if (/[\x80-\xff]/.test(value) && !/[\u0100-\uffff]/.test(value)) {
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(octets(value)); } catch { /* Legacy header. */ }
  }
  return value.replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (whole, charset: string, encoding: string, data: string) => {
      try { return decode(encoding.toLowerCase() === 'b' ? octets(atob(data)) : quotedPrintable(data.replace(/_/g, ' ')), charset); }
      catch { return whole; }
    });
}
function splitEntity(raw: string): { headers: ParsedMime['headers']; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const head = match ? raw.slice(0, match.index) : raw;
  if (head.length > 128 * 1024) throw new Error('MIME headers exceed limit');
  const headers: ParsedMime['headers'] = [];
  // Raw JMAP header values retain leading whitespace and folded line boundaries.
  // Parsing helpers unfold separately, so raw property reads remain lossless.
  for (const match of head.matchAll(/^([!-9;-~]+):([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/gm)) {
    headers.push({ name: match[1], value: decode(octets(match[2].replace(/\x00/g, '')), 'utf-8') });
    if (headers.length > 1000) throw new Error('Too many MIME headers');
  }
  return { headers, body: match ? raw.slice(match.index + match[0].length) : '' };
}
function get(headers: ParsedMime['headers'], name: string): string {
  return headers.filter(h => h.name.toLowerCase() === name).map(h => h.value.replace(/\r?\n[ \t]+/g, ' ').trim()).join(', ');
}
function parameters(value: string): { value: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const pattern = /;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g;
  for (const match of value.matchAll(pattern)) {
    const key = match[1].toLowerCase();
    let data = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
    if (key.endsWith('*')) {
      const extended = /^([^']*)'[^']*'(.*)$/.exec(data);
      if (extended) {
        try { data = decode(octets(extended[2].replace(/%([a-f\d]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))), extended[1] || 'utf-8'); } catch { /* Preserve malformed filename. */ }
      }
    }
    params[key.replace(/\*$/, '')] = headerText(data);
  }
  return { value: value.split(';')[0].trim().toLowerCase(), params };
}
export function parseAddresses(value: string): MimeAddress[] {
  const entries = value.split(/,(?=(?:[^"\\]*"[^"\\]*")*[^"\\]*$)(?![^<]*>)/);
  const result: MimeAddress[] = [];
  for (let entry of entries) {
    entry = entry.trim().replace(/^[^<@:]*:\s*/, '').replace(/;$/, '');
    if (!entry) continue;
    const angle = /^(.*?)<([^<>]+)>$/.exec(entry);
    const email = (angle ? angle[2] : entry.replace(/\s*\([^)]*\)/g, '')).trim();
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) continue;
    const name = angle ? headerText(angle[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')) : '';
    result.push({ name: name || null, email });
  }
  return result;
}
function ids(value: string): string[] { return [...value.matchAll(/<([^<>\s]+)>/g)].map(m => m[1]); }
export function parseMime(raw: Uint8Array, blobId: string): ParsedMime {
  if (raw.length > MAX_BYTES) throw new Error('Message exceeds MIME size limit');
  const root = splitEntity(binary(raw));
  const date = new Date(get(root.headers, 'date'));
  const result: ParsedMime = {
    subject: headerText(get(root.headers, 'subject')), sender: get(root.headers, 'sender') ? parseAddresses(get(root.headers, 'sender')) : null, from: parseAddresses(get(root.headers, 'from')),
    to: parseAddresses(get(root.headers, 'to')), cc: parseAddresses(get(root.headers, 'cc')),
    bcc: parseAddresses(get(root.headers, 'bcc')), replyTo: parseAddresses(get(root.headers, 'reply-to')),
    sentAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
    messageId: ids(get(root.headers, 'message-id')), inReplyTo: ids(get(root.headers, 'in-reply-to')),
    references: ids(get(root.headers, 'references')), bodyStructure: null as unknown as MimeBodyPart, preview: '', textBody: [], htmlBody: [],
    bodyValues: {}, attachments: [], headers: root.headers,
  };
  let count = 0;
  function visit(entity: ReturnType<typeof splitEntity>, partId: string, depth: number, implicitType = 'text/plain'): MimeBodyPart {
    if (++count > 200 || depth > 20) throw new Error('MIME nesting or part count exceeds limit');
    const content = parameters(get(entity.headers, 'content-type') || implicitType);
    const disposition = parameters(get(entity.headers, 'content-disposition'));
    const charset = content.value.startsWith('text/') ? content.params.charset || 'us-ascii' : null;
    const info: MimeBodyPart = { partId, blobId: `${blobId}:${partId}`, type: content.value, size: 0,
      name: disposition.params.filename || content.params.name || null, charset,
      disposition: disposition.value || null, headers: entity.headers,
      cid: get(entity.headers, 'content-id').replace(/^<|>$/g, '') || null,
      language: get(entity.headers, 'content-language') ? get(entity.headers, 'content-language').split(',').map(s => s.trim()).filter(Boolean) : null,
      location: get(entity.headers, 'content-location') || null, subParts: null };
    if (content.value.startsWith('multipart/')) {
      info.partId = null; info.blobId = null; info.subParts = [];
      const boundary = content.params.boundary;
      if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new Error('Invalid MIME multipart boundary');
      const lines = entity.body.split(/\r?\n/);
      let part: string[] | null = null, index = 0;
      const append = () => {
        if (part) info.subParts!.push(visit(splitEntity(part.join('\r\n')), `${partId}.${++index}`, depth + 1,
          content.value === 'multipart/digest' ? 'message/rfc822' : 'text/plain'));
      };
      for (const line of lines) {
        if (line.trimEnd() === `--${boundary}` || line.trimEnd() === `--${boundary}--`) {
          append();
          if (line.trimEnd() === `--${boundary}--`) { part = null; break; }
          part = [];
        } else if (part) part.push(line);
      }
      if (part?.length) append();
      return info;
    }
    const encoding = get(entity.headers, 'content-transfer-encoding').toLowerCase();
    const bytes = transfer(entity.body, encoding);
    info.size = bytes.length; info.bytes = bytes;
    if (content.value.startsWith('text/')) {
      let unknownCharset = false;
      try { new TextDecoder(charset || 'us-ascii'); } catch { unknownCharset = true; }
      const value = decode(bytes, charset || 'us-ascii').replace(/\r\n/g, '\n');
      result.bodyValues[partId] = { value, isEncodingProblem: unknownCharset || value.includes('\ufffd') ||
        !['', '7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(encoding) ||
        (charset === 'us-ascii' && bytes.some(b => b > 127)), isTruncated: false };
    }
    return info;
  }
  result.bodyStructure = visit(root, '1', 0);
  const media = (part: MimeBodyPart) => /^(image|audio|video)\//.test(part.type);
  function display(part: MimeBodyPart, prefer: 'text/plain' | 'text/html'): MimeBodyPart[] {
    if (part.disposition === 'attachment') return [];
    if (!part.subParts) return ['text/plain', 'text/html'].includes(part.type) || media(part) ? [part] : [];
    const children = part.subParts;
    if (part.type === 'multipart/alternative') {
      const candidates = children.map(child => display(child, prefer)).filter(parts => parts.length);
      const preferred = candidates.filter(parts => parts.some(p => p.type === prefer));
      return (preferred.length ? preferred : candidates).at(-1) || [];
    }
    if (part.type === 'multipart/related') return children.length ? display(children[0], prefer) : [];
    return children.flatMap((child, index) => child.name && index > 0 && !media(child) && !child.subParts ? [] : display(child, prefer));
  }
  result.textBody = display(result.bodyStructure, 'text/plain');
  result.htmlBody = display(result.bodyStructure, 'text/html');
  function collect(part: MimeBodyPart): void {
    if (part.subParts) part.subParts.forEach(collect);
    else if ((!result.textBody.includes(part) && !result.htmlBody.includes(part)) ||
      (media(part) && !(result.textBody.includes(part) && result.htmlBody.includes(part)))) result.attachments.push(part);
  }
  collect(result.bodyStructure);
  // Preview is text only; bodyValues remain untrusted data for the UI sanitizer.
  const previewParts = result.textBody.length ? result.textBody : result.htmlBody;
  const preview = previewParts.map(p => {
    const value = result.bodyValues[p.partId!]?.value || '';
    return p.type === 'text/html' ? value.replace(/<[^>]*>/g, ' ') : value;
  }).join(' ');
  result.preview = preview.replace(/\s+/g, ' ').trim().slice(0, 256);
  return result;
}
function safeHeader(value: unknown): string {
  const text = String(value ?? '');
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('Mail headers cannot contain control characters');
  return text;
}
function encodeHeader(value: unknown): string {
  const text = safeHeader(value);
  return /[^\x20-\x7e]/.test(text) ? `=?UTF-8?B?${btoa(binary(encoder.encode(text)))}?=` : text;
}
function addressHeader(value: unknown): string {
  const addresses = Array.isArray(value) ? value : value ? [value] : [];
  return addresses.map(item => {
    const address = typeof item === 'string' ? { email: item, name: null } : item as MimeAddress;
    const email = safeHeader(address.email);
    if (!/^[^\s<>@,;"\\]+@[^\s<>@,;"\\]+$/.test(email)) throw new Error('Invalid recipient address');
    const name = safeHeader(address.name);
    return name ? `${/[^\x20-\x7e]/.test(name) ? encodeHeader(name) : `"${name.replace(/["\\]/g, '\\$&')}"`} <${email}>` : email;
  }).join(', ');
}
function base64(bytes: Uint8Array): string { return btoa(binary(bytes)).replace(/.{1,76}/g, '$&\r\n').trimEnd(); }
/** Attachments must have retrieved bytes; callers may resolve blob IDs before calling. */
export function buildMime(email: Record<string, unknown>): Uint8Array {
  const headers = ['MIME-Version: 1.0'];
  for (const field of ['sender', 'from', 'to', 'cc', 'replyTo']) {
    const value = addressHeader(email[field]);
    if (value) headers.push(`${field === 'replyTo' ? 'Reply-To' : field[0].toUpperCase() + field.slice(1)}: ${value}`);
  }
  // Validate Bcc as envelope recipients without exposing them in transport headers.
  addressHeader(email.bcc);
  headers.push(`Subject: ${encodeHeader(email.subject)}`);
  const date = email.sentAt ? new Date(safeHeader(email.sentAt)) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid sent date');
  headers.push(`Date: ${date.toUTCString()}`);
  for (const [field, name] of [['messageId', 'Message-ID'], ['inReplyTo', 'In-Reply-To'], ['references', 'References']]) {
    const values = Array.isArray(email[field]) ? email[field] as unknown[] : email[field] ? [email[field]] : [];
    if (values.length) headers.push(`${name}: ${values.map(value => {
      const id = safeHeader(value).replace(/^<|>$/g, '');
      if (/[<>\s]/.test(id) || !id) throw new Error('Invalid mail message identifier');
      return `<${id}>`;
    }).join(' ')}`);
  }
  const bodyValues = email.bodyValues as Record<string, MimeBodyValue> | undefined;
  function text(field: 'textBody' | 'htmlBody', alias: 'text' | 'html'): string {
    if (typeof email[alias] === 'string') return email[alias] as string;
    if (typeof email[field] === 'string') return email[field] as string;
    return Array.isArray(email[field]) ? (email[field] as MimeBodyPart[]).map(p => bodyValues?.[p.partId!]?.value ?? '').join('\n') : '';
  }
  function textPart(value: string, type: string): string {
    return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(encoder.encode(value))}`;
  }
  const plain = text('textBody', 'text'), html = text('htmlBody', 'html');
  let body = textPart(plain, 'text/plain');
  const alternative = `enough-alt-${crypto.randomUUID()}`;
  if (html) body = `Content-Type: multipart/alternative; boundary="${alternative}"\r\n\r\n--${alternative}\r\n${body}\r\n--${alternative}\r\n${textPart(html, 'text/html')}\r\n--${alternative}--`;
  const attachments = email.attachments as MimeBodyPart[] | undefined;
  if (attachments?.length) {
    const boundary = `enough-mixed-${crypto.randomUUID()}`;
    const parts = attachments.map(part => {
      if (!(part.bytes instanceof Uint8Array)) throw new Error('Attachment bytes must be resolved before sending');
      const type = safeHeader(part.type || 'application/octet-stream');
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) throw new Error('Invalid attachment content type');
      const name = safeHeader(part.name || 'attachment');
      const cid = part.cid ? safeHeader(part.cid).replace(/[<>]/g, '') : null;
      return `Content-Type: ${type}\r\nContent-Disposition: ${part.disposition === 'inline' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}\r\n${cid ? `Content-ID: <${cid}>\r\n` : ''}Content-Transfer-Encoding: base64\r\n\r\n${base64(part.bytes)}`;
    });
    body = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${[body, ...parts].join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--`;
  }
  const output = encoder.encode(`${headers.join('\r\n')}\r\n${body}\r\n`);
  if (output.length > MAX_BYTES) throw new Error('Message exceeds MIME size limit');
  return output;
}
