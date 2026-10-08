import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { clearOfflineSession, readOfflineSession, registerMailOfflineShell, saveOfflineSession } from '../apps/mail/src/ui/offline-session';
import type { MailSession } from '../apps/mail/src/ui/jmap';

const session = (): MailSession => ({ username: 'Alice', actorId: 'alice', organizationId: 'org', workspaceId: 'workspace', apiUrl: '/apps/mail/jmap', uploadUrl: '/apps/mail/jmap/upload/{accountId}', downloadUrl: '/apps/mail/jmap/download/{accountId}/{blobId}/{name}?type={type}', eventSourceUrl: '/apps/mail/jmap/events?types={types}&closeafter={closeafter}&ping={ping}', capabilities: { mail: {} }, accounts: { a: { name: 'Personal', isReadOnly: false, accountCapabilities: { mail: { maxSize: 10 } } } }, primaryAccounts: { mail: 'a' } });
describe('bounded offline startup identity metadata', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { location: { origin: 'https://mail.test' } });
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('copies only identity, endpoints and public account discovery metadata', () => {
    const source = session();
    Object.assign(source, { token: 'secret', mail: [{ subject: 'private' }] });
    source.accounts.a.accountCapabilities = { mail: { maxSize: 10, password: 'secret' } };
    saveOfflineSession(source);
    source.actorId = 'bob';
    const saved = readOfflineSession()!;
    expect(saved.actorId).toBe('alice');
    expect(saved.downloadUrl).toBe(session().downloadUrl);
    expect(saved.uploadUrl).toBe(session().uploadUrl);
    expect(saved.eventSourceUrl).toBe(session().eventSourceUrl);
    expect(saved).not.toHaveProperty('token');
    expect(saved).not.toHaveProperty('mail');
    expect(saved.accounts.a.accountCapabilities).toEqual({ mail: { maxSize: 10 } });
  });
  it('expires at exactly 24 hours even when a longer TTL is requested', () => {
    saveOfflineSession(session(), 100);
    vi.advanceTimersByTime(24 * 3_600_000 - 1); expect(readOfflineSession()).not.toBeNull();
    vi.advanceTimersByTime(1); expect(readOfflineSession()).toBeNull();
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z')); expect(readOfflineSession()).toBeNull();
  });
  it('supports shorter TTLs and rejects clock rollback, malformed data and incomplete identity', () => {
    saveOfflineSession(session(), 1); vi.advanceTimersByTime(3_600_000); expect(readOfflineSession()).toBeNull();
    saveOfflineSession(session()); vi.setSystemTime(Date.now() - 1); expect(readOfflineSession()).toBeNull();
    localStorage.setItem('enough-mail:offline-session:v1', '{'); expect(readOfflineSession()).toBeNull();
    expect(() => saveOfflineSession({ ...session(), actorId: '' })).toThrow('identity');
    expect(() => saveOfflineSession({ ...session(), accounts: {} })).toThrow('account');
    expect(() => saveOfflineSession(session(), 0)).toThrow('positive');
    expect(() => saveOfflineSession({ ...session(), apiUrl: 'https://other.test/jmap' })).toThrow('local');
    expect(() => saveOfflineSession({ ...session(), apiUrl: '/apps/mail/jmap?token=secret' })).toThrow('credentials');
  });
  it('registers the product scope and proactively sends only local production assets', async () => {
    class Script { constructor(public src: string) {} }
    const postMessage = vi.fn();
    const register = vi.fn().mockResolvedValue({ active: { postMessage } });
    vi.stubGlobal('HTMLScriptElement', Script);
    vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve({ active: { postMessage: vi.fn() } }) } });
    vi.stubGlobal('document', { querySelectorAll: () => [new Script('https://mail.test/apps/mail/assets/app.js'), { href: 'https://mail.test/apps/mail/assets/app.css' }, new Script('https://other.test/apps/mail/assets/app.js'), new Script('https://mail.test/apps/mail/jmap/session')] });
    await registerMailOfflineShell();
    expect(register).toHaveBeenCalledWith('/apps/mail/mail-sw.js', { scope: '/apps/mail/' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'CACHE_MAIL_SHELL', urls: ['https://mail.test/apps/mail/assets/app.js', 'https://mail.test/apps/mail/assets/app.css'] });
  });
  it('clears only offline startup metadata on logout', () => {
    localStorage.setItem('other', 'keep'); saveOfflineSession(session()); clearOfflineSession();
    expect(readOfflineSession()).toBeNull(); expect(localStorage.getItem('other')).toBe('keep');
  });
});

function worker(fetch: ReturnType<typeof vi.fn>) {
  const handlers: Record<string, (event: any) => void> = {};
  const entries = new Map<string, Response>();
  const cache = { put: vi.fn(async (key: string, response: Response) => { entries.set(key, response); }), match: vi.fn(async (key: string) => entries.get(key)) };
  runInNewContext(readFileSync(new URL('../apps/mail/public/mail-sw.js', import.meta.url), 'utf8'), {
    self: { location: { origin: 'https://mail.test' }, clients: { claim: vi.fn() }, skipWaiting:vi.fn(), addEventListener: (type: string, handler: any) => { const prior=handlers[type]; handlers[type]=prior ? event=>{prior(event);handler(event);} : handler; } },
    URL, Response, fetch, caches: { open: async () => cache, keys: async () => [], delete: vi.fn() },
  });
  return { entries, cache, handlers, request: async (url: string, mode = 'navigate') => {
    let pending: Promise<Response> | undefined;
    handlers.fetch({ request: { url, mode, method: 'GET' }, respondWith: (value: Promise<Response>) => { pending = value; } });
    return pending;
  } };
}
describe('offline static shell boundaries', () => {
  it('returns authorization and server errors directly even with a cached shell', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('sign in', { status: 401 }));
    const sw = worker(fetch); sw.entries.set('https://mail.test/apps/mail/', new Response('cached'));
    expect((await sw.request('https://mail.test/apps/mail/'))?.status).toBe(401);
    fetch.mockResolvedValue(new Response('failed', { status: 503 }));
    expect((await sw.request('https://mail.test/apps/mail/'))?.status).toBe(503);
    expect(sw.cache.match).not.toHaveBeenCalled(); expect(sw.cache.put).not.toHaveBeenCalled();
  });
  it('falls back only on transport failure and never intercepts mail, discovery or arbitrary assets', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
    const sw = worker(fetch); sw.entries.set('https://mail.test/apps/mail/', new Response('cached'));
    expect(await (await sw.request('https://mail.test/apps/mail/'))?.text()).toBe('cached');
    for (const url of ['https://mail.test/apps/mail/jmap', 'https://mail.test/apps/mail/jmap/session', 'https://mail.test/apps/mail/blob/a', 'https://mail.test/apps/mail/assets/private.json', 'https://other.test/apps/mail/assets/app.js', 'https://mail.test/apps/mail/?token=x']) expect(await sw.request(url)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preloads only local static JS and CSS and rejects redirects or mismatched media types', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('asset', { headers: { 'content-type': 'application/javascript' } }));
    const sw = worker(fetch);
    let pending: Promise<unknown> | undefined;
    sw.handlers.message({ data: { type: 'CACHE_MAIL_SHELL', urls: ['/apps/mail/assets/app.js', '/apps/mail/jmap/session', 'https://other.test/apps/mail/assets/app.js'] }, waitUntil: (value: Promise<unknown>) => { pending = value; } });
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2); expect(sw.cache.put).toHaveBeenCalledTimes(1);
    const redirected = new Response('login', { headers: { 'content-type': 'text/html' } }); Object.defineProperty(redirected, 'redirected', { value: true });
    fetch.mockResolvedValue(redirected); await sw.request('https://mail.test/apps/mail/');
    expect(sw.cache.put).toHaveBeenCalledTimes(1);
  });
});
