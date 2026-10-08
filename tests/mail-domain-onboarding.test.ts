import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { prepareSendingDomain, connectDomainRouting, inspectDomainRouting, planDomainDns } from '../apps/mail/src/server/domains';
import { MailAccount } from '../apps/mail/src/server/account';
const zoneId = 'a'.repeat(32), sendingId = 'b'.repeat(32);
const response = (result: unknown) => Response.json({ success: true, result });
afterEach(() => vi.unstubAllGlobals());
describe('Domain setup in Mail', () => {
  it('creates sending configuration for each domain and reuses existing provider identities', async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    const identities: { name: string; tag: string; enabled: boolean }[] = [];
    const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (init?.method === 'POST') { const identity = { name: calls.at(-1)!.body.name, tag: sendingId, enabled: true }; identities.push(identity); return response(identity); }
      return response(identities);
    });
    for (const domain of ['first.example.com', 'second.example.com', 'third.example.com']) {
      expect(await prepareSendingDomain({ CF_API_TOKEN: 'test' }, domain, zoneId, fetcher)).toBe(sendingId);
      expect(await prepareSendingDomain({ CF_API_TOKEN: 'test' }, domain, zoneId, fetcher)).toBe(sendingId);
    }
    expect(calls.filter(call => call.method === 'POST').map(call => call.body.name)).toEqual(['first.example.com', 'second.example.com', 'third.example.com']);
  });
  it('refuses to replace an active recipient route and safely retries its own route', async () => {
    const calls: string[] = [];
    let rule: any = { enabled: true, actions: [{ type: 'forward', value: ['existing@example.com'] }] };
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) => { calls.push(init?.method ?? 'GET'); if (init?.method === 'PUT') rule = JSON.parse(String(init.body)); return response(String(_url).includes('/rules?') ? [] : rule); });
    const env = { CF_API_TOKEN: 'test' };
    await expect(connectDomainRouting(env, 'example.com', zoneId, 'enough-mail-ingress', fetcher)).rejects.toThrow('existingCatchAll');
    expect(calls).toEqual(['GET']);
    rule = { enabled: false, actions: [{ type: 'drop' }] }; calls.length = 0;
    await connectDomainRouting(env, 'example.com', zoneId, 'enough-mail-ingress', fetcher);
    expect(calls).toEqual(['GET', 'GET', 'GET', 'POST', 'PUT']);
    calls.length = 0;
    await connectDomainRouting(env, 'example.com', zoneId, 'enough-mail-ingress', fetcher);
    expect(calls).toEqual(['GET', 'GET', 'GET']);
  });
  it('requires account management, administrator role, zone approval and exact revision before provider mutations', async () => {
    const db = new DatabaseSync(':memory:'); let approved = false;
    const storage = {
      sql: { exec<T>(sql: string, ...bindings: unknown[]): Iterable<T> { const statement = db.prepare(sql); return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[]; } },
      transactionSync<T>(task: () => T): T { db.exec('SAVEPOINT test'); try { const result = task(); db.exec('RELEASE test'); return result; } catch (error) { db.exec('ROLLBACK TO test; RELEASE test'); throw error; } },
      async setAlarm() {}, async deleteAlarm() {},
    };
    const provider = vi.fn(async (_url: any, init?: RequestInit) => response(init?.method === 'POST' ? { name: 'example.com', tag: sendingId } : []));
    vi.stubGlobal('fetch', provider);
    const account = new MailAccount({ storage }, { MAIL_BLOBS: { async put() {}, async get() { return null; }, async delete() {} }, CF_API_TOKEN: 'test', MAIL_DIRECTORY: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: approved }) }) } });
    const call = async (name: string, args: any = {}, actions = ['mail.read', 'mail.manage'], role = 'owner') => {
      const result = await account.fetch(new Request('https://account/jmap', { method: 'POST', body: JSON.stringify({ accountId: 'account', organizationId: 'org', workspaceId: 'workspace', actor: { id: 'owner', actions, workspaceRole: role }, request: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [[name, { accountId: 'account', ...args }, 'call']] } }) }));
      return (await result.json() as any).methodResponses[0][1];
    };
    try {
      const created = await call('Domain/set', { create: { first: { name: 'example.com', zoneId } } });
      const domainId = created.created.first.id;
      const args = { domainId, operationId: crypto.randomUUID(), ifInState: created.newState };
      expect((await call('Domain/prepare', args)).type).toBe('forbidden');
      approved = true;
      expect((await call('Domain/prepare', { ...args, operationId: crypto.randomUUID() }, ['mail.read'])).type).toBe('forbidden');
      expect((await call('Domain/prepare', { ...args, operationId: crypto.randomUUID() }, undefined, 'member')).type).toBe('forbidden');
      expect((await call('Domain/prepare', { ...args, operationId: crypto.randomUUID(), ifInState: 'stale' })).type).toBe('stateMismatch');
      expect(provider).not.toHaveBeenCalled();
      const prepared = await call('Domain/prepare', { ...args, operationId: crypto.randomUUID() });
      expect(prepared.sendingSubdomainId).toBe(sendingId);
      expect(provider).toHaveBeenCalledTimes(2);
      const current = await call('Domain/get');
      expect(current.list[0].sendingSubdomainId).toBe(sendingId);
      expect(current.list[0].sendingVerified).toBe(false);
    } finally { db.close(); }
  });
});

function automaticSetupFixture(options: { foreignMx?: boolean; foreignRoute?: boolean; foreignRecipient?: boolean; dnsFailure?: boolean; routeFailure?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  const records: any[] = options.foreignMx ? [{ id: 'c'.repeat(32), type: 'MX', name: 'example.com', content: 'mx.other.example', priority: 10 }] : [];
  let route: any = { enabled: Boolean(options.foreignRoute), actions: [{ type: 'forward', value: ['existing@example.com'] }] };
  const rules: any[] = options.foreignRecipient ? [{ id: 'd'.repeat(32), name: 'Existing delivery', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'old@example.com' }], actions: [{ type: 'forward', value: ['old@example.com'] }] }] : [];
  const directory: { path: string; body: any }[] = [];
  let sending = false;
  let routingEnabled = false;
  const provider = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.endsWith('/email/routing/rules')) return response(rules);
    if (method === 'PUT' && url.pathname.endsWith(`/rules/${'d'.repeat(32)}`)) { rules[0] = { ...rules[0], ...body }; return response(rules[0]); }
    if (method === 'DELETE' && url.pathname.includes('/dns_records/')) { expect(JSON.stringify(db.prepare("SELECT * FROM mail_objects WHERE type='PrivateConfig'").all())).toContain('mx.other.example'); const index = records.findIndex(record => url.pathname.endsWith(record.id)); if (index >= 0) records.splice(index, 1); return response({}); }
    if (url.pathname.endsWith('/email/routing')) return response({ enabled: routingEnabled });
    if (url.pathname.endsWith(`/email/sending/subdomains/${sendingId}`)) return response({ name: 'example.com', enabled: sending });
    if (url.pathname.endsWith('/rules/catch_all')) {
      if (method === 'PUT') { if (options.routeFailure) return new Response('', { status: 503 }); route = body; }
      return response(route);
    }
    if (url.pathname.endsWith('/email/sending/subdomains')) {
      if (method === 'POST') sending = true;
      return response(method === 'POST' ? { name: 'example.com', tag: sendingId, enabled: true } : sending ? [{ name: 'example.com', tag: sendingId, enabled: true }] : []);
    }
    if (url.pathname.endsWith(`/subdomains/${sendingId}/dns`)) return response([{ type: 'TXT', name: 'cf._domainkey.example.com', content: 'v=DKIM1; p=fixture' }]);
    if (url.pathname.endsWith('/email/routing/dns')) { if (method === 'POST') { expect(init?.body).toBeUndefined(); expect(new Headers(init?.headers).has('Content-Type')).toBe(false); routingEnabled = true; return response({ enabled: true }); } return response( [{ type: 'MX', name: 'example.com', content: 'mx.cloudflare.net', priority: 10 }, { type: 'TXT', name: 'example.com', content: 'v=spf1 ip4:192.0.2.1 -all' }]); }
    if (url.pathname.endsWith('/dns_records')) {
      if (method === 'POST') { if (options.dnsFailure) return new Response('', { status: 503 }); records.push({ ...body, id: `dns-${records.length}` }); return response(records.at(-1)); }
      return response(records);
    }
    if (url.pathname === `/client/v4/zones/${zoneId}`) return response({ name: 'example.com' });
    throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', provider);
  const storage = {
    sql: { exec<T>(sql: string, ...bindings: unknown[]): Iterable<T> { const statement = db.prepare(sql); return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[]; } },
    transactionSync<T>(task: () => T): T { db.exec('SAVEPOINT test'); try { const result = task(); db.exec('RELEASE test'); return result; } catch (error) { db.exec('ROLLBACK TO test; RELEASE test'); throw error; } },
    async setAlarm() {}, async deleteAlarm() {},
  };
  const account = new MailAccount({ storage }, { MAIL_BLOBS: { async put() {}, async get() { return null; }, async delete() {} }, CF_API_TOKEN: 'test', MAIL_INGRESS_WORKER: 'enough-mail-ingress', MAIL_DIRECTORY: { idFromName: name => name, get: () => ({ fetch: async (request: Request) => { const path = new URL(request.url).pathname; directory.push({ path, body: await request.json() }); return Response.json(path === '/authorize-zone' ? { allowed: true } : {}); } }) } });
  async function call(name: string, args: any = {}, actions = ['mail.read', 'mail.manage'], workspaceRole = 'owner') {
    const result = await account.fetch(new Request('https://account/jmap', { method: 'POST', body: JSON.stringify({ accountId: 'account', organizationId: 'org', workspaceId: 'workspace', actor: { id: 'owner', actions, workspaceRole }, request: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [[name, { accountId: 'account', ...args }, 'call']] } }) }));
    return (await result.json() as any).methodResponses[0][1];
  }
  async function create() { const result = await call('Domain/set', { create: { domain: { name: 'example.com', zoneId, receivingAddress: 'russell@example.com' } } }); return { domainId: result.created.domain.id, ifInState: result.newState, operationId: crypto.randomUUID() }; }
  return { call, create, provider, records, rules, directory, db, close: () => db.close() };
}

describe('Automatic domain setup', () => {
  it('prepares, adds provider DNS, verifies identities and connects receiving in one idempotent command', async () => {
    const fixture = automaticSetupFixture();
    try {
      const initial = await fixture.create();
      const identity = await fixture.call('Identity/set', { create: { sender: { name: 'Russell', email: 'russell@example.com' } }, ifInState: initial.ifInState });
      const args = { ...initial, ifInState: identity.newState };
      expect((await fixture.call('Identity/get')).list[0].verified).toBe(false);
      const first = await fixture.call('Domain/setup', args);
      expect(first).toMatchObject({ status: 'ready', stage: 'complete', sendingVerified: true, receivingConnected: true });
      expect(fixture.records.map(record => record.type)).toEqual(['MX', 'TXT', 'TXT', 'TXT']);
      expect(fixture.directory.some(entry => entry.path === '/register-address' && entry.body.address === 'russell@example.com')).toBe(true);
      const calls = fixture.provider.mock.calls.length;
      expect(await fixture.call('Domain/setup', args)).toEqual(first);
      expect(fixture.provider).toHaveBeenCalledTimes(calls);
      const current = await fixture.call('Domain/get');
      expect(current.list[0]).toMatchObject({ sendingVerified: true, receivingConnected: true });
      expect((await fixture.call('Identity/get')).list[0].verified).toBe(true);
    } finally { fixture.close(); }
  });
  it.each([{ foreignMx: true }, { foreignRoute: true }, { foreignRecipient: true }])('preserves existing mail and reports a review blocker: %j', async options => {
    const fixture = automaticSetupFixture(options);
    try {
      expect(await fixture.call('Domain/setup', await fixture.create())).toMatchObject({ status: 'blocked', stage: 'review' });
      expect(fixture.provider.mock.calls.filter(([url, init]) => ['PUT', 'PATCH'].includes(init?.method || '') || init?.method === 'POST' && String(url).includes('/dns_records'))).toHaveLength(0);
      expect(fixture.records).toHaveLength(options.foreignMx ? 1 : 0);
    } finally { fixture.close(); }
  });
  it.each([{ dnsFailure: true, stage: 'dns' }, { routeFailure: true, stage: 'receiving' }])('never marks a partial provider operation ready: %j', async ({ stage, ...options }) => {
    const fixture = automaticSetupFixture(options);
    try {
      expect(await fixture.call('Domain/setup', await fixture.create())).toMatchObject({ status: 'pending', stage });
      const current = await fixture.call('Domain/get');
      expect(current.list[0].receivingConnected).not.toBe(true);
      expect(current.list[0].sendingSubdomainId).toBe(sendingId);
    } finally { fixture.close(); }
  });
  it('requires management, workspace administration and the current Domain revision before setup', async () => {
    const fixture = automaticSetupFixture();
    try {
      const args = await fixture.create();
      expect((await fixture.call('Domain/setup', args, ['mail.read'])).type).toBe('forbidden');
      expect((await fixture.call('Domain/setup', { ...args, operationId: crypto.randomUUID() }, undefined, 'member')).type).toBe('forbidden');
      expect((await fixture.call('Domain/setup', { ...args, operationId: crypto.randomUUID(), ifInState: 'stale' })).type).toBe('stateMismatch');
      expect(fixture.provider).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });
});


describe('Provider SPF requirements', () => {
  const mx = { type: 'MX', name: 'example.com', content: 'mx.cloudflare.net', priority: 10 };
  const dkim = { type: 'TXT', name: 'cf._domainkey.example.com', content: 'v=DKIM1; p=fixture' };
  const spf = { type: 'TXT', name: 'example.com', content: 'v=spf1 include:provider.test ~all' };
  it('publishes one policy for combined routing and sending mechanisms', () => {
    const plan = planDomainDns('example.com', [], [mx, dkim, spf, spf, { ...spf, content: 'v=spf1 include:second.test ~all' }]);
    const policies = plan.changes.filter(change => change.record.type === 'TXT' && change.record.name === 'example.com');
    expect(policies).toHaveLength(1);
    expect(policies[0].record.content).toBe('v=spf1 include:provider.test include:second.test ~all');
    expect(plan.requirements.filter(record => record.type === 'MX')).toHaveLength(1);
  });
  it('preserves additional legitimate senders without a perpetual update', () => {
    const current = [{ ...mx, id: 'mx' }, { ...dkim, id: 'dkim' }, { ...spf, id: 'spf', content: 'v=spf1 include:_spf.google.com include:provider.test ~all' }, { type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=reject' }];
    expect(planDomainDns('example.com', current, [mx, dkim, spf]).changes).toEqual([]);
  });
});


describe('Routing ownership discovery', () => {
  it('allows a confirmed missing catch-all while keeping permission errors blocking', async () => {
    const missing = vi.fn(async (url: any) => String(url).includes('catch_all') ? new Response('', { status: 404 }) : response([]));
    expect(await inspectDomainRouting({ CF_API_TOKEN: 'test' }, zoneId, 'enough-mail-ingress', missing)).toEqual({ enabled: false, ours: false });
    const denied = vi.fn(async () => new Response('', { status: 403 }));
    await expect(inspectDomainRouting({ CF_API_TOKEN: 'test' }, zoneId, 'enough-mail-ingress', denied)).rejects.toThrow('cloudflareHttp403');
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('clears stale receiving readiness when a foreign route replaces our route', async () => {
    const options = { foreignRoute: false };
    const fixture = automaticSetupFixture(options);
    try {
      const ready = await fixture.call('Domain/setup', await fixture.create());
      expect(ready.status).toBe('ready');
      // Simulate the provider replacing the route outside Mail, then check setup again.
      const actualFetch = fixture.provider.getMockImplementation()!;
      fixture.provider.mockImplementation(async (input: any, init?: RequestInit) => String(input).includes('/rules/catch_all') && (init?.method || 'GET') === 'GET' ? response({ enabled: true, actions: [{ type: 'forward', value: ['other@example.com'] }] }) : actualFetch(input, init));
      const blocked = await fixture.call('Domain/setup', { domainId: ready.domainId, ifInState: ready.newState, operationId: crypto.randomUUID() });
      expect(blocked.status).toBe('blocked');
      expect((await fixture.call('Domain/get')).list[0].receivingConnected).toBe(false);
    } finally { fixture.close(); }
  });
});


describe('Domain setup diagnostics', () => {
  it.each([{ name: 'Error', code: 'providerUnavailable' }, { name: 'TimeoutError', code: 'providerTimeout' }])('returns only bounded diagnostic codes for $name failures', async ({ name, code }) => {
    const fixture = automaticSetupFixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const args = await fixture.create();
      fixture.provider.mockImplementationOnce(async () => { const error = new Error('sensitive-provider-body Authorization: secret'); error.name = name; throw error; });
      const result = await fixture.call('Domain/setup', args);
      expect(result).toMatchObject({ status: 'pending', diagnostics: { stage: 'review', step: 'inspectRouting', code } });
      expect(warning).toHaveBeenCalledWith('Mail domain setup failed', { stage: 'review', step: 'inspectRouting', code });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('secret');
    } finally { warning.mockRestore(); fixture.close(); }
  });
  it('bounds authenticated provider requests to fifteen seconds', async () => {
    const fetcher = vi.fn(async (_input: any, init?: RequestInit) => { expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.signal?.aborted).toBe(false); return response([]); });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await prepareSendingDomain({ CF_API_TOKEN: 'test' }, 'example.com', zoneId, fetcher).catch(() => {});
      expect(fetcher).toHaveBeenCalled();
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally { timeout.mockRestore(); }
  });
});


describe('DNS TXT quoted wire chunks', () => {
  const key = 'A'.repeat(400);
  const records = [
    { type: 'MX', name: 'example.com', content: 'mx.cloudflare.net', priority: 10 },
    { type: 'TXT', name: 'example.com', content: 'v=spf1 ip4:192.0.2.1 -all' },
    { type: 'TXT', name: 'cf-bounce._domainkey.example.com', content: `"v=DKIM1; h=sha256; p=${key}"` },
    { type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=none' },
  ];
  it('recognizes the same DKIM key split across DNS character strings without adding spaces', () => {
    const existing = records.map(record => ({ ...record }));
    existing[2].content = `"v=DKIM1; h=sha256; p=${key.slice(0, 200)}" "${key.slice(200)}"`;
    expect(planDomainDns('example.com', existing, records)).toMatchObject({ conflicts: [], changes: [] });
  });
  it('still blocks a different key and malformed quotation rather than replacing the selector', () => {
    for (const content of [`"v=DKIM1; h=sha256; p=${'B'.repeat(400)}"`, '"v=DKIM1; p=key" unquoted']) {
      const existing = records.map(record => ({ ...record })); existing[2].content = content;
      expect(planDomainDns('example.com', existing, records).conflicts).toContain('Conflicting TXT record at cf-bounce._domainkey.example.com; existing records will not be replaced.');
    }
  });
});


describe('Routing provider diagnostic codes', () => {
  it.each(['enableRoutingDns', 'setCatchAll'] as const)('captures safe numeric codes at %s without returning provider text', async step => {
    const fixture = automaticSetupFixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const args = await fixture.create();
      const original = fixture.provider.getMockImplementation()!;
      fixture.provider.mockImplementation(async (input: any, init?: RequestInit) => {
        const target = step === 'enableRoutingDns' ? String(input).endsWith('/email/routing/dns') && init?.method === 'POST' : String(input).endsWith('/rules/catch_all') && init?.method === 'PUT';
        return target ? Response.json({ success: false, errors: [{ code: 1004, message: 'sensitive provider response' }, { code: 'secret-string' }] }, { status: 422 }) : original(input, init);
      });
      const result = await fixture.call('Domain/setup', args);
      expect(result).toMatchObject({ status: 'pending', diagnostics: { stage: 'receiving', step, code: 'cloudflareHttp422', providerCodes: [1004] } });
      expect(JSON.stringify(result)).not.toContain('sensitive');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive');
    } finally { warning.mockRestore(); fixture.close(); }
  });
});


describe('Reviewed domain replacement', () => {
  it('requires an exact reviewed snapshot, retains previous delivery and applies once', async () => {
    const fixture = automaticSetupFixture({ foreignMx: true, foreignRoute: true, foreignRecipient: true });
    try {
      const initial = await fixture.create();
      const review = await fixture.call('Domain/setup', { ...initial, reviewOnly: true });
      expect(review.status).toBe('review');
      expect(review.proposal.removeRecords).toHaveLength(1);
      expect(review.proposal.disableRules).toHaveLength(1);
      expect(review.proposal.blockers).toEqual([]);
      expect(fixture.provider.mock.calls.some(([,init]) => ['DELETE','PUT','PATCH'].includes(init?.method || ''))).toBe(false);
      const args = { domainId: initial.domainId, ifInState: review.newState, operationId: crypto.randomUUID(), reviewedProposal: review.proposal };
      const result = await fixture.call('Domain/setup', args);
      expect(result.status).toBe('ready');
      expect(result.recoveryId).toMatch(/^domain-setup:/);
      expect(fixture.rules[0]).toMatchObject({ name: 'Existing delivery', enabled: false, matchers: [{ value: 'old@example.com' }] });
      expect(fixture.records.some(record => record.content === 'mx.other.example')).toBe(false);
      const calls = fixture.provider.mock.calls.length;
      expect(await fixture.call('Domain/setup', args)).toEqual(result);
      expect(fixture.provider).toHaveBeenCalledTimes(calls);
      const persisted = JSON.stringify(fixture.db.prepare("SELECT * FROM mail_objects WHERE type='PrivateConfig'").all());
      expect(persisted).toContain('mx.other.example');
      expect(persisted).toContain('existing@example.com');
    } finally { fixture.close(); }
  });
  it('retains a recovery journal when a reviewed deletion succeeds but a later DNS write is uncertain', async () => {
    const fixture = automaticSetupFixture({ foreignMx: true, dnsFailure: true });
    try {
      const initial = await fixture.create();
      const review = await fixture.call('Domain/setup', { ...initial, reviewOnly: true });
      const result = await fixture.call('Domain/setup', { domainId: initial.domainId, ifInState: review.newState, operationId: crypto.randomUUID(), reviewedProposal: review.proposal });
      expect(result.status).toBe('pending');
      expect(result.recoveryId).toBeTruthy();
      const persisted = JSON.stringify(fixture.db.prepare("SELECT * FROM mail_objects WHERE type='PrivateConfig'").all());
      expect(persisted).toContain('mx.other.example');
      expect(persisted).toContain('remove-dns:');
      expect(persisted).toContain('unknown');
      expect(fixture.provider.mock.calls.some(([url,init]) => String(url).includes('catch_all') && init?.method === 'PUT')).toBe(false);
    } finally { fixture.close(); }
  });
  it('keeps website CNAME conflicts protected even in a reviewed replacement', async () => {
    const fixture = automaticSetupFixture();
    try {
      fixture.records.push({ id: 'e'.repeat(32), type: 'CNAME', name: 'example.com', content: 'website.example.net' });
      const initial = await fixture.create();
      const review = await fixture.call('Domain/setup', { ...initial, reviewOnly: true });
      expect(review.proposal.removeRecords).toEqual([]);
      expect(review.proposal.blockers.length).toBeGreaterThan(0);
      const result = await fixture.call('Domain/setup', { domainId: initial.domainId, ifInState: review.newState, operationId: crypto.randomUUID(), reviewedProposal: review.proposal });
      expect(result).toMatchObject({ status: 'blocked', diagnostics: { code: 'domainReviewBlocked' } });
      expect(fixture.provider.mock.calls.some(([,init]) => ['DELETE','PUT','PATCH'].includes(init?.method || ''))).toBe(false);
    } finally { fixture.close(); }
  });
  it('rejects a changed recipient route and a review from another domain scope', async () => {
    const fixture = automaticSetupFixture({ foreignRecipient: true });
    try {
      const initial = await fixture.create();
      const review = await fixture.call('Domain/setup', { ...initial, reviewOnly: true });
      expect(await fixture.call('Domain/setup', { domainId: initial.domainId, ifInState: review.newState, operationId: crypto.randomUUID(), reviewedProposal: { ...review.proposal, zoneId: 'f'.repeat(32) } })).toMatchObject({ type: 'invalidArguments' });
      fixture.rules[0].matchers[0].value = 'changed@example.com';
      const result = await fixture.call('Domain/setup', { domainId: initial.domainId, ifInState: review.newState, operationId: crypto.randomUUID(), reviewedProposal: review.proposal });
      expect(result).toMatchObject({ status: 'blocked', diagnostics: { code: 'domainReviewStale' } });
      expect(fixture.provider.mock.calls.some(([,init]) => ['DELETE','PUT','PATCH'].includes(init?.method || ''))).toBe(false);
    } finally { fixture.close(); }
  });
  it.each(['ttl', 'content', 'tamper'] as const)('rejects stale or tampered %s before destructive writes', async kind => {
    const fixture = automaticSetupFixture({ foreignMx: true });
    try {
      const initial = await fixture.create();
      const review = await fixture.call('Domain/setup', { ...initial, reviewOnly: true });
      if (kind === 'tamper') review.proposal.removeRecords = [];
      else fixture.records[0][kind] = kind === 'ttl' ? 3600 : 'mx.changed.example';
      const result = await fixture.call('Domain/setup', { domainId: initial.domainId, ifInState: review.newState, operationId: crypto.randomUUID(), reviewedProposal: review.proposal });
      expect(result).toMatchObject({ status: 'blocked', diagnostics: { code: 'domainReviewStale' } });
      expect(fixture.provider.mock.calls.some(([,init]) => ['DELETE','PUT','PATCH'].includes(init?.method || ''))).toBe(false);
    } finally { fixture.close(); }
  });
});
