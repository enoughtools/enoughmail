export interface EmailFilter {
  operator?: 'AND' | 'OR' | 'NOT'; conditions?: EmailFilter[];
  from?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string; body?: string;
  inMailbox?: string; notInMailbox?: string[]; before?: string; after?: string;
  hasKeyword?: string; notKeyword?: string; minSize?: number; maxSize?: number; hasAttachment?: boolean;
  attachmentName?: string; header?: [string, string?];
  isSnoozed?: boolean; isFollowUp?: boolean;
}
export interface EmailSort { property: string; isAscending?: boolean; keyword?: string }
export interface RuleEmail {
  id: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean>;
  from?: unknown; to?: unknown; cc?: unknown; bcc?: unknown; subject?: string; preview?: string;
  textBody?: unknown; htmlBody?: unknown; bodyValues?: unknown; body?: string; text?: string;
  receivedAt?: string; sentAt?: string | null; size?: number; hasAttachment?: boolean; snoozeUntil?: string | null;
  threadId?: string; attachments?: { name?: string | null }[]; headers?: { name: string; value: string }[];
  snooze?: { until: string; mailboxIds: Record<string, boolean> };
  followUp?: unknown;
  ruleForwards?: { ruleId: string; address: string }[];
  sortOrder?: number;
}
export interface MailRule {
  id: string; name: string; enabled: boolean; condition: EmailFilter;
  actions: { addMailboxIds?: string[]; removeMailboxIds?: string[]; keywords?: Record<string, boolean>; snoozeUntil?: string | null; forwardTo?: string[] };
  stop?: boolean; sortOrder?: number;
}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const dateValid = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const strings = new Set(['from', 'to', 'cc', 'bcc', 'subject', 'text', 'body', 'inMailbox', 'hasKeyword', 'notKeyword', 'attachmentName']);
const leafKeys = new Set([...strings, 'notInMailbox', 'before', 'after', 'minSize', 'maxSize', 'hasAttachment', 'header', 'isSnoozed', 'isFollowUp']);
export function validateFilter(input: unknown, depth = 0): EmailFilter {
  if (!plain(input) || depth > 20) throw new Error('Invalid or excessively nested mail filter.');
  if ('operator' in input) {
    if (!['AND', 'OR', 'NOT'].includes(String(input.operator)) || !Array.isArray(input.conditions) || !input.conditions.length || Object.keys(input).some(k => k !== 'operator' && k !== 'conditions')) throw new Error('Invalid filter operator or conditions.');
    input.conditions.forEach(condition => validateFilter(condition, depth + 1));
  } else {
    for (const [key, value] of Object.entries(input)) {
      if (!leafKeys.has(key)) throw new Error(`Unsupported filter: ${key}`);
      if (strings.has(key) && (typeof value !== 'string' || !value.trim())) throw new Error(`Invalid ${key} filter.`);
      if (key === 'notInMailbox' && (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v))) throw new Error('Invalid excluded mailboxes.');
      if ((key === 'before' || key === 'after') && !dateValid(value)) throw new Error('Filter date must be an ISO timestamp.');
      if ((key === 'minSize' || key === 'maxSize') && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('Filter size must be a nonnegative integer.');
      if (key === 'hasAttachment' && typeof value !== 'boolean') throw new Error('Invalid attachment filter.');
      if (key === 'isSnoozed' && typeof value !== 'boolean') throw new Error('Invalid snooze filter.');
      if (key === 'isFollowUp' && typeof value !== 'boolean') throw new Error('Invalid follow-up filter.');
      if (key === 'header' && (!Array.isArray(value) || value.length < 1 || value.length > 2 || typeof value[0] !== 'string' || !/^[!#$%&'*+.^_`|~\w-]+$/.test(value[0]) || (value.length === 2 && typeof value[1] !== 'string'))) throw new Error('Invalid header filter.');
    }
  }
  return input as EmailFilter;
}
export function validateRule(input: unknown): MailRule {
  if (!plain(input) || Object.keys(input).some(k => !['id', 'name', 'enabled', 'condition', 'actions', 'stop', 'sortOrder'].includes(k))) throw new Error('Unsupported rule fields.');
  if (typeof input.id !== 'string' || !input.id || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256 || typeof input.enabled !== 'boolean' || ('stop' in input && typeof input.stop !== 'boolean')) throw new Error('Invalid rule identity, name or enabled state.');
  if ('sortOrder' in input && (typeof input.sortOrder !== 'number' || !Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)) throw new Error('Invalid rule order.');
  validateFilter(input.condition);
  if (!plain(input.actions) || !Object.keys(input.actions).length) throw new Error('A rule needs actions.');
  for (const [key, value] of Object.entries(input.actions)) {
    if (!['addMailboxIds', 'removeMailboxIds', 'keywords', 'snoozeUntil', 'forwardTo'].includes(key)) throw new Error(`Unsupported rule action: ${key}`);
    if ((key === 'addMailboxIds' || key === 'removeMailboxIds') && (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v))) throw new Error('Invalid rule mailbox identifiers.');
    if (key === 'keywords' && (!plain(value) || Object.entries(value).some(([k, v]) => !k || typeof v !== 'boolean'))) throw new Error('Invalid rule keywords.');
    if (key === 'snoozeUntil' && value !== null && !dateValid(value)) throw new Error('Snooze requires an ISO timestamp or null.');
    if (key === 'forwardTo' && (!Array.isArray(value) || value.length < 1 || value.length > 5 || value.some(address => typeof address !== 'string' || address.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address)))) throw new Error('Rule forwarding requires one to five email addresses.');
  }
  return input as unknown as MailRule;
}
const content = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(content).join(' ');
  if (plain(value)) return Object.values(value).map(content).join(' ');
  return '';
};
const contains = (value: unknown, query: string) => content(value).toLocaleLowerCase().includes(query.toLocaleLowerCase());
const has = (map: Record<string, boolean>, key: string) => Object.hasOwn(map, key) && map[key] === true;
const setTrue = (map: Record<string, boolean>, key: string) => Object.defineProperty(map, key, { value: true, enumerable: true, writable: true, configurable: true });
export function matchesFilter(email: RuleEmail, filter: EmailFilter | null | undefined): boolean {
  if (!filter) return true;
  if (filter.operator) {
    const results = (filter.conditions ?? []).map(f => matchesFilter(email, f));
    return filter.operator === 'AND' ? results.every(Boolean) : filter.operator === 'OR' ? results.some(Boolean) : !results.some(Boolean);
  }
  const body = [email.body, email.text, email.textBody, email.htmlBody, email.bodyValues];
  for (const [key, value] of Object.entries(filter)) {
    if (['from', 'to', 'cc', 'bcc', 'subject'].includes(key) && !contains(email[key as keyof RuleEmail], value as string)) return false;
    if (key === 'body' && !contains(body, value as string)) return false;
    if (key === 'text' && !contains([email.from, email.to, email.cc, email.bcc, email.subject, email.preview, body], value as string)) return false;
    if (key === 'inMailbox' && !has(email.mailboxIds, value as string)) return false;
    if (key === 'notInMailbox' && (value as string[]).some(id => has(email.mailboxIds, id))) return false;
    if (key === 'hasKeyword' && !has(email.keywords, value as string)) return false;
    if (key === 'notKeyword' && has(email.keywords, value as string)) return false;
    if (key === 'hasAttachment' && Boolean(email.hasAttachment) !== value) return false;
    if (key === 'isSnoozed' && Boolean(email.snooze) !== value) return false;
    if (key === 'isFollowUp' && Boolean(email.followUp) !== value) return false;
    if (key === 'attachmentName' && !email.attachments?.some(part => contains(part.name, value as string))) return false;
    if (key === 'header') { const [name, needle] = value as [string, string?]; if (!email.headers?.some(header => header.name.toLowerCase() === name.toLowerCase() && (needle === undefined || contains(header.value, needle)))) return false; }
    if (key === 'minSize' && (email.size ?? 0) < (value as number)) return false;
    if (key === 'maxSize' && (email.size ?? 0) >= (value as number)) return false;
    if (key === 'before' && !(Date.parse(email.receivedAt ?? '') < Date.parse(value as string))) return false;
    if (key === 'after' && !(Date.parse(email.receivedAt ?? '') >= Date.parse(value as string))) return false;
  }
  return true;
}
export function sortEmails<T extends RuleEmail>(emails: readonly T[], sort: readonly EmailSort[] = [{ property: 'receivedAt', isAscending: false }], threadEmails: readonly T[] = emails): T[] {
  for (const comparator of sort) {
    if (!['receivedAt', 'sentAt', 'size', 'subject', 'from', 'to', 'cc', 'id', 'name', 'sortOrder', 'hasKeyword', 'someInThreadHaveKeyword', 'allInThreadHaveKeyword'].includes(comparator.property)) throw new Error(`Unsupported sort property: ${comparator.property}`);
    if (comparator.isAscending !== undefined && typeof comparator.isAscending !== 'boolean') throw new Error('Invalid sort direction.');
    if (['hasKeyword', 'someInThreadHaveKeyword', 'allInThreadHaveKeyword'].includes(comparator.property) && !comparator.keyword) throw new Error('Keyword sorting requires a keyword.');
  }
  const threads = new Map<string, T[]>();
  for (const email of threadEmails) { const key = email.threadId ?? email.id; const group = threads.get(key) ?? []; group.push(email); threads.set(key, group); }
  const threadKeyword = (email: T, comparator: EmailSort) => {
    const group = threads.get(email.threadId ?? email.id) ?? [email];
    return comparator.property === 'someInThreadHaveKeyword' ? group.some(member => has(member.keywords, comparator.keyword!)) : group.every(member => has(member.keywords, comparator.keyword!));
  };
  return [...emails].sort((a, b) => {
    for (const comparator of sort) {
      const value = (email: T): string | number => comparator.property === 'someInThreadHaveKeyword' || comparator.property === 'allInThreadHaveKeyword' ? Number(threadKeyword(email, comparator)) : comparator.property === 'hasKeyword' ? Number(has(email.keywords, comparator.keyword ?? '')) : comparator.property === 'size' ? email.size ?? 0 : comparator.property === 'sortOrder' ? email.sortOrder ?? 0 : comparator.property === 'receivedAt' || comparator.property === 'sentAt' ? Date.parse(email[comparator.property] ?? '') || 0 : content(email[comparator.property as keyof T]).toLocaleLowerCase();
      const av = value(a), bv = value(b), comparison = av < bv ? -1 : av > bv ? 1 : 0;
      if (comparison) return comparison * (comparator.isAscending === false ? -1 : 1);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
export interface RuleApplyOptions { allowForwarding?: boolean; verifiedForwardingAddresses?: readonly string[] }
export function applyRules<T extends RuleEmail>(email: T, rules: readonly MailRule[], options: RuleApplyOptions = {}): T {
  const result = { ...email, mailboxIds: { ...email.mailboxIds }, keywords: { ...email.keywords } };
  delete result.ruleForwards;
  const addresses = new Set<string>();
  const verifiedAddresses = new Set((options.verifiedForwardingAddresses ?? []).map(address => address.toLowerCase()));
  const initiallyBlocked = has(email.mailboxIds, 'folder-junk') || has(email.mailboxIds, 'folder-trash') || has(email.keywords, '$junk');
  for (const rule of rules) {
    validateRule(rule);
    if (!rule.enabled || !matchesFilter(result, rule.condition)) continue;
    for (const id of rule.actions.removeMailboxIds ?? []) delete result.mailboxIds[id];
    for (const id of rule.actions.addMailboxIds ?? []) setTrue(result.mailboxIds, id);
    for (const [keyword, enabled] of Object.entries(rule.actions.keywords ?? {})) { if (enabled) setTrue(result.keywords, keyword); else delete result.keywords[keyword]; }
    if ('snoozeUntil' in rule.actions) {
      if (rule.actions.snoozeUntil) {
        result.snooze = { until: rule.actions.snoozeUntil, mailboxIds: { ...(result.snooze?.mailboxIds ?? result.mailboxIds) } };
        delete result.snooze.mailboxIds['folder-snoozed'];
        delete result.mailboxIds['folder-inbox'];
        setTrue(result.mailboxIds, 'folder-snoozed');
      } else {
        if (result.snooze) result.mailboxIds = { ...result.mailboxIds, ...result.snooze.mailboxIds };
        delete result.snooze;
        delete result.mailboxIds['folder-snoozed'];
      }
    }
    if (options.allowForwarding === true && !initiallyBlocked && !has(result.mailboxIds, 'folder-junk') && !has(result.mailboxIds, 'folder-trash') && !has(result.keywords, '$junk')) {
      for (const address of rule.actions.forwardTo ?? []) {
        const key = address.toLowerCase();
        if (verifiedAddresses.has(key) && !addresses.has(key)) { addresses.add(key); (result.ruleForwards ??= []).push({ ruleId: rule.id, address }); }
      }
    }
    if (rule.stop) break;
  }
  if (has(result.mailboxIds, 'folder-junk') || has(result.mailboxIds, 'folder-trash') || has(result.keywords, '$junk')) delete result.ruleForwards;
  return result;
}
/** Persist privately; target IDs live in SQL child rows, never in this bounded checkpoint. */
export interface RuleApplySnapshot {
  version: 1; id: string; rules: MailRule[]; total: number;
  cursor: number; processed: number; updated: number; missing: number;
}
export interface RuleApplyBatch { snapshotId: string; cursor: number; ids: string[]; nextCursor: number; done: boolean }
export function createRuleApplySnapshot(id: string, rules: readonly MailRule[], total: number): RuleApplySnapshot {
  if (!id || !Number.isSafeInteger(total) || total < 0) throw new Error('Invalid rule application snapshot.');
  const frozenRules = structuredClone(rules.map(rule => validateRule(rule)));
  return { version: 1, id, rules: frozenRules, total, cursor: 0, processed: 0, updated: 0, missing: 0 };
}
export function nextRuleApplyBatch(snapshot: RuleApplySnapshot, page: { position: number; total: number; ids: readonly string[] }): RuleApplyBatch {
  if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0 || snapshot.cursor > snapshot.total || page.position !== snapshot.cursor || page.total !== snapshot.total || page.ids.length > 100 || page.ids.some(id => typeof id !== 'string' || !id) || new Set(page.ids).size !== page.ids.length || page.ids.length > snapshot.total - snapshot.cursor || (!page.ids.length && snapshot.cursor < snapshot.total)) throw new Error('Invalid rule application cursor or snapshot page.');
  const nextCursor = snapshot.cursor + page.ids.length;
  return { snapshotId: snapshot.id, cursor: snapshot.cursor, ids: [...page.ids], nextCursor, done: nextCursor === snapshot.total };
}
/** Call only in the same durable transaction as the child message writes and the request receipt. */
export function advanceRuleApplySnapshot(snapshot: RuleApplySnapshot, batch: RuleApplyBatch, result: { updated: number; missing: number }): RuleApplySnapshot {
  if (batch.snapshotId !== snapshot.id || batch.cursor !== snapshot.cursor) throw new Error('Rule application cursor changed.');
  const expected = nextRuleApplyBatch(snapshot, {position:batch.cursor,total:snapshot.total,ids:batch.ids});
  if (batch.nextCursor !== expected.nextCursor || batch.done !== expected.done || JSON.stringify(batch.ids) !== JSON.stringify(expected.ids)) throw new Error('Rule application batch does not match snapshot.');
  if (![result.updated, result.missing].every(value => Number.isSafeInteger(value) && value >= 0) || result.updated + result.missing > batch.ids.length) throw new Error('Invalid rule application outcome.');
  return { ...snapshot, cursor: batch.nextCursor, processed: snapshot.processed + batch.ids.length, updated: snapshot.updated + result.updated, missing: snapshot.missing + result.missing };
}
/** Supported Gmail-style terms; unknown operators fail rather than silently broadening a search. */
export function parseSearchQuery(query: string): EmailFilter {
  if (!query.trim()) return {};
  if ((query.match(/"/g)?.length ?? 0) % 2) throw new Error('Unclosed search quotation.');
  const tokens = query.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
  const groups: EmailFilter[][] = [[]];
  for (let token of tokens) {
    if (token === 'OR') { if (!groups.at(-1)!.length) throw new Error('OR requires a search term.'); groups.push([]); continue; }
    const negate = token.startsWith('-'); if (negate) token = token.slice(1);
    const colon = token.indexOf(':'), key = colon < 0 ? '' : token.slice(0, colon), value = (colon < 0 ? token : token.slice(colon + 1)).replace(/^"|"$/g, '');
    if (!value) throw new Error('Search terms cannot be empty.');
    let filter: EmailFilter;
    if (!key) filter = { text: value };
    else if (['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key)) filter = { [key]: value };
    else if (key === 'in' || key === 'label') filter = { inMailbox: value };
    else if (key === 'filename') filter = { attachmentName: value };
    else if (key === 'deliveredto') filter = { header: ['Delivered-To', value] };
    else if (key === 'has' && value === 'attachment') filter = { hasAttachment: true };
    else if (key === 'is' && ['read', 'unread', 'starred', 'flagged', 'draft'].includes(value)) filter = value === 'unread' ? { notKeyword: '$seen' } : { hasKeyword: value === 'read' ? '$seen' : value === 'draft' ? '$draft' : '$flagged' };
    else if (key === 'before' || key === 'after') { const timestamp = /^\d{4}[-/]\d\d[-/]\d\d$/.test(value) ? `${value.replaceAll('/', '-')}T00:00:00.000Z` : value; if (!dateValid(timestamp)) throw new Error('Invalid search date.'); filter = { [key]: timestamp }; }
    else if (['larger', 'smaller', 'size'].includes(key)) { const match = /^(\d+)([kKmM]?)$/.exec(value); if (!match) throw new Error('Invalid search size.'); const size = Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1024 * 1024 : match[2] ? 1024 : 1); filter = key === 'smaller' ? { maxSize: size } : { minSize: size }; }
    else throw new Error(`Unsupported search operator: ${key}:${value}`);
    groups.at(-1)!.push(negate ? { operator: 'NOT', conditions: [filter] } : filter);
  }
  if (!groups.at(-1)!.length && groups.length > 1) throw new Error('OR requires a search term.');
  const combined = groups.map(conditions => conditions.length === 1 ? conditions[0] : { operator: 'AND' as const, conditions });
  const result = combined.length === 1 ? combined[0] : { operator: 'OR' as const, conditions: combined };
  return validateFilter(result);
}
