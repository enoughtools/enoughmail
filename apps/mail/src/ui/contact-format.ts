export const MAX_CONTACT_BYTES = 5 * 1024 * 1024;
export const MAX_CONTACTS = 10000;
export interface PortableContact { name: string; email: string; company?: string; notes?: string; favorite?: boolean }
export interface StoredContact extends PortableContact { id: string }
export type DuplicateChoice = 'skip' | 'merge' | 'keep';
export function contactKey(contact: PortableContact) { return contact.email.toLocaleLowerCase('en-US'); }
function clean(value: unknown): PortableContact {
  if (!value || typeof value !== 'object') throw new Error('Invalid contact record.');
  const record = value as Record<string, unknown>;
  if (typeof record.email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(record.email.trim())) throw new Error('Each contact needs a valid email address.');
  if (record.name !== undefined && typeof record.name !== 'string') throw new Error('Contact names must be text.');
  const contact: PortableContact = { name: String(record.name || '').trim(), email: record.email.trim() };
  for (const field of ['company', 'notes'] as const) if (record[field] !== undefined) { if (typeof record[field] !== 'string') throw new Error('Contact details must be text.'); contact[field] = record[field]; }
  if (record.favorite !== undefined && record.favorite !== '') { if (![true, false, 'true', 'false'].includes(record.favorite as boolean | string)) throw new Error('Favorite must be true or false.'); contact.favorite = record.favorite === true || record.favorite === 'true'; }
  return contact;
}
function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += ch; }
    else if (ch === '"') { if (value || closed) throw new Error('Malformed CSV quoting.'); quoted = true; }
    else if (ch === ',' || ch === '\n' || ch === '\r') { row.push(value); value = ''; closed = false; if (ch !== ',') { if (ch === '\r' && text[i + 1] === '\n') i++; if (row.some(cell => cell !== '')) rows.push(row); row = []; if (rows.length > MAX_CONTACTS + 1) throw new Error('Import supports up to 10,000 contacts.'); } }
    else { if (closed) throw new Error('Malformed CSV quoting.'); value += ch; }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  row.push(value); if (row.some(cell => cell !== '')) rows.push(row); return rows;
}
function unescapeCard(value: string) { return value.replace(/\\([nN,;\\])/g, (_, ch: string) => ch.toLowerCase() === 'n' ? '\n' : ch); }
export function parseContacts(text: string, format: 'csv' | 'vcf' | 'json'): PortableContact[] {
  if (new TextEncoder().encode(text).length > MAX_CONTACT_BYTES) throw new Error('Choose a contacts file up to 5 MB.');
  text = text.replace(/^\uFEFF/, ''); let values: unknown[];
  if (format === 'json') { const data = JSON.parse(text); if (!Array.isArray(data)) throw new Error('JSON must contain a contacts array.'); values = data; }
  else if (format === 'csv') {
    const [headers, ...rows] = csvRows(text); if (!headers) throw new Error('The contacts file is empty.');
    const keys = headers.map(key => key.trim().toLowerCase()); if (!keys.includes('email') || new Set(keys).size !== keys.length) throw new Error('CSV needs unique column names including email.');
    values = rows.map(row => { if (row.length !== keys.length) throw new Error('CSV row has the wrong number of columns.'); return Object.fromEntries(keys.map((key, i) => [key, row[i]])); });
  } else {
    values = []; let card: Record<string, unknown> | null = null; let emails: string[] = [];
    for (const line of text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split(/\n|\r/)) {
      if (!line) continue; const colon = line.indexOf(':'); if (colon < 0) throw new Error('Malformed vCard property.');
      const property = line.slice(0, colon).split(';')[0].split('.').at(-1)!.toUpperCase(), value = unescapeCard(line.slice(colon + 1));
      if (property === 'BEGIN' && value.toUpperCase() === 'VCARD') { if (card) throw new Error('Nested vCards are invalid.'); card = {}; emails = []; }
      else if (property === 'END' && value.toUpperCase() === 'VCARD') { if (!card) throw new Error('Unexpected vCard end.'); if (!emails.length) throw new Error('Each vCard needs an email address.'); for (const email of emails) values.push({ ...card, email }); card = null; if (values.length > MAX_CONTACTS) throw new Error('Import supports up to 10,000 contacts.'); }
      else { if (!card) throw new Error('Expected a vCard.'); if (/;ENCODING=|;CHARSET=/i.test(line.slice(0, colon))) throw new Error('Use UTF-8 vCard files without legacy encoding.'); if (property === 'EMAIL') emails.push(value.replace(/^mailto:/i, '')); if (property === 'FN') card.name = value; if (property === 'ORG') card.company = value; if (property === 'NOTE') card.notes = value; if (property === 'X-ENOUGH-FAVORITE') card.favorite = value; }
    }
    if (card) throw new Error('Unclosed vCard.');
  }
  if (!values.length) throw new Error('The file contains no contacts.'); if (values.length > MAX_CONTACTS) throw new Error('Import supports up to 10,000 contacts.'); return values.map(clean);
}
export function exportContacts(contacts: PortableContact[], format: 'csv' | 'vcf') {
  if (format === 'csv') { const fields = ['name', 'email', 'company', 'notes', 'favorite'] as const; const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`; return [fields.join(','), ...contacts.map(contact => fields.map(field => quote(contact[field])).join(','))].join('\r\n') + '\r\n'; }
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  return contacts.map(contact => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escape(contact.name)}`, `EMAIL:${escape(contact.email)}`, ...(contact.company !== undefined ? [`ORG:${escape(contact.company)}`] : []), ...(contact.notes !== undefined ? [`NOTE:${escape(contact.notes)}`] : []), ...(contact.favorite !== undefined ? [`X-ENOUGH-FAVORITE:${contact.favorite}`] : []), 'END:VCARD'].join('\r\n')).join('\r\n') + '\r\n';
}
export function contactDuplicates(incoming: PortableContact[], existing: StoredContact[]) {
  const seen = new Map(existing.map(contact => [contactKey(contact), contact.name || contact.email]));
  return incoming.map(contact => { const key = contactKey(contact), duplicate = seen.get(key); seen.set(key, contact.name || contact.email); return duplicate; });
}
export function contactImportPlan(incoming: PortableContact[], existing: StoredContact[], choices: Record<number, DuplicateChoice>) {
  const targets = new Map<string, { id?: string; key?: string }>(); for (const contact of existing) if (!targets.has(contactKey(contact))) targets.set(contactKey(contact), { id: contact.id });
  const create: Record<string, PortableContact> = {}, update: Record<string, Partial<PortableContact>> = {};
  incoming.forEach((contact, index) => { const key = contactKey(contact), target = targets.get(key), choice = choices[index]; if (choice === 'skip') return;
    if (target && !choice) throw new Error('Choose how to handle every duplicate.');
    if (choice === 'merge') { if (!target) throw new Error('Merge needs a retained matching contact. Choose keep or skip.'); const patch = Object.fromEntries(Object.entries(contact).filter(([, value]) => value !== '')); if (target.id) update[target.id] = { ...update[target.id], ...patch }; else create[target.key!] = { ...create[target.key!], ...patch }; }
    else { const creationKey = `contact-${index}`; create[creationKey] = contact; if (!target) targets.set(key, { key: creationKey }); }
  }); return { create, update };
}
