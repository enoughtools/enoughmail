/** Mail-owned DNS onboarding. Credentials are server secrets scoped to the configured zone. */
export interface DnsRecord { id?: string; type: string; name: string; content: string; priority?: number; ttl?: number; proxied?: boolean }
export interface DnsRecordEvidence { content: string; rawLength: number; canonicalLength: number; quoteCount: number; backslashCount: number }
export interface DomainDnsConflictDetail { type: string; name: string; required: DnsRecordEvidence; existing: (DnsRecordEvidence & { firstDifference: number })[] }
export interface DomainDnsPlan {
  domain: string; snapshot: string; requirements: DnsRecord[];
  changes: { kind: 'create' | 'update'; record: DnsRecord; previous?: DnsRecord }[];
  conflicts: string[]; warnings: string[]; conflictDetails?: DomainDnsConflictDetail[];
}
export interface DomainEnvironment { CF_API_TOKEN?: string }
const nameOf = (value: string) => value.toLowerCase().replace(/\.$/, '');
/** Cloudflare can return DNS TXT presentation strings split into quoted
 * 255-octet chunks. Those chunks concatenate without a separator on the wire.
 * Decode only a complete quoted presentation, preserving unquoted TXT verbatim. */
const txt = (value: string): string => {
  if (!/^(?:"(?:[^"\\]|\\.)*"\s*)+$/.test(value)) return value;
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(part => part[1].replace(/\\([0-9]{3}|.)/g, (_match, escaped: string) => /^\d{3}$/.test(escaped) && Number(escaped) <= 255 ? String.fromCharCode(Number(escaped)) : escaped)).join('');
};
const evidence = (value: string): DnsRecordEvidence => ({ content: value.slice(0, 8192), rawLength: value.length, canonicalLength: txt(value).length, quoteCount: [...value].filter(character => character === '"').length, backslashCount: [...value].filter(character => character === '\\').length });
const firstDifference = (left: string, right: string): number => { const length = Math.min(left.length, right.length); for (let i = 0; i < length; i++) if (left[i] !== right[i]) return i; return left.length === right.length ? -1 : length; };
const equal = (a: DnsRecord, b: DnsRecord) => a.type === b.type && nameOf(a.name) === nameOf(b.name) &&
  (a.type === 'TXT' ? txt(a.content) === txt(b.content) : nameOf(a.content) === nameOf(b.content)) &&
  (a.type !== 'MX' || a.priority === b.priority);
const snapshotOf = (records: DnsRecord[]) => JSON.stringify(records.map(r => ({ id: r.id, type: r.type, name: nameOf(r.name), content: r.content,
  priority: r.priority, ttl: r.ttl, proxied: r.proxied })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
export function planDomainDns(domain: string, existing: DnsRecord[], providerRequirements: DnsRecord[]): DomainDnsPlan {
  domain = nameOf(domain);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('invalidDomain');
  let requirements: DnsRecord[] = providerRequirements.map(r => ({ ...r, name: r.name === '@' ? domain : nameOf(r.name), ttl: r.ttl ?? 1, proxied: false }));
  if (requirements.some(r => !['MX', 'TXT', 'CNAME'].includes(r.type) || typeof r.content !== 'string' || !r.content)) throw new Error('invalidMailDnsRequirement');
  if (requirements.some(r => r.name !== domain && !r.name.endsWith(`.${domain}`))) throw new Error('recordOutsideDomain');
  // Routing and sending can return the same SPF or MX requirement. Publish a
  // single SPF policy containing every provider mechanism, never parallel SPF TXT records.
  const combined: DnsRecord[] = [];
  for (const record of requirements) {
    if (combined.some(previous => equal(previous, record))) continue;
    const spf = record.type === 'TXT' && /^v=spf1(?:\s|$)/i.test(txt(record.content));
    const previous = spf ? combined.find(item => item.type === 'TXT' && item.name === record.name && /^v=spf1(?:\s|$)/i.test(txt(item.content))) : undefined;
    if (!previous) { combined.push(record); continue; }
    const terms = [previous.content, record.content].map(content => txt(content).trim().split(/\s+/).slice(1));
    const terminals = terms.map(policy => policy.filter(term => /^[+?~-]?all$/i.test(term)));
    if (terminals.some(values => values.length !== 1) || terminals[0][0] !== terminals[1][0] || terms.some(policy => policy.at(-1) !== terminals[0][0] || policy.some(term => /^redirect=/i.test(term)))) throw new Error('providerSpfRequirementsConflict');
    previous.content = ['v=spf1', ...new Set(terms.flat().filter(term => !/^[+?~-]?all$/i.test(term))), terminals[0][0]].join(' ');
  }
  requirements = combined;
  if (!requirements.some(r => r.type === 'MX') || !requirements.some(r => r.type === 'TXT' && /^v=spf1(?:\s|$)/i.test(txt(r.content))) || !requirements.some(r => r.name.includes('._domainkey.') && ['TXT', 'CNAME'].includes(r.type)))
    throw new Error('providerRequirementsIncomplete');
  if (!requirements.some(r => r.name === `_dmarc.${domain}`)) requirements.push({ type: 'TXT', name: `_dmarc.${domain}`, content: 'v=DMARC1; p=none', ttl: 1, proxied: false });
  const plan: DomainDnsPlan = { domain, snapshot: snapshotOf(existing), requirements, changes: [], conflicts: [], warnings: [] };
  for (const required of requirements) {
    const sameName = existing.filter(r => nameOf(r.name) === required.name);
    if (required.type === 'MX' && sameName.some(r => r.type === 'MX' && !requirements.some(w => equal(r, w)))) {
      plan.conflicts.push(`Conflicting MX record at ${required.name}; existing records will not be replaced.`); continue;
    }
    if (required.type === 'CNAME' && sameName.some(r => !equal(r, required)) || required.type !== 'CNAME' && sameName.some(r => r.type === 'CNAME')) {
      plan.conflicts.push(`Conflicting CNAME record at ${required.name}; existing records will not be replaced.`); continue;
    }
    if (required.type === 'TXT' && /^v=spf1(?:\s|$)/i.test(txt(required.content))) {
      const policies = sameName.filter(r => r.type === 'TXT' && /^v=spf1(?:\s|$)/i.test(txt(r.content)));
      if (policies.length > 1) { plan.conflicts.push(`Multiple SPF records at ${required.name}.`); continue; }
      if (policies.length === 1 && /(?:^|\s)[+?~-]?(include:|a(?:[:/\s]|$)|mx(?:[:/\s]|$)|exists:|ptr(?:[:\s]|$)|redirect=)/i.test(txt(policies[0].content)))
        plan.warnings.push(`SPF nested DNS lookup budget at ${required.name} requires recursive verification before sending.`);
    }
    if (required.name === `_dmarc.${domain}`) {
      const current = sameName.filter(r => r.type === 'TXT' && /^v=DMARC1;/i.test(txt(r.content)));
      if (current.length > 1) plan.conflicts.push('Multiple DMARC records must be resolved.');
      else if (current.length === 1 && /(?:^|;)\s*p=(none|quarantine|reject)(?:;|$)/i.test(txt(current[0].content))) {
        plan.warnings.push('Existing DMARC policy preserved.'); continue;
      } else if (current.length) plan.conflicts.push('Existing DMARC record is malformed.');
      else plan.changes.push({ kind: 'create', record: required });
      continue;
    }
    if (sameName.some(r => equal(r, required) && !r.proxied)) continue;
    if (required.type === 'TXT' && /^v=spf1\s/i.test(txt(required.content))) {
      const current = sameName.filter(r => r.type === 'TXT' && /^v=spf1(?:\s|$)/i.test(txt(r.content)));
      if (current.length > 1) { plan.conflicts.push(`Multiple SPF records at ${required.name}.`); continue; }
      if (current.length === 1) {
        const previous = current[0]; const terms = txt(previous.content).trim().split(/\s+/).slice(1);
        const additions = txt(required.content).trim().split(/\s+/).slice(1).filter(t => !/^[+?~-]?all$/i.test(t));
        if (terms.some(t => /^redirect=/i.test(t)) || additions.some(t => /^redirect=/i.test(t))) { plan.conflicts.push(`SPF redirect at ${required.name} needs manual review.`); continue; }
        const terminal = terms.filter(t => /^[+?~-]?all$/i.test(t));
        if (terminal.length !== 1 || terms[terms.length - 1] !== terminal[0]) { plan.conflicts.push(`Malformed SPF at ${required.name}.`); continue; }
        const merged = [...new Set([...terms.filter(t => !terminal.includes(t)), ...additions])];
        // include/a/mx/exists/ptr consume DNS lookups; nested includes cannot be established from TXT alone.
        const lookups = merged.filter(t => /^[+?~-]?(include:|a(?::|\/|$)|mx(?::|\/|$)|exists:|ptr(?::|$))/i.test(t));
        if (lookups.length > 10) { plan.conflicts.push(`SPF exceeds the ten DNS lookup limit at ${required.name}.`); continue; }
        if (lookups.length) plan.warnings.push(`SPF nested DNS lookup budget at ${required.name} requires recursive verification before sending.`);
        const record = { ...required, id: previous.id, content: ['v=spf1', ...merged, ...terminal].join(' ') };
        if (!equal(record, previous) || previous.proxied) plan.changes.push({ kind: 'update', record, previous }); continue;
      }
    }
    if (sameName.some(r => r.type === 'CNAME') || required.type === 'CNAME' && sameName.length ||
      required.type === 'MX' && sameName.some(r => r.type === 'MX' && !requirements.some(w => equal(r, w))) ||
      required.name.includes('._domainkey.') && sameName.some(r => r.type === required.type)) {
      plan.conflicts.push(`Conflicting ${required.type} record at ${required.name}; existing records will not be replaced.`);
      if (required.name.includes('._domainkey.') && required.type === 'TXT' && (plan.conflictDetails?.length || 0) < 8) {
        const detail: DomainDnsConflictDetail = { type: required.type, name: required.name, required: evidence(required.content), existing: sameName.filter(record => record.type === required.type).slice(0, 3).map(record => ({ ...evidence(record.content), firstDifference: firstDifference(txt(required.content), txt(record.content)) })) };
        (plan.conflictDetails ||= []).push(detail);
        // Record metadata only. Public record text is available in the explicit plan review.
        console.warn('Mail DNS selector conflict', { name: detail.name, required: { rawLength: detail.required.rawLength, canonicalLength: detail.required.canonicalLength, quoteCount: detail.required.quoteCount, backslashCount: detail.required.backslashCount }, existing: detail.existing.map(({ content: _content, ...metadata }) => metadata) });
      }
      continue;
    }
    plan.changes.push({ kind: 'create', record: required });
  }
  return plan;
}
export type RoutingSetupStep = 'enableRoutingDns' | 'setCatchAll';
export class DomainProviderError extends Error {
  constructor(message: string, readonly providerCodes: number[], readonly providerStep?: RoutingSetupStep) { super(message); }
}
const providerCodes = (value: unknown): number[] => {
  const errors = value && typeof value === 'object' ? (value as { errors?: unknown }).errors : undefined;
  return Array.isArray(errors) ? errors.map(error => error && typeof error === 'object' ? error.code : undefined).filter((code): code is number => Number.isSafeInteger(code) && code >= 0 && code <= 1_000_000_000).slice(0, 5) : [];
};
async function api<T>(env: DomainEnvironment, path: string, fetcher: typeof fetch, method = 'GET', body?: unknown, providerStep?: RoutingSetupStep): Promise<T> {
  if (!env.CF_API_TOKEN) throw new Error('domainSetupNotConfigured');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/${path}`, { method, headers: {
    Authorization: `Bearer ${env.CF_API_TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    throw new DomainProviderError(`cloudflareHttp${response.status}`, providerCodes(detail), providerStep);
  }
  const json = await response.json() as { success?: boolean; result: T };
  if (json.success !== true) throw new DomainProviderError('cloudflareApiFailure', providerCodes(json), providerStep); return json.result;
}

const scope = (zoneId: string) => { if (!/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('invalidZoneId'); return `zones/${zoneId}`; };
export async function listDomainDns(env: DomainEnvironment, zoneId: string, fetcher: typeof fetch = fetch): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api<DnsRecord[]>(env, `${scope(zoneId)}/dns_records?per_page=100&page=${page}`, fetcher);
    if (!Array.isArray(batch)) throw new Error('invalidDnsResponse'); records.push(...batch); if (batch.length < 100) return records;
  } throw new Error('dnsPaginationLimit');
}
/** Requires the provider's created sending subdomain ID; selectors are never guessed. */
export async function fetchDomainDnsPlan(env: DomainEnvironment, domain: string, zoneId: string, sendingSubdomainId: string, fetcher: typeof fetch = fetch): Promise<DomainDnsPlan> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sendingSubdomainId)) throw new Error('invalidSendingSubdomainId');
  const path = scope(zoneId);
  const zone = await api<{ name: string }>(env, path, fetcher);
  if (nameOf(zone.name) !== nameOf(domain)) throw new Error('zoneDomainMismatch');
  const routing = await api<DnsRecord[]>(env, `${path}/email/routing/dns`, fetcher);
  const sending = await api<DnsRecord[] | { records: DnsRecord[] }>(env, `${path}/email/sending/subdomains/${encodeURIComponent(sendingSubdomainId)}/dns`, fetcher);
  const sendingRecords = Array.isArray(sending) ? sending : sending.records;
  if (!Array.isArray(routing) || !Array.isArray(sendingRecords)) throw new Error('invalidProviderDnsResponse');
  return planDomainDns(domain, await listDomainDns(env, zoneId, fetcher), [...routing, ...sendingRecords]);
}
/** Caller must enforce current workspace/resource/domain authority and idempotent command receipts. */
export async function applyDomainDns(env: DomainEnvironment, zoneId: string, plan: DomainDnsPlan, fetcher: typeof fetch = fetch): Promise<{ applied: number; status: 'applied' | 'partial' | 'unknown'; error?: string }> {
  if (plan.conflicts.length) throw new Error('dnsPlanHasConflicts');
  const zone = await api<{ name: string }>(env, scope(zoneId), fetcher);
  if (nameOf(zone.name) !== plan.domain) throw new Error('zoneDomainMismatch');
  const current = await listDomainDns(env, zoneId, fetcher);
  if (snapshotOf(current) !== plan.snapshot) throw new Error('dnsPlanStale');
  const recomputed = planDomainDns(plan.domain, current, plan.requirements);
  if (JSON.stringify(recomputed.changes) !== JSON.stringify(plan.changes)) throw new Error('dnsPlanInvalid');
  let applied = 0;
  for (const change of plan.changes) {
    try { const { id, ...record } = change.record;
      if (change.kind === 'update' && !id) throw new Error('missingDnsRecordId');
      await api(env, `${scope(zoneId)}/dns_records${change.kind === 'update' ? `/${encodeURIComponent(id!)}` : ''}`, fetcher, change.kind === 'update' ? 'PATCH' : 'POST', record); applied++;
    } catch { return { applied, status: 'unknown', error: 'dnsMutationOutcomeUnknownReplanBeforeRetry' }; }
  } return { applied, status: 'applied' };
}
export function verifyDomainDns(plan: DomainDnsPlan, current: DnsRecord[]): { ready: boolean; checks: { type: string; name: string; status: 'ready' | 'missing' | 'conflict' }[]; warnings: string[] } {
  const verified = planDomainDns(plan.domain, current, plan.requirements);
  const checks = plan.requirements.map(r => ({ type: r.type, name: r.name,
    status: (verified.conflicts.some(c => c.includes(r.name)) ? 'conflict' : verified.changes.some(c => c.record.name === r.name && c.record.type === r.type) ? 'missing' : 'ready') as 'ready' | 'missing' | 'conflict' }));
  return { ready: !verified.changes.length && !verified.conflicts.length && !verified.warnings.some(w => w.includes('recursive')), checks, warnings: verified.warnings };
}
/** Evaluate the worst-case include/redirect path; do not confuse a flat count with RFC 7208's recursive budget. */
export async function checkSpfBudget(domain: string, policy: string,
  lookup: (domain: string) => Promise<string[]>): Promise<{ valid: boolean; lookups: number; error?: string }> {
  let lookups = 0; let voids = 0;
  const visit = async (host: string, content: string, ancestors: Set<string>): Promise<void> => {
    if (ancestors.has(host)) throw new Error('spfCycle');
    const path = new Set(ancestors).add(host);
    const terms = txt(content).trim().split(/\s+/);
    if (terms.shift()?.toLowerCase() !== 'v=spf1') throw new Error('invalidSpf');
    for (const term of terms) {
      if (term.includes('%')) throw new Error('spfMacroNeedsManualReview');
      if (/^[+]?all$/i.test(term)) throw new Error('spfAllowsEverySender');
      if (/^[+?~-]?ptr(?::|$)/i.test(term)) throw new Error('spfPtrNeedsManualReview');
      const include = /^[+?~-]?include:(.+)$/i.exec(term); const redirect = /^redirect=(.+)$/i.exec(term);
      if (include || redirect) {
        if (++lookups > 10) throw new Error('spfLookupLimit');
        const child = nameOf((include ?? redirect)![1]);
        const policies = (await lookup(child)).filter(v => /^v=spf1(?:\s|$)/i.test(txt(v)));
        if (!policies.length) { if (++voids > 2) throw new Error('spfVoidLookupLimit'); throw new Error('spfIncludeMissing'); }
        if (policies.length !== 1) throw new Error('spfMultiplePolicies');
        await visit(child, policies[0], path);
      } else if (/^[+?~-]?(a(?::|\/|$)|mx(?::|\/|$)|exists:)/i.test(term)) {
        // a/mx/exists need additional resolution/address limits; require manual verification instead of falsely passing.
        throw new Error('spfAddressMechanismNeedsManualReview');
      } else if (!/^[+?~-]?(?:ip4:[0-9./]+|ip6:[a-f0-9:/]+|all)$/i.test(term) && !/^exp=/i.test(term)) throw new Error('invalidSpfMechanism');
    }
  };
  try { await visit(nameOf(domain), policy, new Set()); return { valid: true, lookups }; }
  catch (error) { return { valid: false, lookups, error: error instanceof Error ? error.message : 'spfLookupFailed' }; }
}
export async function verifyDomainDnsWithSpf(plan: DomainDnsPlan, current: DnsRecord[], fetcher: typeof fetch = fetch) {
  const result = verifyDomainDns(plan, current);
  const lookup = async (domain: string): Promise<string[]> => {
    const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`, { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('spfDnsUnavailable');
    const body = await response.json() as { Status: number; Answer?: { type: number; data: string }[] };
    if (body.Status !== 0) throw new Error('spfDnsUnavailable');
    return (body.Answer ?? []).filter(a => a.type === 16).map(a => [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(part => part[1].replace(/\\(["\\])/g, '$1')).join(''));
  };
  const spfChecks = await Promise.all(current.filter(r => r.type === 'TXT' && /^v=spf1(?:\s|$)/i.test(txt(r.content)) && plan.requirements.some(q => q.name === nameOf(r.name) && /^v=spf1(?:\s|$)/i.test(txt(q.content)))).map(async r => ({ name: r.name, ...await checkSpfBudget(r.name, r.content, lookup) })));
  const warnings = result.warnings.filter(w => !w.includes('recursive'));
  for (const check of spfChecks) if (!check.valid) warnings.push(`SPF verification at ${check.name}: ${check.error}`);
  return { ...result, ready: result.checks.every(c => c.status === 'ready') && spfChecks.every(c => c.valid) && !planDomainDns(plan.domain, current, plan.requirements).conflicts.length, warnings, spfChecks };
}

/** Provider setup is retryable by domain name; no duplicate sending identity is created. */
export async function prepareSendingDomain(env: DomainEnvironment, domain: string, zoneId: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('invalidDomain');
  const path = `${scope(zoneId)}/email/sending/subdomains`;
  const current = await api<{ name: string; tag: string; enabled: boolean }[]>(env, path, fetcher);
  if (!Array.isArray(current)) throw new Error('invalidProviderResponse');
  const existing = current.find(item => nameOf(item.name) === domain && item.enabled);
  const result = existing ?? await api<{ name: string; tag: string }>(env, path, fetcher, 'POST', { name: domain });
  if (nameOf(result.name) !== domain || !/^[a-f0-9]{32}$/i.test(result.tag)) throw new Error('invalidProviderResponse');
  return result.tag;
}

/** Check route ownership before any DNS mutation. Cloudflare may not have a
 * catch-all object yet on a domain whose routing has never been configured. */
export async function inspectDomainRouting(env: DomainEnvironment, zoneId: string, worker: string, fetcher: typeof fetch = fetch): Promise<{ enabled?: boolean; ours: boolean }> {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(worker)) throw new Error('invalidIngressWorker');
  const path = `${scope(zoneId)}/email/routing`;
  const isOurs = (rule: { actions?: { type: string; value?: string[] }[] }) => rule.actions?.length === 1 && rule.actions[0].type === 'worker' && rule.actions[0].value?.length === 1 && rule.actions[0].value[0] === worker;
  let current: { enabled?: boolean; actions?: { type: string; value?: string[] }[] };
  try { current = await api(env, `${path}/rules/catch_all`, fetcher); }
  catch (error) { if (error instanceof Error && error.message === 'cloudflareHttp404') current = { enabled: false }; else throw error; }
  const ours = isOurs(current);
  if (current.enabled && !ours) throw new Error('existingCatchAllRouteNeedsManualReview');
  for (let page = 1; page <= 100; page++) {
    const rules = await api<{ enabled?: boolean; actions?: { type: string; value?: string[] }[] }[]>(env, `${path}/rules?per_page=100&page=${page}`, fetcher);
    if (!Array.isArray(rules)) throw new Error('invalidProviderResponse');
    if (rules.some(rule => rule.enabled && !isOurs(rule))) throw new Error('existingRecipientRouteNeedsManualReview');
    if (rules.length < 100) return { enabled: current.enabled, ours };
  }
  throw new Error('routingPaginationLimit');
}

export async function verifyDomainRouting(env: DomainEnvironment, zoneId: string, worker: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const route = await inspectDomainRouting(env, zoneId, worker, fetcher);
  const settings = await api<{ enabled?: boolean }>(env, `${scope(zoneId)}/email/routing`, fetcher);
  return route.enabled === true && route.ours && settings.enabled === true;
}

export async function verifySendingDomain(env: DomainEnvironment, domain: string, zoneId: string, sendingSubdomainId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/i.test(sendingSubdomainId)) throw new Error('invalidSendingSubdomainId');
  const sending = await api<{ name: string; enabled: boolean }>(env, `${scope(zoneId)}/email/sending/subdomains/${sendingSubdomainId}`, fetcher);
  return nameOf(sending.name) === nameOf(domain) && sending.enabled === true;
}

/** Preserve active routes owned by another application. Unknown recipients are
 * rejected by the bounded ingress Worker using Mail's private directory. */
export async function connectDomainRouting(env: DomainEnvironment, domain: string, zoneId: string, worker: string, fetcher: typeof fetch = fetch): Promise<void> {
  const current = await inspectDomainRouting(env, zoneId, worker, fetcher);
  const path = `${scope(zoneId)}/email/routing`;
  // Only run after the complete DNS plan has been applied and verified by Mail.
  const settings = await api<{ enabled?: boolean }>(env, path, fetcher);
  // Zone-apex activation uses the documented bodyless call. Re-enabling an
  // already enabled zone can reject existing locked records, so read it first.
  if (settings.enabled !== true) await api(env, `${path}/dns`, fetcher, 'POST', undefined, 'enableRoutingDns');
  if (!current.enabled || !current.ours) await api(env, `${path}/rules/catch_all`, fetcher, 'PUT', { name: 'EnoughMail', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [worker] }] }, 'setCatchAll');
}

export interface DomainRoutingRule { id?: string; tag?: string; name?: string; enabled: boolean; matchers: { type: string; field?: string; value?: string }[]; actions: { type: string; value?: string[] }[]; priority?: number; source?: 'api' | 'wrangler'; owner_worker_tag?: string }
export interface DomainSetupProposal {
  version: 1; domain: string; zoneId: string; worker: string; sendingSubdomainId: string;
  dnsSnapshot: string; routingSnapshot: string;
  removeRecords: DnsRecord[]; plan: DomainDnsPlan;
  disableRules: DomainRoutingRule[]; previousCatchAll: DomainRoutingRule; previousRoutingEnabled: boolean;
  blockers: string[];
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const ownsRule = (rule: DomainRoutingRule, worker: string) => rule.actions?.length === 1 && rule.actions[0].type === 'worker' && rule.actions[0].value?.length === 1 && rule.actions[0].value[0] === worker;
const ruleId = (rule: DomainRoutingRule) => rule.id || rule.tag;
const writableRule = (rule: DomainRoutingRule) => ({ ...(rule.name ? { name: rule.name } : {}), enabled: rule.enabled, matchers: rule.matchers, actions: rule.actions, ...(rule.priority !== undefined ? { priority: rule.priority } : {}), ...(rule.source ? { source: rule.source } : {}), ...(rule.owner_worker_tag ? { owner_worker_tag: rule.owner_worker_tag } : {}) });
async function routingSnapshot(env: DomainEnvironment, zoneId: string, fetcher: typeof fetch) {
  const path = `${scope(zoneId)}/email/routing`;
  let catchAll: DomainRoutingRule;
  try { catchAll = await api(env, `${path}/rules/catch_all`, fetcher); }
  catch (error) { if (error instanceof Error && error.message === 'cloudflareHttp404') catchAll = { enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] }; else throw error; }
  const rules: DomainRoutingRule[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api<DomainRoutingRule[]>(env, `${path}/rules?per_page=100&page=${page}`, fetcher);
    if (!Array.isArray(batch)) throw new Error('invalidProviderResponse');
    rules.push(...batch);
    if (batch.length < 100) break;
    if (page === 100) throw new Error('routingPaginationLimit');
  }
  const normalize = (rule: DomainRoutingRule): DomainRoutingRule => ({ ...(ruleId(rule) ? { id: ruleId(rule) } : {}), ...writableRule({ ...rule, matchers: rule.matchers || [{ type: 'all' }], actions: rule.actions || [] }) });
  return { catchAll: normalize(catchAll), rules: rules.map(normalize).sort((a, b) => (ruleId(a) || '').localeCompare(ruleId(b) || '')) };
}
/** Build a bounded, exact proposal. Only mail records may be replaced; website
 * records and valid existing DMARC policies remain outside automatic takeover. */
export async function reviewDomainSetup(env: DomainEnvironment, domain: string, zoneId: string, sendingSubdomainId: string, worker: string, fetcher: typeof fetch = fetch): Promise<DomainSetupProposal> {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(worker)) throw new Error('invalidIngressWorker');
  const original = await fetchDomainDnsPlan(env, domain, zoneId, sendingSubdomainId, fetcher);
  const records = await listDomainDns(env, zoneId, fetcher);
  if (snapshotOf(records) !== original.snapshot) throw new Error('dnsPlanStale');
  const routing = await routingSnapshot(env, zoneId, fetcher);
  const routingSettings = await api<{ enabled?: boolean }>(env, `${scope(zoneId)}/email/routing`, fetcher);
  const removeRecords = records.filter(record => original.requirements.some(required => {
    if (nameOf(record.name) !== nameOf(required.name)) return false;
    if (required.type === 'MX' && record.type === 'MX') return !original.requirements.some(item => equal(item, record));
    if (required.name.includes('._domainkey.') && ['TXT', 'CNAME'].includes(record.type)) return !original.requirements.some(item => equal(item, record) && !record.proxied);
    if (record.type !== 'TXT' || required.type !== 'TXT') return false;
    if (/^v=spf1(?:\s|$)/i.test(txt(required.content))) return /^v=spf1(?:\s|$)/i.test(txt(record.content)) && original.conflicts.some(conflict => conflict.includes(required.name) && conflict.includes('SPF'));
    return required.name === `_dmarc.${nameOf(domain)}` && /^v=DMARC1(?:;|\s|$)/i.test(txt(record.content)) && original.conflicts.some(conflict => conflict.includes('DMARC'));
  })).sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const plan = planDomainDns(domain, records.filter(record => !removeRecords.includes(record)), original.requirements);
  const disableRules = routing.rules.filter(rule => rule.enabled && !ownsRule(rule, worker));
  const blockers = [...plan.conflicts];
  if (disableRules.some(rule => rule.source === 'wrangler' && !rule.owner_worker_tag)) blockers.push('A Worker-managed route is missing its owner identifier. Update that route in its Worker configuration before continuing.');
  if (removeRecords.some(record => !/^[a-f0-9]{32}$/i.test(record.id || ''))) blockers.push('A conflicting DNS record has no valid provider identifier. Review it in Cloudflare.');
  if (disableRules.some(rule => !/^[a-f0-9]{32}$/i.test(ruleId(rule) || ''))) blockers.push('An existing route has no valid provider identifier. Review it in Cloudflare.');
  const proposal: DomainSetupProposal = { version: 1, domain: nameOf(domain), zoneId, worker, sendingSubdomainId, dnsSnapshot: original.snapshot, routingSnapshot: canonical(routing), removeRecords, plan, disableRules, previousCatchAll: routing.catchAll, previousRoutingEnabled: routingSettings.enabled === true, blockers };
  if (new TextEncoder().encode(JSON.stringify(proposal)).length > 256_000) throw new Error('domainReviewTooLarge');
  return proposal;
}
/** Validate provider evidence before retaining it as a recovery journal. The
 * mutation helper repeats this check after that journal has been committed. */
export async function validateReviewedDomainSetup(env: DomainEnvironment, reviewed: DomainSetupProposal, fetcher: typeof fetch = fetch): Promise<DomainSetupProposal> {
  if (new TextEncoder().encode(JSON.stringify(reviewed)).length > 256_000) throw new Error('domainReviewTooLarge');
  const latest = await reviewDomainSetup(env, reviewed.domain, reviewed.zoneId, reviewed.sendingSubdomainId, reviewed.worker, fetcher);
  if (canonical(latest) !== canonical(reviewed)) throw new Error('domainReviewStale');
  if (latest.blockers.length) throw new Error('domainReviewBlocked');
  return latest;
}
/** The caller must persist recovery evidence before calling this method. An
 * uncertain external mutation is never blindly retried or automatically undone. */
export async function applyReviewedDomainSetup(env: DomainEnvironment, reviewed: DomainSetupProposal, fetcher: typeof fetch = fetch): Promise<{ status: 'applied' | 'unknown'; completed: string[] }> {
  const latest = await validateReviewedDomainSetup(env, reviewed, fetcher);
  const completed: string[] = [];
  try {
    for (const record of latest.removeRecords) { await api(env, `${scope(latest.zoneId)}/dns_records/${record.id}`, fetcher, 'DELETE'); completed.push(`remove-dns:${record.id}`); }
    // Re-check the exact remaining DNS before writes. A concurrent provider edit
    // stops here with the retained recovery evidence available to the owner.
    const current = await listDomainDns(env, latest.zoneId, fetcher);
    if (snapshotOf(current) !== latest.plan.snapshot) throw new Error('domainReviewStale');
    const applied = await applyDomainDns(env, latest.zoneId, latest.plan, fetcher);
    if (applied.status !== 'applied') return { status: 'unknown', completed: [...completed, `dns-writes-confirmed:${applied.applied}`] };
    completed.push(`dns-writes-confirmed:${applied.applied}`);
    if (canonical(await routingSnapshot(env, latest.zoneId, fetcher)) !== latest.routingSnapshot) throw new Error('domainReviewStale');
    for (const rule of latest.disableRules) { await api(env, `${scope(latest.zoneId)}/email/routing/rules/${ruleId(rule)}`, fetcher, 'PUT', writableRule({ ...rule, enabled: false })); completed.push(`disable-route:${ruleId(rule)}`); }
    // The catch-all is replaced only after safe DNS is verified by the account.
    return { status: 'applied', completed };
  } catch { return { status: 'unknown', completed }; }
}
/** Re-check the reviewed catch-all immediately before replacing it. Other
 * routes remain subject to normal conflict checks after reviewed disables. */
export async function connectReviewedDomainRouting(env: DomainEnvironment, reviewed: DomainSetupProposal, fetcher: typeof fetch = fetch): Promise<void> {
  const current = await routingSnapshot(env, reviewed.zoneId, fetcher);
  const expected = JSON.parse(reviewed.routingSnapshot) as { catchAll: DomainRoutingRule; rules: DomainRoutingRule[] };
  expected.rules = expected.rules.map(rule => reviewed.disableRules.some(disabled => ruleId(disabled) === ruleId(rule)) ? { ...rule, enabled: false } : rule);
  if (canonical(current) !== canonical(expected)) throw new Error('domainReviewStale');
  if (current.rules.some(rule => rule.enabled && !ownsRule(rule, reviewed.worker))) throw new Error('domainReviewStale');
  const path = `${scope(reviewed.zoneId)}/email/routing`;
  const settings = await api<{ enabled?: boolean }>(env, path, fetcher);
  if (settings.enabled !== true) await api(env, `${path}/dns`, fetcher, 'POST', undefined, 'enableRoutingDns');
  await api(env, `${path}/rules/catch_all`, fetcher, 'PUT', { name: 'EnoughMail', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [reviewed.worker] }] }, 'setCatchAll');
}
