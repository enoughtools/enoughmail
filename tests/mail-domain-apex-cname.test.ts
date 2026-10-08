import { describe, expect, it, vi } from 'vitest';
import { applyDomainDns, applyReviewedDomainSetup, connectReviewedDomainRouting, fetchDomainDnsPlan, planDomainDns, reviewDomainSetup, verifyDomainDns, verifyDomainDnsWithSpf, verifyDomainRouting, type DnsRecord } from '../apps/mail/src/server/domains';

const zoneId = 'a'.repeat(32), sendingId = 'b'.repeat(32), websiteId = 'c'.repeat(32), oldMxId = 'd'.repeat(32);
const env = { CF_API_TOKEN: 'test' }, worker = 'enough-mail-ingress';
const response = (result: unknown) => Response.json({ success: true, result });

function fixture(options: { zone?: { name: string; type?: string; status?: string }; oldProvider?: boolean; proxied?: boolean } = {}) {
  const zone = options.zone || { name: 'example.com', type: 'full', status: 'active' };
  const website: DnsRecord = { id: websiteId, type: 'CNAME', name: 'example.com', content: 'website.example.net', ttl: 3600, proxied: options.proxied || false, locked: false };
  const records: DnsRecord[] = [structuredClone(website)];
  if (options.oldProvider) records.push({ id: oldMxId, type: 'MX', name: 'example.com', content: 'example-com.mail.protection.outlook.com', priority: 0, ttl: 3600, proxied: false });
  const routing: DnsRecord[] = [
    ...[1, 2, 3].map(index => ({ type: 'MX', name: 'example.com', content: `route${index}.mx.cloudflare.net`, priority: index * 10 })),
    { type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.example.net ~all' },
  ];
  const sending: DnsRecord[] = [{ type: 'TXT', name: 'cf._domainkey.example.com', content: 'v=DKIM1; p=fixture' }];
  let catchAll = { id: 'e'.repeat(32), name: 'Previous mail', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['owner@other.test'] }] };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 ip4:192.0.2.1 ~all"' }] });
    if (url.pathname === `/client/v4/zones/${zoneId}`) return response(zone);
    if (url.pathname.endsWith('/email/routing/dns')) return response(routing);
    if (url.pathname.endsWith(`/subdomains/${sendingId}/dns`)) return response(sending);
    if (url.pathname.endsWith('/email/routing/rules')) return response([]);
    if (url.pathname.endsWith('/rules/catch_all')) { if (method === 'PUT') catchAll = { ...catchAll, ...body }; return response(catchAll); }
    if (url.pathname.endsWith('/email/routing')) return response({ enabled: true });
    if (url.pathname.endsWith('/dns_records')) {
      if (method === 'POST') records.push({ ...body, id: crypto.randomUUID().replaceAll('-', '') });
      return response(method === 'POST' ? records.at(-1) : records);
    }
    if (url.pathname.includes('/dns_records/') && method === 'DELETE') { records.splice(records.findIndex(record => url.pathname.endsWith(record.id || 'missing')), 1); return response({}); }
    if (url.pathname.includes('/dns_records/') && method === 'PATCH') { const record = records.find(record => url.pathname.endsWith(record.id || 'missing')); Object.assign(record!, body); return response(record); }
    throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
  });
  const mutations = () => fetcher.mock.calls.filter(([, init]) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(init?.method || ''));
  return { zone, website, records, routing, sending, fetcher, mutations };
}

describe('Cloudflare zone-apex website CNAME and mail records', () => {
  it.each([false, true])('preserves the website CNAME through serialized review, adoption and verification (proxied: %s)', async proxied => {
    const state = fixture({ oldProvider: true, proxied });
    const proposal = JSON.parse(JSON.stringify(await reviewDomainSetup(env, 'example.com', zoneId, sendingId, worker, state.fetcher)));
    expect(proposal.blockers).toEqual([]);
    expect(proposal.plan.apexCnameFlattening).toBe(true);
    expect(proposal.removeRecords.map((record: DnsRecord) => record.id)).toEqual([oldMxId]);
    expect(proposal.plan.changes).toHaveLength(6);
    expect(proposal.plan.changes.every((change: { record: DnsRecord }) => ['MX', 'TXT'].includes(change.record.type))).toBe(true);
    expect(await applyReviewedDomainSetup(env, proposal, state.fetcher)).toMatchObject({ status: 'applied' });
    const applied = await fetchDomainDnsPlan(env, 'example.com', zoneId, sendingId, state.fetcher);
    expect(applied.changes).toEqual([]);
    expect(verifyDomainDns(applied, state.records).checks.every(check => check.status === 'ready')).toBe(true);
    expect((await verifyDomainDnsWithSpf(applied, state.records, state.fetcher)).ready).toBe(true);
    await connectReviewedDomainRouting(env, proposal, state.fetcher);
    expect(await verifyDomainRouting(env, zoneId, worker, state.fetcher)).toBe(true);
    expect(state.records.find(record => record.id === websiteId)).toEqual(state.website);
    expect(state.mutations().some(([url]) => String(url).endsWith(`/dns_records/${websiteId}`))).toBe(false);
    expect(state.mutations().filter(([, init]) => init?.method === 'DELETE').map(([url]) => String(url).split('/').at(-1))).toEqual([oldMxId]);
  });

  it.each([
    { name: 'example.com' },
    { name: 'example.com', type: 'full' },
    { name: 'example.com', status: 'active' },
    { name: 'example.com', type: 'partial', status: 'active' },
    { name: 'example.com', type: 'full', status: 'pending' },
  ])('keeps CNAME blockers without active authoritative zone evidence: %j', async zone => {
    const state = fixture({ zone });
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, worker, state.fetcher);
    expect(proposal.plan.apexCnameFlattening).toBeUndefined();
    expect(proposal.blockers.some(blocker => blocker.includes('Conflicting CNAME'))).toBe(true);
    expect(proposal.removeRecords).toEqual([]);
    await expect(applyReviewedDomainSetup(env, proposal, state.fetcher)).rejects.toThrow('domainReviewBlocked');
    expect(state.mutations()).toEqual([]);
  });

  it('keeps subdomain CNAME conflicts protected and rejects a mismatched zone apex', async () => {
    const state = fixture();
    state.records.push({ id: 'f'.repeat(32), type: 'CNAME', name: 'mail.example.com', content: 'another-website.example.net' });
    state.routing.push({ type: 'MX', name: 'mail.example.com', content: 'route1.mx.cloudflare.net', priority: 10 });
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, worker, state.fetcher);
    expect(proposal.plan.apexCnameFlattening).toBe(true);
    expect(proposal.blockers).toContain('Conflicting CNAME record at mail.example.com; existing records will not be replaced.');
    expect(proposal.removeRecords).toEqual([]);
    state.zone.name = 'another.example.com';
    await expect(fetchDomainDnsPlan(env, 'example.com', zoneId, sendingId, state.fetcher)).rejects.toThrow('zoneDomainMismatch');
    expect(state.mutations()).toEqual([]);
  });

  it.each(['zoneType', 'zoneStatus', 'context', 'website'] as const)('rejects changed %s before removing existing provider records', async kind => {
    const state = fixture({ oldProvider: true });
    const proposal = JSON.parse(JSON.stringify(await reviewDomainSetup(env, 'example.com', zoneId, sendingId, worker, state.fetcher)));
    if (kind === 'zoneType') state.zone.type = 'partial';
    else if (kind === 'zoneStatus') state.zone.status = 'pending';
    else if (kind === 'context') delete proposal.plan.apexCnameFlattening;
    else state.records[0].ttl = 7200;
    await expect(applyReviewedDomainSetup(env, proposal, state.fetcher)).rejects.toThrow('domainReviewStale');
    expect(state.records.some(record => record.id === oldMxId)).toBe(true);
    expect(state.mutations()).toEqual([]);
  });

  it('rejects a changed zone even when no DNS writes were planned', async () => {
    const state = fixture();
    state.records.push(...state.routing, ...state.sending, { type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=none' });
    const plan = await fetchDomainDnsPlan(env, 'example.com', zoneId, sendingId, state.fetcher);
    expect(plan.changes).toEqual([]);
    state.zone.type = 'partial';
    await expect(applyDomainDns(env, zoneId, plan, state.fetcher)).rejects.toThrow('dnsPlanStale');
    expect(state.mutations()).toEqual([]);
  });

  it('does not trust a caller’s flattening capability at apply time', async () => {
    const state = fixture({ zone: { name: 'example.com', type: 'partial', status: 'active' } });
    const plan = planDomainDns('example.com', state.records, [...state.routing, ...state.sending], { apexCnameFlattening: true });
    expect(plan.conflicts).toEqual([]);
    await expect(applyDomainDns(env, zoneId, plan, state.fetcher)).rejects.toThrow('dnsPlanStale');
    expect(state.mutations()).toEqual([]);
  });
});
