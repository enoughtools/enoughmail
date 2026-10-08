import type { Email, Mailbox } from './jmap';

type Filter = Record<string, unknown>;
type Token = { value: string; literal: boolean; colon?: number };
const combine = (operator: 'AND' | 'OR', conditions: Filter[]): Filter => conditions.length === 1 ? conditions[0] : { operator, conditions };

/** Gmail-style search is translated into structured filters; no expression is evaluated. */
export function parseMailSearch(query: string, mailboxes: Mailbox[],missingMailboxAsEmpty=false): Filter {
  if (!query.trim()) return {};
  if (query.length > 8192) throw new Error('Search is too long. Use fewer terms.');
  const tokens: Token[] = [];
  for (let i = 0; i < query.length;) {
    if (/\s/.test(query[i])) { i++; continue; }
    if ('()-'.includes(query[i])) { tokens.push({ value: query[i++], literal: false }); continue; }
    let value = '', quoted = false, colon = -1;
    while (i < query.length && !/\s/.test(query[i]) && !'()'.includes(query[i])) {
      if (query[i] === '"') {
        quoted = true; i++;
        let closed = false;
        while (i < query.length) {
          if (query[i] === '"') { i++; closed = true; break; }
          if (query[i] === '\\' && (query[i + 1] === '"' || query[i + 1] === '\\')) i++;
          value += query[i++];
        }
        if (!closed) throw new Error('Close the quotation mark in your search.');
      } else { if (query[i] === ':' && colon < 0) colon = value.length; value += query[i++]; }
    }
    if (!value) throw new Error('Search terms cannot be empty.');
    tokens.push({ value, literal: quoted, colon });
  }
  let position = 0;
  const is = (value: string) => tokens[position]?.value === value && !tokens[position]?.literal;
  const date = (value: string): string => {
    if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value)) throw new Error('Use YYYY-MM-DD for search dates.');
    const [year, month, day] = value.split(/[-/]/).map(Number);
    const normalized = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const result = new Date(`${normalized}T00:00:00.000Z`);
    if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== normalized) throw new Error(`Invalid search date: ${value}.`);
    return result.toISOString();
  };
  const leaf = (token: Token): Filter => {
    const colon = token.colon ?? -1;
    if (colon < 0) return { text: token.value };
    const key = token.value.slice(0, colon).toLowerCase(), value = token.value.slice(colon + 1);
    if (!value) throw new Error(`Add a value after ${key}:`);
    if (['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key)) return { [key]: value };
    if (key === 'label' || key === 'in') {
      if (key === 'in' && ['anywhere', 'all'].includes(value.toLowerCase())) return {};
      const role = ({ spam: 'junk', starred: '$flagged', important: '$important', sent: 'sent', drafts: 'drafts' } as Record<string, string>)[value.toLowerCase()] || value.toLowerCase();
      if (key === 'in' && role.startsWith('$')) return { hasKeyword: role };
      const exact = mailboxes.find(m => m.id === value);
      const matches = exact ? [exact] : mailboxes.filter(m => m.name.toLowerCase() === value.toLowerCase() || (key === 'in' && m.role === role));
      if(!matches.length&&missingMailboxAsEmpty)return {inMailbox:'__missing_mailbox__'};
      if (!matches.length) throw new Error(`Mailbox or label “${value}” was not found.`);
      if (matches.length > 1) throw new Error(`Mailbox name “${value}” is ambiguous. Use its mailbox ID.`);
      return { inMailbox: matches[0].id };
    }
    if (key === 'is') {
      const keyword = ({ read: '$seen', unread: '$seen', starred: '$flagged', flagged: '$flagged', important: '$important', draft: '$draft' } as Record<string, string>)[value.toLowerCase()];
      if (keyword) return { [value.toLowerCase() === 'unread' ? 'notKeyword' : 'hasKeyword']: keyword };
    }
    if (key === 'has' && value.toLowerCase() === 'attachment') return { hasAttachment: true };
    if (['before', 'after', 'older', 'newer'].includes(key)) return { [key === 'older' ? 'before' : key === 'newer' ? 'after' : key]: date(value) };
    if (['larger', 'smaller', 'size'].includes(key)) {
      const match = /^(\d+)([kmg]?)$/i.exec(value);
      if (!match) throw new Error('Use a whole number of bytes, or K, M or G for search size.');
      const amount = Number(match[1]) * 1024 ** ({ k: 1, m: 2, g: 3 }[match[2].toLowerCase()] || 0);
      if (!Number.isSafeInteger(amount) || (key === 'larger' && !Number.isSafeInteger(amount + 1))) throw new Error('Search size is too large.');
      return { [key === 'smaller' ? 'maxSize' : 'minSize']: key === 'larger' ? amount + 1 : amount };
    }
    if (key === 'filename') return { attachmentName: value };
    if (key === 'deliveredto') return { header: ['Delivered-To', value] };
    throw new Error(`Unsupported search operator “${key}:${value}”. Use from, to, cc, subject, label, in, before, after, older, newer, is, has, filename, deliveredto, larger or smaller.`);
  };
  const atom = (depth: number): Filter => {
    if (depth > 20) throw new Error('Search groups are nested too deeply.');
    if (is('-') || is('NOT')) { position++; return { operator: 'NOT', conditions: [atom(depth + 1)] }; }
    if (is('(')) {
      position++;
      const filter = or(depth + 1);
      if (!is(')')) throw new Error('Close the parenthesis in your search.');
      position++; return filter;
    }
    if (!tokens[position] || is(')') || is('AND') || is('OR')) throw new Error('Add a search term after the operator.');
    return leaf(tokens[position++]);
  };
  const and = (depth: number): Filter => {
    const conditions = [atom(depth)];
    while (position < tokens.length && !is('OR') && !is(')')) {
      if (is('AND')) position++;
      conditions.push(atom(depth));
    }
    return combine('AND', conditions);
  };
  const or = (depth: number): Filter => {
    const conditions = [and(depth)];
    while (is('OR')) { position++; conditions.push(and(depth)); }
    return combine('OR', conditions);
  };
  const result = or(0);
  if (position !== tokens.length) throw new Error('Unexpected closing parenthesis in search.');
  return result;
}

/** Sorting leaves the input untouched and stabilizes unified inbox ties across accounts. */
export function sortMailRows<T extends Email & { accountId: string }>(rows: T[], sort: string, ascending: boolean): T[] {
  if (!['receivedAt', 'sentAt', 'subject', 'from', 'to', 'cc', 'size', 'unread', 'starred', 'important'].includes(sort)) throw new Error(`Unsupported mail sort: ${sort}.`);
  const value = (email: T): string | number => {
    if (sort === 'unread') return Number(!email.keywords.$seen);
    if (sort === 'starred' || sort === 'important') return Number(!!email.keywords[sort === 'starred' ? '$flagged' : '$important']);
    if (sort === 'receivedAt' || sort === 'sentAt') return Date.parse(String((email as unknown as Record<string, unknown>)[sort] || '')) || 0;
    if (sort === 'size') return Number((email as unknown as Record<string, unknown>).size) || 0;
    if (['from', 'to', 'cc'].includes(sort)) return ((email as unknown as Record<string, {name?: string; email: string}[]>)[sort] || []).map(a => a.name || a.email).join(', ').toLowerCase();
    return email.subject.toLowerCase();
  };
  const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
  return [...rows].sort((a, b) => compare(value(a), value(b)) * (ascending ? 1 : -1) || compare(a.accountId, b.accountId) || compare(a.id, b.id));
}
