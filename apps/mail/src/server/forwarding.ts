import { validAddress } from './delivery';

export interface ForwardingEnvironment { CF_ACCOUNT_ID?: string; CF_API_TOKEN?: string }
export interface ForwardingVerification {
  address: string; status: 'pending' | 'verified' | 'unknown' | 'rejected'; providerId?: string; verifiedAt?: string; error?: string;
}
interface Destination { id?: string; tag?: string; email?: string; verified?: string | null }
const normalize = (address: string) => address.trim().toLowerCase();
function path(env: ForwardingEnvironment): string {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) throw new Error('forwardingNotConfigured');
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/email/routing/addresses`;
}
function state(address: string, entry: Destination): ForwardingVerification {
  const providerId = entry.id ?? entry.tag;
  if (!providerId || typeof providerId !== 'string' || normalize(entry.email ?? '') !== address) return { address, status: 'unknown', error: 'invalidProviderDestination' };
  const verifiedAt = typeof entry.verified === 'string' && Number.isFinite(Date.parse(entry.verified)) ? entry.verified : undefined;
  return { address, providerId, status: verifiedAt ? 'verified' : 'pending', ...(verifiedAt ? { verifiedAt } : {}) };
}
/** Caller binds this request to a mailbox, current managing actor and exact destination in a durable receipt. */
export async function checkForwardingVerification(env: ForwardingEnvironment, address: string, fetcher: typeof fetch = fetch,
  expectedProviderId?: string): Promise<ForwardingVerification> {
  address = normalize(address);
  if (!validAddress(address) || address.length > 90) return { address, status: 'rejected', error: 'invalidForwardingAddress' };
  try {
    const url = path(env);
    for (let page = 1; page <= 100; page++) {
      const response = await fetcher(`${url}?per_page=50&page=${page}`, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, redirect: 'manual' });
      if (!response.ok) return { address, status: 'unknown', error: `providerHttp${response.status}` };
      const body = await response.json() as { success?: boolean; result?: Destination[]; result_info?: { total_pages?: number } };
      if (body.success !== true || !Array.isArray(body.result)) return { address, status: 'unknown', error: 'invalidProviderResponse' };
      const entry = body.result.find(d => typeof d.email === 'string' && normalize(d.email) === address);
      if (entry) {
        if (expectedProviderId && (entry.id ?? entry.tag) !== expectedProviderId) return { address, status: 'rejected', error: 'destinationVerificationChanged' };
        return state(address, entry);
      }
      if (body.result.length < 50 || body.result_info?.total_pages !== undefined && page >= body.result_info.total_pages)
        return { address, status: 'pending', error: 'destinationNotRegistered' };
    }
    return { address, status: 'unknown', error: 'providerPaginationLimit' };
  } catch (error) { return { address, status: 'unknown', error: error instanceof Error && error.message === 'forwardingNotConfigured' ? error.message : 'providerOutcomeUnknown' }; }
}
/** Cloudflare sends its own verification email. A timeout must be reconciled by GET, never blindly retried. */
export async function requestForwardingVerification(env: ForwardingEnvironment, request: { address: string }, fetcher: typeof fetch = fetch): Promise<ForwardingVerification> {
  const address = normalize(request.address);
  const current = await checkForwardingVerification(env, address, fetcher);
  if (current.status !== 'pending' || current.providerId) return current;
  try {
    const response = await fetcher(path(env), { method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: address }), redirect: 'manual' });
    if (!response.ok) return { address, status: response.status >= 500 || response.status === 408 || response.status >= 300 && response.status < 400 ? 'unknown' : 'rejected', error: `providerHttp${response.status}` };
    const body = await response.json() as { success?: boolean; result?: Destination };
    if (body.success === false) return { address, status: 'rejected', error: 'providerRejected' };
    if (body.success !== true || !body.result) return { address, status: 'unknown', error: 'invalidProviderResponse' };
    return state(address, body.result);
  } catch { return { address, status: 'unknown', error: 'providerOutcomeUnknown' }; }
}
export function forwardingAllowed(input: {
  destination: string; verification: ForwardingVerification; envelopeTo: string; accountAddresses: string[];
  headers: Headers; todayCount: number; dailyLimit?: number;
}): boolean {
  const destination = normalize(input.destination);
  return input.verification.status === 'verified' && input.verification.address === destination &&
    destination !== normalize(input.envelopeTo) && !input.accountAddresses.some(a => normalize(a) === destination) &&
    input.todayCount < (input.dailyLimit ?? 100) && input.todayCount >= 0 &&
    !input.headers.has('x-enough-mail-forwarded') && !input.headers.has('auto-submitted');
}
/** Use EmailEvent.forward(), which preserves provider forwarding/SRS behavior. Do not re-send original From using send_raw. */
export async function forwardIncomingMail(event: { forward(address: string, headers?: Headers): Promise<void> },
  input: Parameters<typeof forwardingAllowed>[0]): Promise<{ status: 'forwarded' | 'blocked' | 'unknown'; error?: string }> {
  if (!forwardingAllowed(input)) return { status: 'blocked', error: 'forwardingPolicyBlocked' };
  try { await event.forward(normalize(input.destination), new Headers({ 'X-Enough-Mail-Forwarded': '1' })); return { status: 'forwarded' }; }
  catch { return { status: 'unknown', error: 'forwardingOutcomeUnknown' }; }
}
