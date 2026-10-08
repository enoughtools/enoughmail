import { parseAddresses, parseMime } from './mime';

interface Header { name: string; value: string }
interface BodyValue { value: string; isEncodingProblem?: boolean; isTruncated?: boolean }
const nullableProperties = ['sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'messageId', 'inReplyTo', 'references'];
const defaultProperties = ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'messageId', 'inReplyTo', 'references', 'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'hasAttachment', 'preview', 'bodyValues', 'textBody', 'htmlBody', 'attachments', 'draftRecipients', 'draftFrom', 'deliveryRecipient'];
const definedHeaders = new Set('date from sender reply-to to cc bcc message-id in-reply-to references subject comments keywords resent-date resent-from resent-sender resent-to resent-cc resent-bcc resent-message-id return-path received list-help list-unsubscribe list-subscribe list-post list-owner list-archive'.split(' '));
const addressHeaders = new Set('from sender reply-to to cc bcc resent-from resent-sender resent-reply-to resent-to resent-cc resent-bcc'.split(' '));
function textHeader(raw: string): string { return parseMime(new TextEncoder().encode(`Subject: ${raw}\r\n\r\n`), 'projection').subject.replace(/[\x00-\x1f\x7f]/g, '').normalize('NFC'); }
function groupedAddresses(raw: string): { name: string | null; addresses: ReturnType<typeof parseAddresses> }[] {
  const result: { name: string | null; addresses: ReturnType<typeof parseAddresses> }[] = [];
  let buffer = '', group: string | null = null, quoted = false, escaped = false, angle = 0, comment = 0;
  const flush = () => { const addresses = parseAddresses(buffer.replace(/^\s*,/, '')); if (addresses.length || group !== null) result.push({ name: group === null ? null : textHeader(group.replace(/^"|"$/g, '')), addresses }); buffer = ''; };
  for (const character of raw) {
    if (escaped) { buffer += character; escaped = false; continue; }
    if (character === '\\') { buffer += character; escaped = true; continue; }
    if (character === '"' && !comment) quoted = !quoted;
    if (!quoted) { if (character === '<') angle++; if (character === '>') angle = Math.max(0, angle - 1); if (character === '(') comment++; if (character === ')') comment = Math.max(0, comment - 1); }
    if (!quoted && !angle && !comment && character === ':' && group === null) { const comma = buffer.lastIndexOf(','); if (comma >= 0) { const name = buffer.slice(comma + 1).trim(); buffer = buffer.slice(0, comma); flush(); group = name; } else { group = buffer.trim(); buffer = ''; } continue; }
    if (!quoted && !angle && !comment && character === ';' && group !== null) { flush(); group = null; continue; }
    buffer += character;
  }
  if (buffer.trim() || group !== null) flush();
  return result;
}
function truncateUtf8(value: string, maximum: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximum) return { value, truncated: false };
  let end = Math.max(0, maximum);
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)), truncated: true }; }
    catch { end = Math.max(0, end - 1); }
  }
  return { value: '', truncated: true };
}
function headerValue(headers: Header[], property: string): unknown {
  const match = /^header:([^:]+)(?::(asRaw|asText|asAddresses|asGroupedAddresses|asMessageIds|asDate|asURLs))?(?::(all))?$/.exec(property);
  if (!match) throw new Error('Invalid header property');
  const [, name, format = 'asRaw', all] = match;
  const normalized = name.toLowerCase();
  if (!/^[!-9;-~]+$/.test(name)) throw new Error('Invalid header name');
  if (definedHeaders.has(normalized)) {
    const permitted = format === 'asRaw' || (format === 'asText' && ['subject', 'comments', 'keywords', 'list-id'].includes(normalized))
      || (['asAddresses', 'asGroupedAddresses'].includes(format) && addressHeaders.has(normalized))
      || (format === 'asDate' && ['date', 'resent-date'].includes(normalized))
      || (format === 'asMessageIds' && ['message-id', 'in-reply-to', 'references', 'resent-message-id'].includes(normalized))
      || (format === 'asURLs' && normalized.startsWith('list-'));
    if (!permitted) throw new Error('Forbidden header parsed form');
  }
  const values = headers.filter(header => header.name.toLowerCase() === name.toLowerCase()).map(header => header.value);
  const transform = (raw: string): unknown => {
    if (format === 'asAddresses') return parseAddresses(raw);
    if (format === 'asGroupedAddresses') return groupedAddresses(raw);
    if (format === 'asMessageIds') return [...raw.matchAll(/<([^<>\s]+)>/g)].map(value => value[1]);
    if (format === 'asDate') { const date = new Date(raw); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
    if (format === 'asURLs') return [...raw.matchAll(/<([^<>\s]+)>/g)].map(value => value[1]);
    if (format === 'asText') return textHeader(raw);
    return raw;
  };
  return all ? values.map(transform) : values.length ? transform(values[values.length - 1]) : null;
}

export function validateEmailProjectionArgs(args: Record<string, any>): void {
  if (args.properties !== undefined && args.properties !== null && (!Array.isArray(args.properties) || args.properties.some((property: unknown) => typeof property !== 'string'))) throw new Error('Invalid Email properties');
  if (args.bodyProperties !== undefined && args.bodyProperties !== null && (!Array.isArray(args.bodyProperties) || args.bodyProperties.some((property: unknown) => typeof property !== 'string'))) throw new Error('Invalid bodyProperties');
  if (args.maxBodyValueBytes !== undefined && (!Number.isInteger(args.maxBodyValueBytes) || args.maxBodyValueBytes < 0)) throw new Error('Invalid maxBodyValueBytes');
  for (const property of args.properties ?? []) if (property.startsWith('header:')) headerValue([], property);
  const bodyAllowed = new Set(['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location', 'headers', 'subParts']);
  for (const property of args.bodyProperties ?? []) {
    if (property.startsWith('header:')) headerValue([], property);
    else if (!bodyAllowed.has(property)) throw new Error('Unknown EmailBodyPart property');
  }
}

/** Project a canonical Email after MIME parsing; never mutates the persisted record. */
export function projectEmail(email: Record<string, any>, args: Record<string, any>, fetchedBodyValues?: Record<string, BodyValue>, includeId = true): Record<string, any> {
  validateEmailProjectionArgs(args);
  const source: Record<string, any> = { ...email };
  for (const property of nullableProperties) if (!(property in source)) source[property] = null;
  source.attachments ??= []; source.textBody ??= []; source.htmlBody ??= []; source.headers ??= [];
  for (const property of ['sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'messageId', 'inReplyTo', 'references']) {
    const headerName = ({ replyTo: 'reply-to', messageId: 'message-id', inReplyTo: 'in-reply-to' } as Record<string, string>)[property] ?? property;
    if (Array.isArray(source[property]) && !source[property].length && !source.headers.some((header: Header) => header.name.toLowerCase() === headerName.toLowerCase())) source[property] = null;
  }
  source.hasAttachment ??= source.attachments.length > 0; source.preview ??= '';
  if (!source.sender) {
    const header = source.headers.find((value: Header) => value.name.toLowerCase() === 'sender');
    if (header) source.sender = parseAddresses(header.value);
  }
  const selected = new Set<string>();
  if (args.fetchAllBodyValues) for (const id of Object.keys(fetchedBodyValues ?? source.bodyValues ?? {})) selected.add(id);
  if (args.fetchTextBodyValues) for (const part of source.textBody) if (part.partId) selected.add(part.partId);
  if (args.fetchHTMLBodyValues) for (const part of source.htmlBody) if (part.partId) selected.add(part.partId);
  source.bodyValues = {};
  for (const id of selected) {
    const body = (fetchedBodyValues ?? email.bodyValues ?? {})[id];
    if (!body) continue;
    const clipped = args.maxBodyValueBytes ? truncateUtf8(body.value, args.maxBodyValueBytes) : { value: body.value, truncated: false };
    source.bodyValues[id] = { value: clipped.value, isEncodingProblem: !!body.isEncodingProblem, isTruncated: !!body.isTruncated || clipped.truncated };
  }
  const projectPart = (part: Record<string, any>): Record<string, any> => {
    const properties = args.bodyProperties ?? ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location'];
    const allowed = new Set(['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location', 'headers', 'subParts']);
    if (properties.some((property: string) => !allowed.has(property) && !property.startsWith('header:'))) throw new Error('Unknown EmailBodyPart property');
    const projected = Object.fromEntries(properties.map((property: string) => [property, property.startsWith('header:') ? headerValue(part.headers ?? [], property) : part[property] ?? (property === 'headers' ? [] : null)]));
    if (part.subParts) projected.subParts = part.subParts.map(projectPart);
    return projected;
  };
  source.textBody = source.textBody.map(projectPart); source.htmlBody = source.htmlBody.map(projectPart); source.attachments = source.attachments.map(projectPart);
  if (source.bodyStructure) source.bodyStructure = projectPart(source.bodyStructure);
  const output: Record<string, any> = includeId ? { id: source.id } : {};
  for (const property of args.properties ?? defaultProperties) {
    if (property.startsWith('header:')) output[property] = headerValue(source.headers, property);
    else if (property in source) output[property] = source[property];
    else if (['snooze', 'followUp', 'quarantine', 'draftRecipients', 'draftFrom', 'deliveryRecipient'].includes(property)) continue;
    else throw new Error(`Unknown Email property: ${property}`);
  }
  return output;
}
