import { describe, expect, it } from 'vitest';
import { StandaloneMailAuthority } from '../apps/mail/src/server/standalone-authority';
import { mailAuthority } from '../apps/mail/src/server/authority';
import { createMailWorker } from '../apps/mail/src/worker';
import type { DirectoryStorage } from '../apps/mail/src/server/directory';

class MemoryStorage implements DirectoryStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
  async transaction<T>(callback: (storage: DirectoryStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values);
    try { return await callback(this); } catch (error) { this.values = before; throw error; }
  }
}
function fixture() {
  const storage = new MemoryStorage();
  const env = { AUTH_PROVIDER: 'cloudflare-access', MAIL_OWNER_SUBJECT: 'owner', MAIL_MEMBER_SUBJECTS: '["member"]' };
  let service = new StandaloneMailAuthority({ storage }, env);
  const call = (path: string, method = 'GET', body?: unknown, actor = 'owner', provider = 'cloudflare-access') => service.fetch(new Request('https://authority' + path, { method, headers: { 'X-Mail-Verified-Principal': JSON.stringify({ id: actor, provider }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const create = async (actor = 'owner', operationId = crypto.randomUUID(), name = 'Inbox') => call('/api/native-resources', 'POST', { operationId, ownerAppId: 'mail', resourceType: 'mail.account', name }, actor);
  return { storage, env, call, create, service: { fetch: (request: Request) => service.fetch(request) }, restart() { service = new StandaloneMailAuthority({ storage }, env); } };
}
describe('Mail standalone private authority', () => {
  it('requires explicit admission and the configured verified identity provider', async () => {
    const f = fixture();
    expect((await f.call('/api/workspace', 'GET', undefined, 'stranger')).status).toBe(403);
    expect((await f.call('/api/workspace', 'GET', undefined, 'owner', 'local')).status).toBe(403);
    expect((await f.service.fetch(new Request('https://authority/api/workspace'))).status).toBe(403);
    const workspace = await (await f.call('/api/workspace')).json();
    expect(workspace.membership.role).toBe('owner');
    expect((await (await f.call('/api/workspace', 'GET', undefined, 'member')).json()).membership.role).toBe('member');
    f.env.MAIL_OWNER_SUBJECT = '';
    expect((await f.call('/api/workspace')).status).toBe(403);
  });
  it('creates durable independent accounts and fences repeated commands', async () => {
    const f = fixture(), operationId = crypto.randomUUID();
    const first = await (await f.create('owner', operationId)).json();
    expect(await (await f.create('owner', operationId)).json()).toEqual(first);
    expect((await f.create('owner', operationId, 'Different')).status).toBe(409);
    await f.create(); f.restart();
    expect((await (await f.call('/api/native-resources')).json()).resources).toHaveLength(2);
    expect((await (await f.call('/api/native-resources', 'GET', undefined, 'member')).json()).resources).toHaveLength(0);
    expect((await f.call(`/api/native-resources/${first.resourceId}`, 'GET', undefined, 'member')).status).toBe(403);
  });
  it('rechecks current grants and admission on leases, including renewal', async () => {
    const f = fixture(), { resourceId: id } = await (await f.create()).json();
    const grant = { operationId: crypto.randomUUID(), expectedVersion: 1, grants: [{ actorId: 'member', actions: ['mail.read'] }] };
    expect((await f.call(`/api/native-resources/${id}/grants`, 'PUT', grant)).status).toBe(200);
    expect((await f.call(`/api/native-resources/${id}/grants`, 'PUT', { ...grant, operationId: crypto.randomUUID() })).status).toBe(409);
    const jobId = crypto.randomUUID(), expiresAt = Date.now() + 60000;
    const { lease } = await (await f.call(`/api/native-resources/${id}/lease`, 'POST', { jobId, actions: ['mail.read'], expiresAt }, 'member')).json();
    const verify = (body: unknown) => f.call(`/internal/native-resources/${id}/revalidate`, 'POST', body, 'stranger');
    expect((await verify({ lease, jobId, actions: ['mail.read'] })).status).toBe(200);
    expect((await verify({ lease, jobId: 'other', actions: ['mail.read'] })).status).toBe(403);
    expect((await verify({ lease, jobId, actions: ['mail.send'] })).status).toBe(403);
    const renewal = { lease, jobId, actions: ['mail.read'], operationId: crypto.randomUUID(), expiresAt: expiresAt + 60000 };
    const renewed = await (await f.call(`/internal/native-resources/${id}/renew`, 'POST', renewal)).json();
    expect(await (await f.call(`/internal/native-resources/${id}/renew`, 'POST', renewal)).json()).toEqual(renewed);
    f.restart(); f.env.MAIL_MEMBER_SUBJECTS = '[]';
    expect((await verify({ lease: renewed.lease, jobId, actions: ['mail.read'] })).status).toBe(403);
    f.env.MAIL_MEMBER_SUBJECTS = '["member"]';
    await f.call(`/api/native-resources/${id}/grants`, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 2, grants: [] });
    expect((await verify({ lease, jobId, actions: ['mail.read'] })).status).toBe(403);
  });
  it('discovers existing and future accounts through a bounded workspace connection', async () => {
    const f = fixture();
    const first = await (await f.create()).json(); await f.create('member');
    const jobId = crypto.randomUUID(), expiresAt = Date.now() + 60000;
    const body = { operationId: crypto.randomUUID(), jobId, expiresAt, actions: ['mail.read'] };
    const grant = await (await f.call('/api/mail-client-grants', 'POST', body)).json();
    expect(await (await f.call('/api/mail-client-grants', 'POST', body)).json()).toEqual(grant);
    expect((await f.call('/api/mail-client-grants', 'POST', { ...body, actions: ['mail.send'] })).status).toBe(409);
    const call = (operation: string, extra = {}) => f.call('/internal/mail-client-grants/' + operation, 'POST', { lease: grant.lease, jobId, ...extra }, 'stranger');
    expect((await (await call('accounts')).json()).resources.map((value: any) => value.id)).toEqual([first.resourceId]);
    const proof = await (await call('account', { accountId: first.resourceId })).json();
    expect(proof.resource.effectiveActions).toEqual(['mail.read']);
    f.restart(); expect((await (await call('account', { accountId: first.resourceId })).json()).lease).toBe(proof.lease);
    const next = await (await f.create()).json();
    expect((await (await call('accounts')).json()).resources.map((value: any) => value.id)).toEqual([first.resourceId, next.resourceId]);
    expect((await f.call(`/internal/native-resources/${first.resourceId}/revalidate`, 'POST', { lease: proof.lease, jobId, actions: ['mail.send'] }, 'stranger')).status).toBe(403);
    expect((await call('revalidate', { jobId: 'wrong' })).status).toBe(403);
    expect((await call('account', { accountId: crypto.randomUUID() })).status).toBe(404);
    f.env.MAIL_OWNER_SUBJECT = '';
    expect((await call('accounts')).status).toBe(403);
  });
  it('losing one account grant does not revoke the other accounts in a workspace connection', async () => {
    const f = fixture(), first = await (await f.create()).json(), second = await (await f.create()).json();
    for (const id of [first.resourceId, second.resourceId]) await f.call(`/api/native-resources/${id}/grants`, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 1, grants: [{ actorId: 'member', actions: ['mail.read'] }] });
    const jobId = crypto.randomUUID();
    const { lease } = await (await f.call('/api/mail-client-grants', 'POST', { operationId: crypto.randomUUID(), jobId, expiresAt: Date.now() + 60000, actions: ['mail.read', 'mail.send'] }, 'member')).json();
    const call = (operation: string, extra = {}) => f.call('/internal/mail-client-grants/' + operation, 'POST', { lease, jobId, ...extra }, 'stranger');
    const proof = await (await call('account', { accountId: first.resourceId })).json(); expect(proof.resource.effectiveActions).toEqual(['mail.read']);
    await f.call(`/api/native-resources/${first.resourceId}/grants`, 'PUT', { operationId: crypto.randomUUID(), expectedVersion: 2, grants: [] });
    expect((await call('account', { accountId: first.resourceId })).status).toBe(403);
    expect((await (await call('accounts')).json()).resources.map((value: any) => value.id)).toEqual([second.resourceId]);
    expect((await f.call(`/internal/native-resources/${first.resourceId}/revalidate`, 'POST', { lease: proof.lease, jobId, actions: ['mail.read'] })).status).toBe(403);
    f.env.MAIL_MEMBER_SUBJECTS = '[]'; expect((await call('revalidate')).status).toBe(403);
  });
  it('serves the web account/session APIs with the standalone provider and no Core', async () => {
    const f = fixture();
    // The trusted composition root adds this header after JWT verification.
    const trusted = { fetch(request: Request) { const headers = new Headers(request.headers); headers.set('X-Mail-Verified-Principal', JSON.stringify({ id: 'owner', provider: 'cloudflare-access' })); return f.service.fetch(new Request(request, { headers })); } };
    const namespace = { idFromName: (name: string) => name, get: () => trusted };
    const unused = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({}) }) };
    const env = { AUTH_PROVIDER: 'local' as const, MAIL_AUTHORITY: namespace, ASSETS: { fetch: async () => new Response('app') }, MAIL_ACCOUNTS: unused, MAIL_DIRECTORY: unused, MAIL_CREDENTIALS: unused };
    const worker = createMailWorker(async () => ({ id: 'owner', provider: 'cloudflare-access', displayName: 'Owner', email: 'owner@example.com' }));
    const request = (path: string, body?: unknown) => worker.fetch(new Request('https://mail.example.com/apps/mail' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env);
    expect((await (await request('/jmap/session')).json()).accounts).toEqual({});
    expect((await request('/api/accounts', { name: 'Personal', operationId: crypto.randomUUID() })).status).toBe(201);
    const session = await (await request('/jmap/session')).json();
    expect(Object.keys(session.accounts)).toHaveLength(1);
    expect(session.workspaceRole).toBe('owner');
    const fallback = { fetch: async () => new Response('core') };
    expect(mailAuthority({ CORE: fallback })).toBe(fallback);
    expect(mailAuthority({ MAIL_AUTHORITY: namespace, CORE: fallback })).toBe(trusted);
  });
});

it('the standalone entry verifies identity and overwrites caller-supplied private principal headers', async () => {
  const { default: standalone } = await import('../apps/mail/src/standalone');
  const storage = new MemoryStorage();
  const authority = new StandaloneMailAuthority({ storage }, { AUTH_PROVIDER: 'local', MAIL_OWNER_SUBJECT: 'local-developer' });
  const unused = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({}) }) };
  const env = { AUTH_PROVIDER: 'local' as const, MAIL_AUTHORITY: { idFromName: (name: string) => name, get: () => authority }, ASSETS: { fetch: async () => new Response('app') }, MAIL_ACCOUNTS: unused, MAIL_DIRECTORY: unused, MAIL_CREDENTIALS: unused };
  const request = (url: string) => new Request(url, { headers: { 'X-Mail-Verified-Principal': JSON.stringify({ id: 'attacker', provider: 'local' }) } });
  const session = await standalone.fetch(request('http://localhost/apps/mail/api/session'), env);
  expect(session.status).toBe(200);
  expect((await session.json()).actorId).toBe('local-developer');
  expect((await standalone.fetch(request('https://mail.example.com/apps/mail/api/session'), env)).status).toBe(401);
  expect((await standalone.fetch(request('http://localhost/internal/mcp'), env)).status).toBe(403);
  expect((await standalone.fetch(request('http://localhost/apps/mail/internal/client-jmap'), env)).status).toBe(403);
});
