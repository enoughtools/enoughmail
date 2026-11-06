import { handleNativeSession, issueNativeSession, type NativeSessionEnv } from './sessions';
export { MailNativeSessions } from './sessions';
import { authenticate } from '@open-cloud/auth';
import type { AssetFetcher, DurableObjectState } from '@open-cloud/worker';

interface Env extends NativeSessionEnv {
  AUTH_PROVIDER: 'cloudflare-access'; ACCESS_TEAM_DOMAIN: string; ACCESS_AUDIENCE: string;
  DEPLOYMENT_ORIGIN: string; MAIL: AssetFetcher; CODES: { idFromName(name: string): unknown; get(id: unknown): AssetFetcher };
}
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const readExchange = async (request: Request): Promise<string | null> => {
  if (Number(request.headers.get('content-length')) > 2048) return null;
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally { reader.releaseLock(); }
};

/** One code per room, at most 60 seconds, consumed atomically after PKCE proof. */
export class MailNativeCodes {
  constructor(private ctx: DurableObjectState) {}
  async alarm() { await this.ctx.storage.deleteAll(); }
  async fetch(request: Request) {
    const body = await request.json() as any;
    return this.ctx.storage.transaction(async storage => {
      if (new URL(request.url).pathname === '/create') {
        await storage.put('grant', body); await storage.setAlarm(body.expires);
        return new Response(null, { status: 204 });
      }
      const record = await storage.get<any>('grant');
      if (!record || record.expires <= Date.now() || record.challenge !== body.challenge) return json({ error: 'sign_in_expired' }, 401);
      await storage.delete('grant');
      return json({ token: record.token, session: record.session, ...(record.persistent ? { persistent: true, principal: record.principal } : {}) });
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.DEPLOYMENT_ORIGIN) return json({ error: 'wrong_deployment' }, 400);
    const base = '/apps/mail/native';
    if (url.pathname.startsWith(base + '/app/') || url.pathname === base + '/revoke') return handleNativeSession(request, env);
    if (url.pathname === base + '/configuration' && request.method === 'GET') {
      return json({ product: 'enough-mail', version: 1, origin: url.origin, login: base + '/login', exchange: base + '/exchange', session: '/apps/mail/api/session', app: '/apps/mail/', authentication: 'cloudflare-access', ...(env.SESSIONS && env.NATIVE_MAIL ? { persistentSessionVersion: 1 } : {}), callback: 'enoughmail-workspace://authentication/callback' });
    }
    if (url.pathname === base + '/exchange' && request.method === 'POST') {
      const raw = await readExchange(request); if (raw === null) return json({ error: 'invalid_request' }, 413);
      let body; try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_request' }, 400); }
      if (!/^[a-f0-9]{64}$/.test(body?.code) || !/^[A-Za-z0-9_-]{43,128}$/.test(body?.verifier)) return json({ error: 'invalid_request' }, 400);
      const consumed = await env.CODES.get(env.CODES.idFromName(body.code)).fetch(new Request('https://codes/consume', { method: 'POST', body: JSON.stringify({ challenge: await digest(body.verifier) }) }));
      if (!consumed.ok) return consumed;
      const grant = await consumed.json() as any;
      return grant.persistent ? issueNativeSession(env, grant.principal, grant.session) : json({ token: grant.token, session: grant.session });
    }
    const upgrade = url.pathname === base + '/upgrade' && request.method === 'POST';
    if (upgrade && request.headers.get('Origin') !== env.DEPLOYMENT_ORIGIN) return json({ error: 'invalid_origin' }, 403);
    if (!upgrade && (url.pathname !== base + '/login' || request.method !== 'GET')) return json({ error: 'not_found' }, 404);
    const state = url.searchParams.get('state'), challenge = url.searchParams.get('challenge');
    if (!upgrade && (!/^[A-Za-z0-9_-]{43,128}$/.test(state ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(challenge ?? ''))) return json({ error: 'invalid_request' }, 400);
    try {
      // Public platform identity validation; Mail admission remains Mail-owned.
      const cookie = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('CF_Authorization='))?.slice(17);
      const token = upgrade ? cookie : request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token || cookie !== token) return json({ error: 'sign_in_required' }, 401);
      const verificationHeaders = new Headers(request.headers);
      verificationHeaders.set('Cf-Access-Jwt-Assertion', token);
      const principal = await authenticate(new Request(request, { headers: verificationHeaders }), env);
      const response = await env.MAIL.fetch(new Request(url.origin + '/apps/mail/api/session', { headers: { 'Cookie': 'CF_Authorization=' + token, 'Cf-Access-Jwt-Assertion': token } }));
      if (!response.ok) return json({ error: 'deployment_access_denied' }, response.status === 403 ? 403 : 401);
      const session = await response.json() as any;
      if (session.actorId !== principal.id || !session.organizationId || !session.workspaceId) return json({ error: 'deployment_access_denied' }, 403);
      if (upgrade) return issueNativeSession(env, principal, session);
      const payload = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
      const expires = Math.min(Date.now() + 60_000, payload.exp * 1000);
      if (!Number.isFinite(expires) || expires <= Date.now()) return json({ error: 'sign_in_expired' }, 401);
      const code = random();
      await env.CODES.get(env.CODES.idFromName(code)).fetch(new Request('https://codes/create', { method: 'POST', body: JSON.stringify({ token, session, challenge, expires, ...(url.searchParams.get('persistent') === '1' && env.SESSIONS && env.NATIVE_MAIL ? { persistent: true, principal } : {}) }) }));
      const callback = new URL('enoughmail-workspace://authentication/callback');
      callback.searchParams.set('state', state!); callback.searchParams.set('code', code);
      return new Response(null, { status: 302, headers: { ...headers, Location: callback.href } });
    } catch { return json({ error: 'sign_in_required' }, 401); }
  },
};
