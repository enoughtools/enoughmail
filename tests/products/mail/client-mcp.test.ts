import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { StandaloneMailAuthority } from '../../../apps/mail/src/server/standalone-authority';
import { MailAccount } from '../../../apps/mail/src/server/account';
import { MailCredentials, credentialHash, type Credential } from '../../../apps/mail/src/server/credentials';
import { handleClientMcp } from '../../../apps/mail/src/server/client-mcp';
import { handlePublicClient } from '../../../apps/mail/src/server/public-client';
import { createMailWorker, type MailEnv } from '../../../apps/mail/src/worker';
import { handleMailOAuth, handleMailOAuthConsent } from '../../../apps/mail/src/server/mcp-oauth';

const databases: DatabaseSync[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });
const accountId = '00000000-0000-4000-8000-000000000001';
const operationId = '00000000-0000-4000-8000-000000000002';
const token = 'emj_' + 'a'.repeat(64);
const origin = 'https://connector.example.com';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
async function fixture(actions = ['mail.read', 'mail.draft', 'mail.organize', 'mail.send']) {
  const db = new DatabaseSync(':memory:'); databases.push(db); let alarm: number | undefined;
  const values = new Map<string, any>(); let tail = Promise.resolve();
  interface MemoryStore { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; list<T>(options: { prefix: string }): Promise<Map<string, T>>; transaction<T>(task: (store: MemoryStore) => Promise<T>): Promise<T>; }
  const memory: MemoryStore = { async get<T>(key: string): Promise<T | undefined> { return structuredClone(values.get(key)); }, async put(key: string, value: unknown) { values.set(key, structuredClone(value)); }, async delete(key: string) { values.delete(key); }, async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); }, async transaction<T>(task: (store: MemoryStore) => Promise<T>): Promise<T> { const run = tail.then(() => task(memory)); tail = run.then(() => {}, () => {}); return run; } };
  const sql = { sql: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> { const statement = db.prepare(query); return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[]; } }, transactionSync<T>(run: () => T): T { db.exec('SAVEPOINT account_commit'); try { const value = run(); db.exec('RELEASE account_commit'); return value; } catch (error) { db.exec('ROLLBACK TO account_commit; RELEASE account_commit'); throw error; } }, async setAlarm(time: number) { alarm = time; }, async deleteAlarm() { alarm = undefined; } };
  const credential: Credential = { id: crypto.randomUUID(), name: 'ChatGPT', accountId, organizationId: 'org', workspaceId: 'workspace', actorId: 'actor', actions, expiresAt: Date.now() + 30 * 86400_000, createdAt: Date.now(), revokedAt: null, version: 1, hash: await credentialHash(token), lease: 'lease', jobId: crypto.randomUUID(), lifecycleGeneration: 0 };
  values.set('credential:' + credential.id, credential); values.set('hash:' + credential.hash, credential.id);
  const workspaceGrants = new Map<string, any>();
  let denied = false; const blobs = new Map<string, Uint8Array>(); const deliveries: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); deliveries.push(body); return body.type === 'verification' ? Response.json({ challenge: body.challenge }) : new Response(null, { status: 200 }); }));
  let account: MailAccount, credentials: MailCredentials;
  const env = { MAIL_MCP_PUBLIC_ORIGIN: origin, MAIL_MCP_WORKSPACE_ORIGIN: 'https://workspace.example.com', MAIL_MCP_REDIRECT_URIS: callback, MAIL_MCP_CALLBACK_ORIGINS: 'https://events.example.com',
    MAIL_CREDENTIALS: { idFromName: (name: string) => name, get: () => credentials },
    MAIL_ACCOUNTS: { idFromName: (name: string) => name, get: (id: unknown) => { if (id !== accountId) throw new Error('Foreign account'); return account; } },
    MAIL_AUTHORITY_SERVICE: { async fetch(request: Request) {
      const path = new URL(request.url).pathname;
      const resource = { id: accountId, name: 'My mail <account>', organizationId: 'org', workspaceId: 'workspace', ownerAppId: 'mail', resourceType: 'mail.account', effectiveActions: denied ? [] : actions };
      if (path === '/api/mail-client-grants') { const body = await request.json() as any; const lease = crypto.randomUUID(); workspaceGrants.set(lease, body); return Response.json({ lease, context: { actorId: 'actor', organizationId: 'org', workspaceId: 'workspace' } }); }
      if (path.startsWith('/internal/mail-client-grants/')) { const body = await request.json() as any, grant = workspaceGrants.get(body.lease); if (!grant || denied) return Response.json({}, { status: 403 }); return Response.json({ context: { actorId: 'actor', organizationId: 'org', workspaceId: 'workspace' }, actions: grant.actions, expiresAt: grant.expiresAt }); }
      if (path === '/api/native-resources') return Response.json({ resources: [resource] });
      if (path.endsWith('/authorize')) return Response.json({ allowed: !denied, effectiveActions: resource.effectiveActions });
      if (path.endsWith('/lease')) return Response.json({ lease: 'lease' });
      if (path === '/api/native-resources/' + accountId) return Response.json({ resource });
      return Response.json({ authorization: { allowed: !denied, effectiveActions: denied ? [] : actions }, resource: { id: accountId, ownerAppId: 'mail', resourceType: 'mail.account' }, context: { actorId: 'actor', organizationId: 'org', workspaceId: 'workspace' } }); } },
    MAIL_BLOBS: { async put(key: string, value: any) { blobs.set(key, value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : new Uint8Array(value)); }, async get(key: string, options?: {range?:{offset:number;length:number}}) { const bytes = blobs.get(key); const part=bytes&&(options?.range?bytes.slice(options.range.offset,options.range.offset+options.range.length):bytes); return part ? { size: bytes!.length, body: new Response(part.slice()).body!, arrayBuffer: async () => part.slice().buffer } : null; }, async delete(key: string) { blobs.delete(key); } } };
  credentials = new MailCredentials({ storage: memory }, env);
  account = new MailAccount({ storage: sql }, env);
  const context = { accountId, organizationId: 'org', workspaceId: 'workspace', actor: { id: 'actor', actions } };
  const rpc = async (method: string, params: unknown = {}, bearer = token) => {
    const response = await handleClientMcp(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), env);
    return { response, body: await response.json() as any };
  };
  const internal = async (path: string, body: unknown) => account.fetch(new Request('https://mail-account.internal' + path, { method: 'POST', headers: { 'X-Mail-Account-Context': JSON.stringify(context) }, body: JSON.stringify(body) }));
  const store = async (path: string, body: unknown) => credentials.fetch(new Request('https://mail-credentials.internal' + path, { method: 'POST', body: JSON.stringify(body) }));
  return { env, credential, values, rpc, internal, store, db, blobs, deliveries, context, deny: () => { denied = true; }, restart: () => { account = new MailAccount({ storage: sql }, env); }, alarm: async () => account.alarm(), get scheduledAlarm() { return alarm; } };
}

async function workspaceFixture(scopes = ['mail.read', 'mail.draft']) {
  const f = await fixture();
  const authorityValues = new Map<string, any>();
  const authorityStorage = {
    async get<T>(key: string): Promise<T | undefined> { return structuredClone(authorityValues.get(key)); },
    async put(key: string, value: unknown) { authorityValues.set(key, structuredClone(value)); },
    async delete(key: string) { return authorityValues.delete(key); },
    async transaction<T>(task: (storage: any) => Promise<T>): Promise<T> { return task(this); },
  };
  const admission = { AUTH_PROVIDER: 'cloudflare-access', MAIL_OWNER_SUBJECT: 'actor', MAIL_MEMBER_SUBJECTS: '["member"]' };
  const authority = new StandaloneMailAuthority({ storage: authorityStorage }, admission);
  f.env.MAIL_AUTHORITY_SERVICE.fetch = async (request: Request) => {
    const headers = new Headers(request.headers); headers.set('X-Mail-Verified-Principal', JSON.stringify({ id: 'actor', provider: 'cloudflare-access' }));
    return authority.fetch(new Request(request, { headers }));
  };
  const nativeGet = f.env.MAIL_ACCOUNTS.get;
  const extraAccounts = new Map<string, MailAccount>();
  f.env.MAIL_ACCOUNTS.get = (id: unknown) => id === accountId ? nativeGet(id) : extraAccounts.get(String(id))!;
  const add = (id: string, name: string, shared = false) => {
    authorityValues.set('account:' + id, { id, name, ownerAppId: 'mail', resourceType: 'mail.account', ownerActorId: shared ? 'member' : 'actor', organizationId: 'enough-mail', workspaceId: 'standalone', version: 1, createdAt: new Date().toISOString(), effectiveActions: [], grants: shared ? [{ actorId: 'actor', actions: ['mail.read'] }] : [] });
    authorityValues.set('account-ids', [...(authorityValues.get('account-ids') ?? []), id]);
    if (id !== accountId) {
      const db = new DatabaseSync(':memory:'); databases.push(db);
      const storage = { sql: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> { const statement = db.prepare(query); return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[]; } }, transactionSync<T>(task: () => T): T { db.exec('SAVEPOINT commit_account'); try { const value = task(); db.exec('RELEASE commit_account'); return value; } catch (error) { db.exec('ROLLBACK TO commit_account; RELEASE commit_account'); throw error; } }, async setAlarm() {}, async deleteAlarm() {} };
      extraAccounts.set(id, new MailAccount({ storage }, f.env));
    }
  };
  add(accountId, 'Personal'); const sharedId = crypto.randomUUID(); add(sharedId, 'Shared', true);
  const context = { accountId: 'private-workspace-account', actorId: 'actor', organizationId: 'enough-mail', workspaceId: 'standalone' };
  const verifier = 'p'.repeat(43), challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const params = new URLSearchParams({ client_id: 'enoughmail-chatgpt', redirect_uri: callback, response_type: 'code', scope: scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/mcp', operationId: crypto.randomUUID(), approve: 'yes' });
  const approved = await handleMailOAuthConsent(new Request('https://workspace.example.com/apps/mail/api/mcp/authorize', { method: 'POST', headers: { Origin: 'https://workspace.example.com' }, body: params.toString() }), f.env, context);
  expect(approved.status, await approved.clone().text()).toBe(302);
  const code = new URL(approved.headers.get('Location')!).searchParams.get('code');
  const exchange = await f.store('/oauth-exchange', { code, verifier, clientId: 'enoughmail-chatgpt', redirectUri: callback, resource: origin + '/mcp' });
  expect(exchange.status).toBe(200); const { access_token } = await exchange.json() as any;
  const root = [...f.values.values()].find(value => value.scope === 'workspace') as Credential;
  const rpc = (method: string, params: unknown = {}) => f.rpc(method, params, access_token);
  return { ...f, root, rpc, access_token, context, sharedId, add, authorityValues, admission };
}

describe('standalone Mail MCP and Core command adapter', () => {
  it('discovers authorized tools and events and negotiates MCP 2.0', async () => {
    const f = await fixture(['mail.read']);
    expect((await f.rpc('server/discover')).body.result).toMatchObject({ supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } });
    const initialized = await f.rpc('initialize', { protocolVersion: '2026-07-28' }); expect(initialized.body.result.instructions).toContain(accountId);
    const tools = (await f.rpc('tools/list')).body.result.tools;
    expect(tools.some((tool: any) => tool.name === 'mail_get_email')).toBe(true);
    expect(tools.some((tool: any) => tool.name === 'mail_send_email')).toBe(false);
    expect(tools[0].securitySchemes).toEqual([{ type: 'oauth2', scopes: ['mail.read'] }]);
    expect((await f.rpc('events/list')).body.result.events[0].name).toBe('mail.email.received');
    expect((await f.rpc('initialize', { protocolVersion: '2025-03-26' })).body.result.capabilities.events).toBeUndefined();
  });
  it('uses real account commands, revisions and receipts for drafts', async () => {
    const f = await fixture();
    const create = { name: 'mail_create_draft', arguments: { resourceId: accountId, operationId, expectedSequence: 0, emailJson: JSON.stringify({ subject: 'Hello Sherman', from: [{ email: 'me@example.com' }], to: [{ email: 'you@example.com' }], textBody: [{partId:'body',type:'text/plain'}], bodyValues: {body:{value:'Message body'}} }) } };
    const first = await f.rpc('tools/call', create); expect(first.body.result.isError, JSON.stringify(first.body)).not.toBe(true);
    const result = JSON.parse(first.body.result.content[0].text); expect(result.methodResponses[0][1].notCreated).toEqual({}); expect(result.methodResponses[0][1]).toHaveProperty('created.draft'); expect(result.methodResponses[0][1].created.draft.id).toEqual(expect.any(String));
    const replay = await f.rpc('tools/call', create); expect(replay.body.result).toEqual(first.body.result);
    expect(f.db.prepare("SELECT count(*) n FROM mail_objects WHERE type='Email'").get()?.n).toBe(1);
  });
  it('rejects another account, unauthorized writes and caller identity overrides', async () => {
    const f = await fixture(['mail.read']);
    expect((await f.rpc('tools/call', { name: 'mail_get_email', arguments: { resourceId: crypto.randomUUID(), emailId: 'e' } })).body.result.isError).toBe(true);
    expect((await f.rpc('tools/call', { name: 'mail_get_email', arguments: { resourceId: accountId, emailId: 'e', actor: 'other' } })).body.result.isError).toBe(true);
    expect((await f.rpc('tools/call', { name: 'mail_create_draft', arguments: {} })).body.error.code).toBe(-32602);
    f.deny(); expect((await f.rpc('tools/list')).response.status).toBe(403);
  });
  it('records registration outcomes without logging callback secrets or mail filters', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const f = await fixture();
      const params = { name: 'mail.email.received', arguments: { resourceId: accountId, subject: 'private subject' }, delivery: { mode: 'webhook', url: 'https://events.example.com/private-callback?token=callback-secret', secret: 'whsec_' + Buffer.alloc(32, 8).toString('base64') }, cursor: null };
      expect((await f.rpc('events/subscribe', params)).body.result.id).toEqual(expect.any(String));
      expect(info).toHaveBeenCalledWith('EnoughMail event registration', expect.objectContaining({ stage: 'received', callbackOrigin: 'https://events.example.com' }));
      expect(info).toHaveBeenCalledWith('EnoughMail event registration', expect.objectContaining({ stage: 'accepted' }));
      params.delivery.url = 'https://unconfigured.example.com/private-callback?token=callback-secret';
      expect((await f.rpc('events/subscribe', params)).body.error.data.reason).toBe('destination_not_allowed');
      expect(info).toHaveBeenCalledWith('EnoughMail event registration', expect.objectContaining({ stage: 'rejected', code: -32015, reason: 'destination_not_allowed' }));
      const logged = JSON.stringify(info.mock.calls);
      for (const value of [params.delivery.secret, 'callback-secret', 'private-callback', 'private subject', accountId, token]) expect(logged).not.toContain(value);
    } finally { info.mockRestore(); }
  });
  it('emits SMTP arrivals once, persists pending deliveries across restart and ignores drafts/imports', async () => {
    const f = await fixture(); const params = { name: 'mail.email.received', arguments: { resourceId: accountId }, delivery: { mode: 'webhook', url: 'https://events.example.com/webhook', secret: 'whsec_' + Buffer.alloc(32, 8).toString('base64') }, cursor: null };
    expect((await f.rpc('events/subscribe', params)).body.result.id).toEqual(expect.any(String));
    f.blobs.set(accountId + '/blobs/incoming', new TextEncoder().encode('From: person@example.com\r\nTo: me@example.com\r\nSubject: New message\r\nContent-Type: text/plain\r\n\r\nHello'));
    const incoming = { blobId: 'incoming', deliveryId: 'smtp-1', from: 'person@example.com', to: 'me@example.com', receivedAt: new Date().toISOString() };
    const headers = { 'X-Mail-Account-Context': JSON.stringify({ ...f.context, actor: { id: 'recipient:me@example.com', actions: ['mail.ingest'] } }) };
    const ingest = () => f.env.MAIL_ACCOUNTS.get(accountId).fetch(new Request('https://account/ingest', { method: 'POST', headers, body: JSON.stringify(incoming) }));
    const ingested=await ingest();expect(ingested.status,await ingested.text()).toBe(200); expect((await (await ingest()).json() as any).replayed).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(1); expect(f.scheduledAlarm).toEqual(expect.any(Number));
    f.restart(); await f.alarm(); expect(f.deliveries.filter(event => !event.type)).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(0);
    await f.rpc('tools/call', { name: 'mail_create_draft', arguments: { resourceId: accountId, operationId, expectedSequence: Number.parseInt((await f.rpc('tools/call', { name: 'mail_get_mailboxes', arguments: { resourceId: accountId } })).body.result.content[0].text.match(/"state":"m([0-9a-z]+)"/)[1], 36), emailJson: JSON.stringify({ subject: 'draft', textBody:[{partId:'body',type:'text/plain'}],bodyValues:{body:{value:'draft'}} }) } });
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(0);
  });
  it('exposes only the MCP and OAuth routes through the public companion', async () => {
    const f = await fixture();
    expect((await handlePublicClient(new Request(origin + '/api/credentials'), f.env)).status).toBe(404);
    const unauthorized = await handlePublicClient(new Request(origin + '/mcp', { method: 'POST' }), f.env); expect(unauthorized.status).toBe(401); expect(unauthorized.headers.get('WWW-Authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    const response = await handlePublicClient(new Request(origin + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list' }) }), f.env);
    expect(response.status).toBe(200); expect((await response.json() as any).result.events).toHaveLength(1);
  });
});

describe('EnoughMail OAuth linking', () => {
  async function authFixture() {
    const f = await fixture(['mail.read']); const verifier = 'p'.repeat(43); const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))); const challenge = Buffer.from(hash).toString('base64url');
    const grant = { context: { accountId, organizationId: 'org', workspaceId: 'workspace', actorId: 'actor' }, credentialId: f.credential.id, credentialVersion: 1, clientId: 'enoughmail-chatgpt', redirectUri: callback, resource: origin + '/mcp', challenge, actions: ['mail.read'] };
    return { ...f, verifier, challenge, grant };
  }
  it('publishes audience and PKCE metadata and routes consent to private Mail', async () => {
    const f = await authFixture();
    const metadata = await handleMailOAuth(new Request(origin + '/.well-known/oauth-authorization-server'), f.env); expect(await metadata.json()).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true });
    const params = new URLSearchParams({ client_id: 'enoughmail-chatgpt', redirect_uri: callback, response_type: 'code', scope: 'mail.read', state: 'state', ui_locales: 'en-US', code_challenge: f.challenge, code_challenge_method: 'S256', resource: origin + '/mcp' });
    const response = await handleMailOAuth(new Request(origin + '/oauth/authorize?' + params), f.env); expect(response.status).toBe(302); expect(response.headers.get('Location')).toContain('https://workspace.example.com/apps/mail/api/mcp/authorize?');
    params.set('redirect_uri', 'https://evil.example/callback'); expect((await handleMailOAuth(new Request(origin + '/oauth/authorize?' + params), f.env)).status).toBe(400);
  });
  it('exchanges a single-use PKCE code and accepts its token only for MCP', async () => {
    const f = await authFixture(); const { code } = await (await f.store('/oauth-create-code', f.grant)).json() as any;
    const exchange = { code, verifier: f.verifier, clientId: f.grant.clientId, redirectUri: callback, resource: origin + '/mcp' };
    expect((await f.store('/oauth-exchange', { ...exchange, verifier: 'q'.repeat(43) })).status).toBe(400);
    expect((await f.store('/oauth-exchange', { ...exchange, resource: origin + '/jmap' })).status).toBe(400);
    const { access_token } = await (await f.store('/oauth-exchange', exchange)).json() as any;
    expect(access_token).toMatch(/^emj_[a-f0-9]{64}$/); expect((await f.rpc('tools/list', {}, access_token)).response.status).toBe(200);
    await expect((await f.store('/lookup', { hash: await credentialHash(access_token) })).json()).resolves.toEqual({ credential: null });
    expect((await f.store('/oauth-exchange', exchange)).status).toBe(400);
    const stored = f.values.get('credential:' + f.credential.id); stored.revokedAt = Date.now(); stored.version++;
    expect((await f.rpc('tools/list', {}, access_token)).response.status).toBe(401);
  });
  it('renders consent, issues a workspace grant and links through the public token endpoint', async () => {
    const f = await authFixture();
    const params = new URLSearchParams({ client_id: 'enoughmail-chatgpt', redirect_uri: callback, response_type: 'code', scope: 'mail.read', state: '<state>', ui_locales: 'en-US', code_challenge: f.challenge, code_challenge_method: 'S256', resource: origin + '/mcp' });
    const url = 'https://workspace.example.com/apps/mail/api/mcp/authorize';
    const context = { accountId: 'private-workspace-account', actorId: 'actor', organizationId: 'org', workspaceId: 'workspace' };
    const page = await handleMailOAuthConsent(new Request(url + '?' + params), f.env, context);
    expect(page.headers.get('Content-Security-Policy')).toBe(`default-src 'none'; form-action 'self' ${new URL(callback).origin}${new URL(callback).pathname}; frame-ancestors 'none'; base-uri 'none'`);
    const html = await page.text(); expect(html).toContain('My mail &lt;account&gt;'); expect(html).toContain('&lt;state&gt;');
    expect(html).toContain('All accessible accounts'); expect(html).not.toContain('<select');
    params.set('operationId', crypto.randomUUID()); params.set('approve', 'yes');
    const worker = createMailWorker(async () => ({ id: 'actor', provider: 'cloudflare-access', email: 'actor@example.test', displayName: 'Actor' }));
    const workerEnv: MailEnv = { ...f.env, AUTH_PROVIDER: 'cloudflare-access', MAIL_DIRECTORY: f.env.MAIL_ACCOUNTS,
      ASSETS: { async fetch() { throw new Error('Unexpected asset request'); } },
      MAIL_AUTHORITY_SERVICE: { async fetch(request: Request) {
        if (new URL(request.url).pathname === '/api/workspace') return Response.json({ organizationId: 'org', workspaceId: 'workspace', actor: { id: 'actor', kind: 'user' }, membership: { status: 'active', role: 'member', version: 1 } });
        return f.env.MAIL_AUTHORITY_SERVICE.fetch(request);
      } },
    };
    const approval = await worker.fetch(new Request(url, { method: 'POST', headers: { Origin: 'https://workspace.example.com', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }), workerEnv);
    expect(approval.status).toBe(302);
    const redirect = new URL(approval.headers.get('Location')!); expect(redirect.searchParams.get('state')).toBe('<state>'); expect(redirect.searchParams.get('iss')).toBe(origin);
    const exchanged = await handleMailOAuth(new Request(origin + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'enoughmail-chatgpt', redirect_uri: callback, resource: origin + '/mcp', code: redirect.searchParams.get('code')!, code_verifier: f.verifier }) }), f.env);
    expect(exchanged.status).toBe(200); const value = await exchanged.json() as any;
    expect((await f.rpc('tools/list', {}, value.access_token)).response.status).toBe(200);
  });
  it('rejects consent outside the verified workspace and cross-origin approval', async () => {
    const f = await authFixture(); const params = new URLSearchParams({ client_id: 'enoughmail-chatgpt', redirect_uri: callback, response_type: 'code', scope: 'mail.read', code_challenge: f.challenge, code_challenge_method: 'S256', resource: origin + '/mcp', approve: 'yes' });
    const response = await handleMailOAuthConsent(new Request('https://workspace.example.com/apps/mail/api/mcp/authorize', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: params.toString() }), f.env, { accountId, actorId: 'actor', organizationId: 'org', workspaceId: 'workspace' }); expect(response.status).toBe(403);
  });
});

describe('workspace Mail MCP connection', () => {
  it('discovers all current and future accounts and enforces each account permission', async () => {
    const f = await workspaceFixture();
    expect((await f.rpc('initialize', { protocolVersion: '2026-07-28' })).body.result.instructions).toContain('mail_list_accounts');
    const list = async () => JSON.parse((await f.rpc('tools/call', { name: 'mail_list_accounts', arguments: {} })).body.result.content[0].text).accounts;
    expect(await list()).toEqual([{ id: accountId, name: 'Personal', actions: ['mail.read', 'mail.draft'] }, { id: f.sharedId, name: 'Shared', actions: ['mail.read'] }]);
    for (const resourceId of [accountId, f.sharedId]) expect((await f.rpc('tools/call', { name: 'mail_get_mailboxes', arguments: { resourceId } })).body.result.isError).not.toBe(true);
    const draft = (resourceId: string) => f.rpc('tools/call', { name: 'mail_create_draft', arguments: { resourceId, operationId: crypto.randomUUID(), expectedSequence: 0, emailJson: JSON.stringify({ subject: 'draft', textBody: [{partId:'body',type:'text/plain'}], bodyValues:{body:{value:'draft'}} }) } });
    expect((await draft(f.sharedId)).body.result.isError).toBe(true); expect((await draft(accountId)).body.result.isError).not.toBe(true);
    expect((await f.rpc('tools/call', { name: 'mail_get_email', arguments: { resourceId: crypto.randomUUID(), emailId: 'e' } })).body.result.isError).toBe(true);
    const future = crypto.randomUUID(); f.add(future, 'New account');
    expect((await list()).map((value: any) => value.id)).toContain(future);
    const shared = f.authorityValues.get('account:' + f.sharedId); shared.grants = []; f.authorityValues.set('account:' + f.sharedId, shared);
    expect((await list()).map((value: any) => value.id)).not.toContain(f.sharedId);
    expect((await f.rpc('tools/call', { name: 'mail_get_mailboxes', arguments: { resourceId: f.sharedId } })).body.result.isError).toBe(true);
    expect((await f.rpc('tools/call', { name: 'mail_get_mailboxes', arguments: { resourceId: accountId } })).body.result.isError).not.toBe(true);
    expect((await f.store('/lookup', { hash: await credentialHash(f.access_token) })).status).toBe(200);
    expect((await (await f.store('/lookup', { hash: await credentialHash(f.access_token) })).json() as any).credential).toBeNull();
    f.admission.MAIL_OWNER_SUBJECT = ''; expect((await f.rpc('tools/list')).response.status).toBe(403);
  });
  it('validates delayed sending against the exact account and the current workspace connection', async () => {
    const f = await workspaceFixture(['mail.read', 'mail.send']);
    await f.rpc('tools/call', { name: 'mail_get_mailboxes', arguments: { resourceId: accountId } });
    const job = { id: f.root.id, version: 1, accountId, actorId: 'actor', organizationId: 'enough-mail', workspaceId: 'standalone' };
    expect((await (await f.store('/validate-job', job)).json() as any).allowed).toBe(true);
    expect((await (await f.store('/validate-job', { ...job, accountId: f.sharedId })).json() as any).allowed).toBe(false);
    expect((await (await f.store('/validate-job', { ...job, actorId: 'other' })).json() as any).allowed).toBe(false);
    await f.store('/revoke', { context: f.context, id: f.root.id, expectedVersion: 1, operationId: crypto.randomUUID() });
    expect((await (await f.store('/validate-job', job)).json() as any).allowed).toBe(false);
  });
  it('keeps per-account subscriptions stable and cancels deliveries when the connection is revoked', async () => {
    const f = await workspaceFixture();
    const params = { name: 'mail.email.received', arguments: { resourceId: accountId }, delivery: { mode: 'webhook', url: 'https://events.example.com/webhook', secret: 'whsec_' + Buffer.alloc(32, 8).toString('base64') }, cursor: null };
    const sub = (await f.rpc('events/subscribe', params)).body.result; expect(sub.id).toEqual(expect.any(String));
    expect((await f.rpc('events/subscribe', params)).body.result.id).toBe(sub.id);
    const stored = JSON.parse(String(f.db.prepare('SELECT json FROM mail_mcp_subscriptions').get()?.json));
    const selected = await (await f.store('/lookup-id', { id: f.root.id, version: 1, accountId })).json() as any;
    expect(selected.credential.lease).toBe(stored.proof.lease); expect(selected.credential.accountId).toBe(accountId);
    expect((await (await f.store('/validate-job', { id: f.root.id, version: 1, accountId, actorId: 'actor', organizationId: 'enough-mail', workspaceId: 'standalone' })).json() as any).allowed).toBe(false);
    f.blobs.set(accountId + '/blobs/workspace-incoming', new TextEncoder().encode('From: person@example.com\r\nTo: me@example.com\r\nSubject: Workspace event\r\nContent-Type: text/plain\r\n\r\nHello'));
    const ingested = await f.env.MAIL_ACCOUNTS.get(accountId).fetch(new Request('https://mail-account.internal/ingest', { method: 'POST', headers: { 'X-Mail-Account-Context': JSON.stringify({ accountId, organizationId: 'enough-mail', workspaceId: 'standalone', actor: { id: 'recipient:me@example.com', actions: ['mail.ingest'] } }) }, body: JSON.stringify({ blobId: 'workspace-incoming', deliveryId: 'workspace-smtp-1', from: 'person@example.com', to: 'me@example.com', receivedAt: new Date().toISOString() }) }));
    expect(ingested.status, await ingested.clone().text()).toBe(200);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(1);
    await f.alarm(); expect(f.deliveries.filter(value => !value.type)).toHaveLength(1);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(0);
    const payload = f.deliveries.find(value => !value.type);
    f.db.prepare('INSERT INTO mail_mcp_outbox(id,subscription_id,body) VALUES(?,?,?)').run('event-after-revocation', sub.id, JSON.stringify({ ...payload, eventId: 'event-after-revocation' }));
    expect((await f.store('/revoke', { context: f.context, id: f.root.id, expectedVersion: 1, operationId: crypto.randomUUID() })).status).toBe(200);
    expect((await f.rpc('tools/list')).response.status).toBe(401);
    await f.alarm(); expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_subscriptions').get()?.n).toBe(0); expect(f.deliveries.filter(value => !value.type)).toHaveLength(1);
  });
});
