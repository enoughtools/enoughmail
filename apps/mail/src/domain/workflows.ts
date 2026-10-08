import { matchesFilter, parseSearchQuery, validateFilter, type EmailFilter, type RuleEmail } from './rules';

export interface MailSettings {
  pageSize?: number; confirmDelete?: boolean; showPreview?: boolean;
  blockedSenders?: string[]; mutedThreads?: string[];
  categories?: { id: string; name: string; mailboxId: string; enabled: boolean; condition: EmailFilter }[];
  savedSearches?: { id?: string; name: string; query: string }[];
  forwarding?: { enabled: boolean; address: string; keepCopy: boolean };
  vacation?: { enabled: boolean; subject: string; textBody: string; fromDate?: string | null; toDate?: string | null; responseIntervalDays?: number };
  followUp?: { defaultIfNoReply: boolean; defaultDelayHours: number };
}
export interface WorkflowEmail extends RuleEmail { followUp?: { until: string; ifNoReply: boolean; createdAt: string }; }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const address = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256 && !['__proto__', 'prototype', 'constructor'].includes(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length <= max;
function fields(value: unknown, allowed: string[]) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported settings fields.'); return value; }
export function validateSettings(input: unknown): MailSettings {
  const settings = fields(input, ['pageSize', 'confirmDelete', 'showPreview', 'blockedSenders', 'mutedThreads', 'categories', 'savedSearches', 'forwarding', 'vacation', 'followUp']);
  if ('pageSize' in settings && ![25, 50, 100].includes(settings.pageSize)) throw new Error('Invalid messages per page.');
  for (const key of ['confirmDelete', 'showPreview']) if (key in settings && typeof settings[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
  for (const key of ['blockedSenders', 'mutedThreads']) if (key in settings && (!Array.isArray(settings[key]) || settings[key].length > 10000 || settings[key].some((v: unknown) => key === 'blockedSenders' ? !address(v) : !safeId(v)))) throw new Error(`Invalid ${key}.`);
  if ('savedSearches' in settings) {
    if (!Array.isArray(settings.savedSearches) || settings.savedSearches.length > 100) throw new Error('Invalid saved searches.');
    for (const entry of settings.savedSearches) { const value = fields(entry, ['id', 'name', 'query']); if (('id' in value && !safeId(value.id)) || !text(value.name) || !value.name.trim() || !text(value.query, 4096) || !value.query.trim()) throw new Error('Invalid saved search.'); parseSearchQuery(value.query); }
  }
  if ('categories' in settings) {
    if (!Array.isArray(settings.categories) || settings.categories.length > 100) throw new Error('Invalid categories.');
    const ids = new Set<string>();
    for (const entry of settings.categories) { const value = fields(entry, ['id', 'name', 'mailboxId', 'enabled', 'condition']); if (!safeId(value.id) || ids.has(value.id) || !safeId(value.mailboxId) || value.mailboxId.startsWith('folder-') || !text(value.name) || !value.name.trim() || typeof value.enabled !== 'boolean') throw new Error('Invalid category.'); ids.add(value.id); validateFilter(value.condition); }
  }
  if ('forwarding' in settings) { const value = fields(settings.forwarding, ['enabled', 'address', 'keepCopy']); if (typeof value.enabled !== 'boolean' || typeof value.keepCopy !== 'boolean' || !(address(value.address) || value.enabled === false && value.address === '')) throw new Error('Invalid forwarding preferences.'); }
  if ('vacation' in settings) {
    const value = fields(settings.vacation, ['enabled', 'subject', 'textBody', 'fromDate', 'toDate', 'responseIntervalDays']);
    if (typeof value.enabled !== 'boolean' || !text(value.subject, 998) || /[\r\n]/.test(value.subject) || !text(value.textBody, 100000) || (value.enabled && !value.textBody.trim())) throw new Error('Invalid vacation reply.');
    for (const key of ['fromDate', 'toDate']) if (value[key] != null && !timestamp(value[key])) throw new Error('Invalid vacation dates.');
    if (value.fromDate && value.toDate && Date.parse(value.fromDate) >= Date.parse(value.toDate)) throw new Error('Vacation end must follow its start.');
    if ('responseIntervalDays' in value && (!Number.isInteger(value.responseIntervalDays) || value.responseIntervalDays < 1 || value.responseIntervalDays > 365)) throw new Error('Invalid vacation reply interval.');
  }
  if ('followUp' in settings) { const value = fields(settings.followUp, ['defaultIfNoReply', 'defaultDelayHours']); if (typeof value.defaultIfNoReply !== 'boolean' || !Number.isInteger(value.defaultDelayHours) || value.defaultDelayHours < 1 || value.defaultDelayHours > 8760) throw new Error('Invalid follow-up preferences.'); }
  return JSON.parse(JSON.stringify(settings));
}
function senders(email: RuleEmail): string[] { return Array.isArray(email.from) ? email.from.flatMap(entry => object(entry) && address(entry.email) ? [entry.email.toLowerCase()] : []) : []; }
function excluded(email: RuleEmail) { return email.mailboxIds['folder-trash'] === true || email.mailboxIds['folder-junk'] === true; }
export function applyMailPreferences<T extends RuleEmail>(email: T, settings: MailSettings): T {
  const next = { ...email, mailboxIds: { ...email.mailboxIds }, keywords: { ...email.keywords } };
  if (senders(email).some(sender => settings.blockedSenders?.some(blocked => blocked.toLowerCase() === sender))) { delete next.mailboxIds['folder-inbox']; next.mailboxIds['folder-junk'] = true; return next; }
  if (email.threadId && settings.mutedThreads?.includes(email.threadId)) { delete next.mailboxIds['folder-inbox']; next.mailboxIds['folder-archive'] = true; }
  if (!excluded(next)) for (const category of settings.categories ?? []) if (category.enabled && matchesFilter(next, category.condition)) Object.defineProperty(next.mailboxIds, category.mailboxId, { value: true, enumerable: true, configurable: true, writable: true });
  return next;
}
export function applyFollowUp<T extends WorkflowEmail>(email: T, options: { until: string; ifNoReply: boolean; now?: string }): T {
  const createdAt = options.now ?? email.sentAt ?? email.receivedAt;
  if (!timestamp(options.until) || !timestamp(createdAt) || typeof options.ifNoReply !== 'boolean' || Date.parse(options.until) <= Date.parse(createdAt)) throw new Error('Follow-up requires a future timestamp and a valid creation timestamp.');
  return { ...email, followUp: { until: options.until, ifNoReply: options.ifNoReply, createdAt } };
}
function replied(email: WorkflowEmail, emails: readonly WorkflowEmail[]) {
  return !!email.threadId && emails.some(candidate => candidate.id !== email.id && candidate.threadId === email.threadId && !candidate.keywords['$draft'] && !candidate.mailboxIds['folder-sent'] && !!candidate.receivedAt && Date.parse(candidate.receivedAt) > Date.parse(email.followUp!.createdAt));
}
export function dueFollowUps<T extends WorkflowEmail>(emails: readonly T[], now: string): T[] {
  if (!timestamp(now)) throw new Error('Invalid follow-up clock.');
  return emails.filter(email => email.followUp && Date.parse(email.followUp.until) <= Date.parse(now) && !excluded(email) && !email.keywords['$draft'] && !email.snooze && !email.snoozeUntil && (!email.followUp.ifNoReply || !replied(email, emails)));
}
export function reconcileFollowUps<T extends WorkflowEmail>(emails: readonly T[], now: string): T[] {
  const due = new Set(dueFollowUps(emails, now).map(email => email.id));
  return emails.map(email => {
    if (!email.followUp) return email;
    const hasReply = email.followUp.ifNoReply && replied(email, emails);
    if (!hasReply && !due.has(email.id)) return email;
    const next = { ...email, mailboxIds: { ...email.mailboxIds } }; delete next.followUp;
    if (due.has(email.id) && !hasReply) next.mailboxIds['folder-inbox'] = true;
    return next;
  });
}
export interface AutoResponseJob { id: string; type: 'forward' | 'vacation'; sourceEmailId: string; to: string; subject: string; textBody?: string; headers: { name: string; value: string }[]; }
/** Only describes outbox work. The backend must verify sender/recipient authority and persist cooldown receipts before sending. */
export function buildAutoResponses(email: RuleEmail, settings: MailSettings, options: { now: string; recipientAddress?: string; lastVacationResponses?: Record<string, string> }): AutoResponseJob[] {
  if (!timestamp(options.now)) throw new Error('Invalid automatic response clock.');
  if (excluded(email) || email.mailboxIds['folder-sent'] || email.mailboxIds['folder-drafts'] || email.keywords['$draft']) return [];
  const header = (name: string) => email.headers?.filter(entry => entry.name.toLowerCase() === name).map(entry => entry.value.trim()).join(',') ?? '';
  const autoSubmitted = header('auto-submitted');
  if ((autoSubmitted && autoSubmitted.toLowerCase() !== 'no') || header('list-id') || header('list-unsubscribe') || /^(bulk|junk|list)$/i.test(header('precedence')) || header('x-enough-mail-forwarded') || header('x-auto-response-suppress') || header('return-path') === '<>') return [];
  const sender = senders(email)[0]; if (!sender || sender === options.recipientAddress?.toLowerCase() || settings.blockedSenders?.some(value => value.toLowerCase() === sender)) return [];
  const jobs: AutoResponseJob[] = [];
  if (settings.forwarding?.enabled && settings.forwarding.address.toLowerCase() !== sender && settings.forwarding.address.toLowerCase() !== options.recipientAddress?.toLowerCase()) jobs.push({ id: `forward:${email.id}`, type: 'forward', sourceEmailId: email.id, to: settings.forwarding.address, subject: email.subject ?? '', headers: [{ name: 'X-Enough-Mail-Forwarded', value: 'yes' }, { name: 'Auto-Submitted', value: 'auto-generated' }] });
  const vacation = settings.vacation;
  const now = Date.parse(options.now), interval = (vacation?.responseIntervalDays ?? 4) * 86400000;
  const previous = options.lastVacationResponses?.[sender];
  if (vacation?.enabled && (!vacation.fromDate || now >= Date.parse(vacation.fromDate)) && (!vacation.toDate || now < Date.parse(vacation.toDate)) && (!previous || now - Date.parse(previous) >= interval)) jobs.push({ id: `vacation:${email.id}`, type: 'vacation', sourceEmailId: email.id, to: sender, subject: vacation.subject || `Re: ${email.subject ?? ''}`, textBody: vacation.textBody, headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] });
  return jobs;
}
