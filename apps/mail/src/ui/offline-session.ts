import type { MailSession } from './jmap';

const KEY = 'enough-mail:offline-session:v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 64_000;
const SENSITIVE = /password|secret|token|authorization|cookie|credential/i;

// Only discovery metadata is retained. It is a display/cache scope, never a grant.
function metadata(session: MailSession): MailSession {
  for (const field of ['actorId', 'organizationId', 'workspaceId'] as const) {
    if (typeof session[field] !== 'string' || !session[field].trim()) throw new Error('Verified mail identity is required for offline startup.');
  }
  function endpoint(value: string, optional = false, templateQuery: string[] = []): string {
    if (optional && !value) return '';
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password || url.hash) throw new Error('Offline session endpoints must be local and contain no credentials.');
    for (const [key, item] of url.searchParams) if (!templateQuery.includes(key) || item !== `{${key}}`) throw new Error('Offline session endpoints must contain no credentials.');
    return (url.pathname + url.search).replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  }
  function publicValues(value: unknown, depth = 0): unknown {
    if (depth > 8) throw new Error('Mail discovery metadata is too deeply nested.');
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.map(item => publicValues(item, depth + 1));
    if (typeof value !== 'object') throw new Error('Invalid discovery metadata.');
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE.test(key)).map(([key, item]) => [key, publicValues(item, depth + 1)]));
  }
  if (!session.accounts || typeof session.accounts !== 'object' || Array.isArray(session.accounts) || !Object.keys(session.accounts).length) throw new Error('An admitted mail account is required for offline startup.');
  const accounts = Object.fromEntries(Object.entries(session.accounts).map(([id, account]) => {
    if (!id || !account || typeof account.name !== 'string' || typeof account.isReadOnly !== 'boolean' || !account.accountCapabilities || typeof account.accountCapabilities !== 'object') throw new Error('Invalid mail account metadata.');
    return [id, { name: account.name, isReadOnly: account.isReadOnly, accountCapabilities: publicValues(account.accountCapabilities) as Record<string, unknown> }];
  }));
  const primaryAccounts = Object.fromEntries(Object.entries(session.primaryAccounts || {}).filter(([, id]) => typeof id === 'string' && Object.hasOwn(accounts, id)));
  return {
    username: typeof session.username === 'string' ? session.username : '',
    actorId: session.actorId, organizationId: session.organizationId, workspaceId: session.workspaceId,
    apiUrl: endpoint(session.apiUrl), uploadUrl: endpoint(session.uploadUrl, true), downloadUrl: endpoint(session.downloadUrl, true, ['type']),
    ...(session.eventSourceUrl ? { eventSourceUrl: endpoint(session.eventSourceUrl, false, ['types', 'closeafter', 'ping']) } : {}),
    capabilities: publicValues(session.capabilities || {}) as Record<string, unknown>, accounts, primaryAccounts,
  };
}

export function saveOfflineSession(session: MailSession, maxAgeHours = 24): void {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('Offline session age must be positive.');
  const savedAt = Date.now();
  const encoded = JSON.stringify({ savedAt, expiresAt: savedAt + Math.min(maxAgeHours * 3_600_000, MAX_AGE_MS), session: metadata(session) });
  if (encoded.length * 2 > MAX_BYTES) throw new Error('Mail discovery metadata is too large for offline storage.');
  try { localStorage.setItem(KEY, encoded); } catch { /* Storage denial must not prevent online mail access. */ }
}

export function readOfflineSession(maxAgeHours=24): MailSession | null {
  try {
    const encoded = localStorage.getItem(KEY);
    if (!encoded) return null;
    if (encoded.length * 2 > MAX_BYTES) throw new Error('Oversized offline metadata.');
    const entry = JSON.parse(encoded);
    const now = Date.now();const requestedAge=Math.min(24,Math.max(1,maxAgeHours))*3_600_000;
    if (!Number.isFinite(entry.savedAt) || !Number.isFinite(entry.expiresAt) || entry.savedAt > now || entry.expiresAt <= now || now-entry.savedAt>=requestedAge || entry.expiresAt <= entry.savedAt || entry.expiresAt - entry.savedAt > MAX_AGE_MS) throw new Error('Offline session expired.');
    return metadata(entry.session);
  } catch { clearOfflineSession(); return null; }
}

export function clearOfflineSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* Browser storage may be disabled. */ }
}

export async function registerMailOfflineShell(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/apps/mail/mail-sw.js', { scope: '/apps/mail/' });
    await navigator.serviceWorker.ready;
    const worker = registration.active || registration.waiting || registration.installing;
    if (!worker) return;
    const assets = [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src],link[rel="stylesheet"][href],link[rel="modulepreload"][href]')]
      .map(element => element instanceof HTMLScriptElement ? element.src : element.href)
      .filter(value => { const url = new URL(value, window.location.origin); return url.origin === window.location.origin && /^\/apps\/mail\/assets\/[^/]+\.(js|css)$/.test(url.pathname) && !url.search && !url.hash; });
    worker.postMessage({ type: 'CACHE_MAIL_SHELL', urls: assets });
  } catch { /* The app remains usable when service workers are unavailable. */ }
}
