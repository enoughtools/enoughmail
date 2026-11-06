import type { Principal } from '@open-cloud/contracts';
import type { AssetFetcher, DurableObjectState } from '@open-cloud/worker';

export const nativeAppBase = '/apps/mail/native/app/';
export const nativeCookie = 'EnoughMailNativeSession';
const responseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: responseHeaders });
interface Scope { actorId: string; organizationId: string; workspaceId: string }
export interface NativeIdentity { principal: Principal; session: Scope; createdAt: number; revokedAt?: number }
export interface NativeSessionEnv {
  DEPLOYMENT_ORIGIN: string;
  NATIVE_MAIL?: AssetFetcher;
  SESSIONS?: { idFromName(name: string): unknown; get(id: unknown): AssetFetcher };
}
const validScope = (value: Scope) => value && ['actorId', 'organizationId', 'workspaceId'].every(key => typeof value[key as keyof Scope] === 'string' && value[key as keyof Scope].length > 0 && value[key as keyof Scope].length <= 256);
export function validNativeIdentity(value: NativeIdentity): boolean {
  return !!value && validScope(value.session) && value.principal?.provider === 'cloudflare-access' && value.principal.id === value.session.actorId && typeof value.principal.email === 'string' && !!value.principal.email && value.principal.email.length <= 320 && Number.isSafeInteger(value.createdAt);
}
const hash = async (token: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(x => x.toString(16).padStart(2, '0')).join('');
const store = async (env: NativeSessionEnv, token: string) => env.SESSIONS!.get(env.SESSIONS!.idFromName(await hash(token)));
const rpc = (target: AssetFetcher, path: string, body: unknown = {}) => target.fetch(new Request('https://native-session.internal' + path, { method: 'POST', body: JSON.stringify(body) }));

/** Private, per-device grant. Only a digest is used as its storage address; no bearer is stored. */
export class MailNativeSessions {
  constructor(private ctx: DurableObjectState) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const path = new URL(request.url).pathname;
    return this.ctx.storage.transaction(async storage => {
      const saved = await storage.get<NativeIdentity>('identity');
      if (path === '/issue') {
        const identity = await request.json() as NativeIdentity;
        if (saved || !validNativeIdentity(identity) || identity.revokedAt !== undefined) return json({ error: 'invalid_grant' }, 409);
        await storage.put('identity', identity); return json({ issued: true });
      }
      if (path === '/revoke') {
        if (saved) await storage.put('identity', { createdAt: saved.createdAt, revokedAt: saved.revokedAt ?? Date.now() });
        return json({ revoked: true });
      }
      if (path !== '/read') return json({ error: 'not_found' }, 404);
      return json({ identity: saved && saved.revokedAt === undefined ? saved : null });
    });
  }
}
export async function issueNativeSession(env: NativeSessionEnv, principal: Principal, session: Scope): Promise<Response> {
  if (!env.SESSIONS || !env.NATIVE_MAIL) return json({ error: 'persistent_sign_in_unavailable' }, 503);
  const identity = { principal, session, createdAt: Date.now() };
  if (!validNativeIdentity(identity)) return json({ error: 'invalid_identity' }, 403);
  const token = 'ems_' + [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
  const result = await rpc(await store(env, token), '/issue', identity);
  if (!result.ok) return json({ error: 'persistent_sign_in_unavailable' }, 503);
  return json({ token, session, authentication: 'native-session' });
}
function readToken(request: Request): string | undefined {
  const cookies = (request.headers.get('Cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(nativeCookie + '='));
  if (cookies.length !== 1) return;
  const token = cookies[0].slice(nativeCookie.length + 1);
  return /^ems_[a-f0-9]{64}$/.test(token) ? token : undefined;
}
/** A token grants entry only to its saved actor/workspace. Current Mail admission is checked on every request. */
export async function handleNativeSession(request: Request, env: NativeSessionEnv): Promise<Response> {
  if (!env.SESSIONS || !env.NATIVE_MAIL) return json({ error: 'persistent_sign_in_unavailable' }, 503);
  const url = new URL(request.url), token = readToken(request);
  if (!token) return json({ error: 'sign_in_required' }, 401);
  if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') !== env.DEPLOYMENT_ORIGIN) return json({ error: 'invalid_origin' }, 403);
  const target = await store(env, token);
  if (url.pathname === '/apps/mail/native/revoke' && request.method === 'POST') return rpc(target, '/revoke');
  if (!url.pathname.startsWith(nativeAppBase)) return json({ error: 'not_found' }, 404);
  const record = await (await rpc(target, '/read')).json() as { identity: NativeIdentity | null };
  if (!record.identity || !validNativeIdentity(record.identity)) return json({ error: 'sign_in_required' }, 401);
  const identity = record.identity;
  const privateHeaders = new Headers({ 'X-Mail-Native-Principal': JSON.stringify(identity.principal) });
  const admitted = await env.NATIVE_MAIL.fetch(new Request(env.DEPLOYMENT_ORIGIN + '/apps/mail/api/session', { headers: privateHeaders }));
  if (!admitted.ok) return json({ error: admitted.status >= 500 ? 'session_check_unavailable' : 'access_denied' }, admitted.status >= 500 ? 503 : 403);
  const current = await admitted.json() as Scope;
  if (!validScope(current) || (['actorId', 'organizationId', 'workspaceId'] as const).some(key => current[key] !== identity.session[key])) return json({ error: 'identity_changed' }, 403);
  const suffix = url.pathname.slice(nativeAppBase.length);
  const path = suffix === '__platform/apps' ? '/api/apps' : '/apps/mail/' + suffix;
  if (path.includes('/internal/') || suffix.startsWith('native/')) return json({ error: 'not_found' }, 404);
  const forwardedUrl = new URL(path + url.search, env.DEPLOYMENT_ORIGIN);
  const forwarded = new Request(forwardedUrl, request);
  const headers = new Headers(forwarded.headers);
  for (const name of ['Cookie', 'Authorization', 'Cf-Access-Jwt-Assertion', 'X-Mail-Verified-Principal', 'X-Mail-Native-Principal']) headers.delete(name);
  headers.set('X-Mail-Native-Principal', JSON.stringify(identity.principal));
  const response = await env.NATIVE_MAIL.fetch(new Request(forwarded, { headers }));
  const outputHeaders = new Headers(response.headers);
  outputHeaders.set('Cache-Control', /^assets\/[A-Za-z0-9._/-]+$/.test(suffix) ? 'private, max-age=31536000, immutable' : 'no-store'); outputHeaders.delete('Set-Cookie');
  const rewrite = (value: string) => value.replace(/\/apps\/mail\/(?!native\/)/g, nativeAppBase);
  const location = outputHeaders.get('Location');
  if (location) {
    const destination = new URL(location, env.DEPLOYMENT_ORIGIN);
    if (destination.origin === env.DEPLOYMENT_ORIGIN) outputHeaders.set('Location', rewrite(destination.href));
  }
  const type = outputHeaders.get('Content-Type') ?? '';
  if (request.method !== 'HEAD' && response.ok && ['jmap/session', '.well-known/jmap'].includes(suffix) && /application\/json/i.test(type)) {
    const discovery = await response.json() as Record<string, unknown>;
    for (const field of ['apiUrl', 'uploadUrl', 'downloadUrl', 'eventSourceUrl']) {
      const value = discovery[field];
      if (typeof value === 'string' && (value.startsWith('/apps/mail/') || value.startsWith(env.DEPLOYMENT_ORIGIN + '/apps/mail/'))) discovery[field] = rewrite(value);
    }
    outputHeaders.delete('Content-Length'); outputHeaders.delete('Content-Encoding'); outputHeaders.delete('ETag');
    return new Response(JSON.stringify(discovery), { status: response.status, headers: outputHeaders });
  }
  if (request.method !== 'HEAD' && /(?:text\/html|text\/css|(?:text|application)\/javascript)/i.test(type) && response.body !== null) {
    outputHeaders.delete('Content-Length'); outputHeaders.delete('Content-Encoding'); outputHeaders.delete('ETag');
    return new Response(rewrite(await response.text()), { status: response.status, headers: outputHeaders });
  }
  return new Response(response.body, { status: response.status, headers: outputHeaders });
}
