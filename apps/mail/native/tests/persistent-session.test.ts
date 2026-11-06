import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNativeSession, issueNativeSession, MailNativeSessions, nativeAppBase, type NativeSessionEnv } from '../auth/sessions';

const principal = { id: 'actor', email: 'owner@example.test', displayName: 'Owner', provider: 'cloudflare-access' };
const scope = { actorId: 'actor', organizationId: 'organization', workspaceId: 'workspace' };
class Storage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { const value = this.values.get(key); return value === undefined ? undefined : structuredClone(value) as T; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async transaction<T>(work: (storage: Storage) => Promise<T>) { return work(this); }
}
function fixture() {
  const rooms = new Map<string, { storage: Storage; object: MailNativeSessions }>();
  const forwarded: Request[] = [];
  let admitted = true, current = { ...scope }, response: () => Response = () => Response.json({ value: '/apps/mail/private-content' });
  const env: NativeSessionEnv = {
    DEPLOYMENT_ORIGIN: 'https://mail.example.test',
    SESSIONS: { idFromName: name => name, get: id => {
      const name = String(id);
      if (!rooms.has(name)) { const storage = new Storage(); rooms.set(name, { storage, object: new MailNativeSessions({ storage } as any) }); }
      return rooms.get(name)!.object;
    } },
    NATIVE_MAIL: { async fetch(request) {
      expect(JSON.parse(request.headers.get('X-Mail-Native-Principal')!)).toEqual(principal);
      if (new URL(request.url).pathname === '/apps/mail/api/session') return Response.json(current, { status: admitted ? 200 : 403 });
      forwarded.push(request); return response();
    } },
  };
  const issue = async () => {
    const grant = await issueNativeSession(env, principal, scope); expect(grant.status).toBe(200);
    return await grant.json() as { token: string; authentication: string };
  };
  const request = (token: string, path = 'api/messages', init: RequestInit = {}) => handleNativeSession(new Request(env.DEPLOYMENT_ORIGIN + nativeAppBase + path, { ...init, headers: { Cookie: 'EnoughMailNativeSession=' + token, ...init.headers } }), env);
  return { env, rooms, forwarded, issue, request, deny() { admitted = false; }, move() { current.workspaceId = 'another-workspace'; }, respond(value: () => Response) { response = value; } };
}
afterEach(() => vi.useRealTimers());
describe('installed-app persistent sessions', () => {
  it('retains the same device grant across years without extending a Cloudflare cookie', async () => {
    vi.useFakeTimers(); const now = Date.now(), f = fixture(), grant = await f.issue();
    vi.setSystemTime(now + 10 * 365 * 86400000);
    expect((await f.request(grant.token)).status).toBe(200);
    expect(grant.authentication).toBe('native-session');
    expect(JSON.stringify([...f.rooms.values()].map(room => [...room.storage.values.values()]))).not.toContain(grant.token);
    expect([...f.rooms.keys()].every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true);
  });
  it('enforces current membership and exact workspace before dispatching mail', async () => {
    const f = fixture(), grant = await f.issue(); f.deny();
    expect((await f.request(grant.token)).status).toBe(403); expect(f.forwarded).toHaveLength(0);
    const moved = fixture(), second = await moved.issue(); moved.move();
    expect((await moved.request(second.token)).status).toBe(403); expect(moved.forwarded).toHaveLength(0);
  });
  it('revokes on sign-out and cannot recreate the same stored grant', async () => {
    const f = fixture(), grant = await f.issue();
    const revoke = () => handleNativeSession(new Request(f.env.DEPLOYMENT_ORIGIN + '/apps/mail/native/revoke', { method: 'POST', headers: { Cookie: 'EnoughMailNativeSession=' + grant.token, Origin: f.env.DEPLOYMENT_ORIGIN } }), f.env);
    expect((await revoke()).status).toBe(200); expect((await revoke()).status).toBe(200);
    expect((await f.request(grant.token)).status).toBe(401);
    const room = [...f.rooms.values()][0];
    const recreated = await room.object.fetch(new Request('https://private/issue', { method: 'POST', body: JSON.stringify({ principal, session: scope, createdAt: Date.now() }) }));
    expect(recreated.status).toBe(409);
  });
  it('rejects missing or duplicated cookies and cross-origin mutations', async () => {
    const f = fixture(), grant = await f.issue();
    expect((await f.request('not-a-token')).status).toBe(401);
    expect((await f.request(grant.token, 'api/send', { method: 'POST', headers: { Origin: 'https://attacker.example.test' } })).status).toBe(403);
    expect((await f.request(grant.token, 'api/messages', { headers: { Cookie: `EnoughMailNativeSession=${grant.token}; EnoughMailNativeSession=${grant.token}` } })).status).toBe(401);
    expect(f.forwarded).toHaveLength(0);
  });
  it('forwards a mutation with the saved identity and never accepts a supplied identity header', async () => {
    const f = fixture(), grant = await f.issue();
    const response = await f.request(grant.token, 'api/send', { method: 'POST', body: '{"operationId":"test"}', headers: { Origin: f.env.DEPLOYMENT_ORIGIN, 'X-Mail-Native-Principal': '{"id":"attacker"}', Authorization: 'Bearer untrusted' } });
    expect(response.status).toBe(200); const request = f.forwarded[0];
    expect(request.url).toBe(f.env.DEPLOYMENT_ORIGIN + '/apps/mail/api/send');
    expect(request.headers.get('Cookie')).toBeNull(); expect(request.headers.get('Authorization')).toBeNull();
    expect(await request.text()).toBe('{"operationId":"test"}');
    expect(await response.json()).toEqual({ value: '/apps/mail/private-content' });
  });
  it('rewrites only app resources while retaining the browser origin and native broker paths', async () => {
    const f = fixture(), grant = await f.issue();
    f.respond(() => new Response('<script src="/apps/mail/assets/app.js"></script><a href="/apps/mail/native/login">Login</a>', { headers: { 'Content-Type': 'text/html', ETag: 'old', 'Set-Cookie': 'CF_Authorization=ignored' } }));
    const response = await f.request(grant.token, '');
    expect(await response.text()).toBe('<script src="/apps/mail/native/app/assets/app.js"></script><a href="/apps/mail/native/login">Login</a>');
    expect(response.headers.get('ETag')).toBeNull(); expect(response.headers.get('Set-Cookie')).toBeNull(); expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('blocks internal and recursive broker paths even with a valid grant', async () => {
    const f = fixture(), grant = await f.issue();
    expect((await f.request(grant.token, 'internal/delete')).status).toBe(404);
    expect((await f.request(grant.token, 'native/login')).status).toBe(404); expect(f.forwarded).toHaveLength(0);
  });
  it('maps discovery endpoints for direct downloads and live updates without rewriting other metadata', async () => {
    const f = fixture(), grant = await f.issue();
    f.respond(() => Response.json({
      ...scope, apiUrl: f.env.DEPLOYMENT_ORIGIN + '/apps/mail/jmap/api',
      downloadUrl: '/apps/mail/jmap/download/{accountId}/{blobId}/{name}?type={type}',
      eventSourceUrl: '/apps/mail/jmap/events?types={types}',
      uploadUrl: 'https://other.example.test/apps/mail/upload',
      username: '/apps/mail/unchanged-metadata',
    }));
    for (const path of ['jmap/session', '.well-known/jmap']) {
      const data = await (await f.request(grant.token, path)).json() as Record<string, string>;
      expect(data.apiUrl).toBe(f.env.DEPLOYMENT_ORIGIN + nativeAppBase + 'jmap/api');
      expect(data.downloadUrl).toBe(nativeAppBase + 'jmap/download/{accountId}/{blobId}/{name}?type={type}');
      expect(data.eventSourceUrl).toBe(nativeAppBase + 'jmap/events?types={types}');
      expect(data.uploadUrl).toBe('https://other.example.test/apps/mail/upload');
      expect(data.username).toBe('/apps/mail/unchanged-metadata');
    }
  });
});

vi.mock('@open-cloud/auth', () => ({ authenticate: vi.fn(async (request: Request) => {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token?.startsWith('eyJ')) throw new Error('No verified provider identity');
  return { id: 'actor', email: 'owner@example.test', displayName: 'Owner', provider: 'cloudflare-access' };
}) }));
import broker, { MailNativeCodes } from '../auth/worker';
class CodeStorage extends Storage {
  async delete(key: string) { return this.values.delete(key); }
  async deleteAll() { this.values.clear(); }
  async setAlarm(_when: number) {}
}
function brokerFixture() {
  const f = fixture(), rooms = new Map<string, MailNativeCodes>();
  const env = { ...f.env, AUTH_PROVIDER: 'cloudflare-access' as const, ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUDIENCE: 'fixture-audience',
    MAIL: { fetch: async () => Response.json(scope) },
    CODES: { idFromName: (name: string) => name, get: (id: unknown) => {
      const name = String(id); if (!rooms.has(name)) rooms.set(name, new MailNativeCodes({ storage: new CodeStorage() } as any)); return rooms.get(name)!;
    } },
  };
  const access = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.provider-verification-is-mocked';
  const base = env.DEPLOYMENT_ORIGIN + '/apps/mail/native';
  const login = async (persistent = true) => {
    const verifier = 'v'.repeat(43), bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = Buffer.from(bytes).toString('base64url');
    const result = await broker.fetch(new Request(`${base}/login?state=${'s'.repeat(43)}&challenge=${challenge}${persistent ? '&persistent=1' : ''}`, { headers: { Cookie: 'CF_Authorization=' + access, 'Cf-Access-Jwt-Assertion': access } }), env);
    expect(result.status).toBe(302); const code = new URL(result.headers.get('Location')!).searchParams.get('code');
    return { verifier, code };
  };
  const exchange = (code: string | null, verifier: string) => broker.fetch(new Request(base + '/exchange', { method: 'POST', body: JSON.stringify({ code, verifier }) }), env);
  return { ...f, env, access, base, login, exchange };
}
describe('browser-to-device persistent handoff', () => {
  it('requires the PKCE proof, issues a device token once, and does not return a provider cookie', async () => {
    const f = brokerFixture(), login = await f.login();
    expect((await f.exchange(login.code, 'x'.repeat(43))).status).toBe(401);
    const response = await f.exchange(login.code, login.verifier), grant = await response.json() as any;
    expect(response.status).toBe(200); expect(grant.authentication).toBe('native-session'); expect(grant.token).toMatch(/^ems_[a-f0-9]{64}$/);
    expect(JSON.stringify(grant)).not.toContain(f.access); expect(grant.principal).toBeUndefined();
    expect((await f.exchange(login.code, login.verifier)).status).toBe(401);
  });
  it('keeps older installed clients on their existing handoff until they are updated', async () => {
    const f = brokerFixture(), login = await f.login(false), grant = await (await f.exchange(login.code, login.verifier)).json() as any;
    expect(grant.token).toBe(f.access); expect(grant.authentication).toBeUndefined(); expect(f.rooms.size).toBe(0);
  });
  it('can upgrade a still-valid saved sign-in without another browser login', async () => {
    const f = brokerFixture();
    const response = await broker.fetch(new Request(f.base + '/upgrade', { method: 'POST', headers: { Cookie: 'CF_Authorization=' + f.access, Origin: f.env.DEPLOYMENT_ORIGIN } }), f.env);
    expect(response.status).toBe(200); expect((await response.json() as any).authentication).toBe('native-session');
  });
  it('never grants a native session from an unverified cookie or a foreign origin', async () => {
    const f = brokerFixture();
    for (const headers of [{ Cookie: 'CF_Authorization=unverified', Origin: f.env.DEPLOYMENT_ORIGIN }, { Cookie: 'CF_Authorization=' + f.access, Origin: 'https://attacker.example.test' }]) {
      const response = await broker.fetch(new Request(f.base + '/upgrade', { method: 'POST', headers }), f.env);
      expect([401, 403]).toContain(response.status);
    }
    expect(f.rooms.size).toBe(0);
  });
});
