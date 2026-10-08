import { describe, expect, it, vi } from 'vitest';
import { applyReviewedDomainSetup, connectReviewedDomainRouting, reviewDomainSetup, type DnsRecord } from '../apps/mail/src/server/domains';

const zoneId = 'a'.repeat(32), sendingId = 'b'.repeat(32), catchAllId = 'c'.repeat(32), recipientId = 'd'.repeat(32);
const response = (result: unknown) => Response.json({ success: true, result });

function fixture(options: { omitCatchAllIdentifier?: boolean; distinctAllRule?: boolean } = {}) {
  let catchAll = { id: catchAllId, name: 'Previous delivery', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['owner@other.test'] }] };
  const recipient = { id: recipientId, name: 'Named recipient', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'hello@example.com' }], actions: [{ type: 'forward', value: ['named@other.test'] }] };
  const records: DnsRecord[] = [
    { type: 'MX', name: 'example.com', content: 'mx.cloudflare.net', priority: 10 },
    { type: 'TXT', name: 'example.com', content: 'v=spf1 ip4:192.0.2.1 -all' },
    { type: 'TXT', name: 'cf._domainkey.example.com', content: 'v=DKIM1; p=fixture' },
    { type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=none' },
  ];
  const requirements = records.map(record => ({ ...record }));
  const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith('/rules/catch_all')) {
      if (method === 'PUT') catchAll = { ...catchAll, ...body };
      const { id, ...withoutId } = catchAll;
      return response(options.omitCatchAllIdentifier ? withoutId : catchAll);
    }
    if (url.pathname.endsWith('/email/routing/rules')) return response([
      { ...catchAll, ...(options.distinctAllRule ? { id: 'e'.repeat(32) } : {}) },
      recipient,
    ]);
    if (method === 'PUT' && url.pathname.endsWith(`/rules/${recipientId}`)) { Object.assign(recipient, body); return response(recipient); }
    if (url.pathname.endsWith('/email/routing')) return response({ enabled: true });
    if (url.pathname.endsWith('/email/routing/dns')) return response(requirements.slice(0, 2));
    if (url.pathname.endsWith(`/subdomains/${sendingId}/dns`)) return response(requirements.slice(2, 3));
    if (method === 'DELETE' && url.pathname.includes('/dns_records/')) { const index = records.findIndex(record => url.pathname.endsWith(record.id || 'missing')); if (index >= 0) records.splice(index, 1); return response({}); }
    if (url.pathname.endsWith('/dns_records')) return response(records);
    if (url.pathname === `/client/v4/zones/${zoneId}`) return response({ name: 'example.com' });
    throw new Error(`Unexpected provider operation ${method} ${url.pathname}`);
  });
  return { fetcher, recipient, records, readCatchAll: () => catchAll };
}

describe('Catch-all returned in the provider rules list', () => {
  it.each([false, true])('keeps the catch-all active until final cutover (missing catch-all id: %s)', async omitCatchAllIdentifier => {
    const { fetcher, recipient, readCatchAll } = fixture({ omitCatchAllIdentifier });
    const env = { CF_API_TOKEN: 'test' };
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    expect(proposal.disableRules.map(rule => rule.id)).toEqual([recipientId]);
    expect(await applyReviewedDomainSetup(env, proposal, fetcher)).toMatchObject({ status: 'applied', completed: ['dns-writes-confirmed:0'] });
    expect(recipient.enabled).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect(readCatchAll().enabled).toBe(true);
    expect(readCatchAll().actions).toEqual([{ type: 'forward', value: ['owner@other.test'] }]);
    await connectReviewedDomainRouting(env, proposal, fetcher);
    expect(recipient.enabled).toBe(false);
    expect(readCatchAll().actions).toEqual([{ type: 'worker', value: ['enough-mail-ingress'] }]);
    expect(fetcher.mock.calls.some(([input, init]) => String(input).endsWith(`/rules/${catchAllId}`) && init?.method === 'PUT')).toBe(false);
  });

  it('retains a separately identified all-address rule for explicit review', async () => {
    const { fetcher } = fixture({ distinctAllRule: true });
    const proposal = await reviewDomainSetup({ CF_API_TOKEN: 'test' }, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    expect(proposal.disableRules.map(rule => rule.id)).toEqual([recipientId, 'e'.repeat(32)]);
  });

  it('normalizes the documented api owner default before writing older routing records', async () => {
    const { fetcher } = fixture();
    const proposal = await reviewDomainSetup({ CF_API_TOKEN: 'test' }, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    expect(proposal.disableRules[0].source).toBe('api');
    await connectReviewedDomainRouting({ CF_API_TOKEN: 'test' }, proposal, fetcher);
    const recipientWrite = fetcher.mock.calls.find(([input, init]) => String(input).endsWith(`/rules/${recipientId}`) && init?.method === 'PUT');
    expect(JSON.parse(String(recipientWrite?.[1]?.body))).toMatchObject({ source: 'api', enabled: false });
  });
});

describe('Reviewed adoption failures and protected records', () => {
  const env = { CF_API_TOKEN: 'test' };
  const providerFailure = () => Response.json({ success: false, errors: [{ code: 1004, message: 'sensitive provider detail' }] }, { status: 422 });

  it('retains the exact failure step when the provider rejects a reviewed DNS removal', async () => {
    const { fetcher, records } = fixture();
    records[0] = { ...records[0], id: 'f'.repeat(32), content: 'mx.other.test' };
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => init?.method === 'DELETE' ? providerFailure() : original(input, init));
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    await expect(applyReviewedDomainSetup(env, proposal, fetcher)).rejects.toMatchObject({ message: 'cloudflareHttp422', providerCodes: [1004], providerStep: 'removeDns', completed: [] });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('keeps confirmed removals and provider codes when a subsequent DNS write fails', async () => {
    const { fetcher, records } = fixture();
    const previousId = 'f'.repeat(32);
    records[0] = { ...records[0], id: previousId, content: 'mx.other.test' };
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => init?.method === 'POST' && String(input).endsWith('/dns_records') ? providerFailure() : original(input, init));
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    await expect(applyReviewedDomainSetup(env, proposal, fetcher)).rejects.toMatchObject({ message: 'cloudflareHttp422', providerCodes: [1004], providerStep: 'applyDns', completed: [`remove-dns:${previousId}`, 'dns-writes-confirmed:0'] });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it.each(['disableRecipientRule', 'setCatchAll'] as const)('reports %s without replacing prior delivery when that operation fails', async step => {
    const { fetcher, readCatchAll, recipient } = fixture();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      const failingPath = step === 'disableRecipientRule' ? `/rules/${recipientId}` : '/rules/catch_all';
      return init?.method === 'PUT' && String(input).endsWith(failingPath) ? providerFailure() : original(input, init);
    });
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    await applyReviewedDomainSetup(env, proposal, fetcher);
    await expect(connectReviewedDomainRouting(env, proposal, fetcher)).rejects.toMatchObject({ message: 'cloudflareHttp422', providerCodes: [1004], providerStep: step, completed: step === 'disableRecipientRule' ? [] : [`disable-route:${recipientId}`] });
    expect(recipient.enabled).toBe(step === 'disableRecipientRule');
    expect(readCatchAll().actions).toEqual([{ type: 'forward', value: ['owner@other.test'] }]);
  });

  it.each(['MX', 'SPF'] as const)('blocks a protected %s change before any DNS or routing writes', async kind => {
    const { fetcher, records } = fixture();
    if (kind === 'MX') records[0] = { ...records[0], id: 'f'.repeat(32), locked: true, content: 'mx.other.test' };
    else records[1] = { ...records[1], id: 'f'.repeat(32), locked: true, content: 'v=spf1 ip4:198.51.100.1 -all' };
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    expect(proposal.blockers.some(blocker => blocker.includes('Cloudflare protects'))).toBe(true);
    await expect(applyReviewedDomainSetup(env, proposal, fetcher)).rejects.toThrow('domainReviewBlocked');
    expect(fetcher.mock.calls.some(([, init]) => ['PUT', 'PATCH', 'DELETE', 'POST'].includes(init?.method || ''))).toBe(false);
  });

  it('preserves a matching protected Cloudflare MX without treating it as a blocker', async () => {
    const { fetcher, records } = fixture();
    records[0].locked = true;
    const proposal = await reviewDomainSetup(env, 'example.com', zoneId, sendingId, 'enough-mail-ingress', fetcher);
    expect(proposal.removeRecords).toEqual([]);
    expect(proposal.blockers).toEqual([]);
    expect(proposal.plan.changes).toEqual([]);
    await applyReviewedDomainSetup(env, proposal, fetcher);
    expect(fetcher.mock.calls.some(([, init]) => ['PUT', 'PATCH', 'DELETE', 'POST'].includes(init?.method || ''))).toBe(false);
    expect(records[0].locked).toBe(true);
  });
});
