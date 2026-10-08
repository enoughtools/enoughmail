import { describe, expect, it, vi } from 'vitest';
import { checkForwardingVerification, forwardingAllowed, requestForwardingVerification } from '../apps/mail/src/server/forwarding';
const env = { CF_ACCOUNT_ID: 'account', CF_API_TOKEN: 'secret' };
describe('Cloudflare forwarding verification', () => {
  it('requests the actual provider challenge and never marks an unverified response verified', async () => {
    const calls: string[] = [];
    const result = await requestForwardingVerification(env, { address: 'Owner@other.test' }, async (_url, options) => {
      expect(options?.redirect).toBe('manual');
      calls.push(options?.method ?? 'GET');
      return Response.json({ success: true, result: options?.method === 'POST' ? { id: 'destination', email: 'owner@other.test', verified: null } : [] });
    }); expect(calls).toEqual(['GET', 'POST']); expect(result).toEqual({ address: 'owner@other.test', providerId: 'destination', status: 'pending' });
  });
  it('accepts only exact address and requested provider identity from fresh authoritative status', async () => {
    const fetcher = async () => Response.json({ success: true, result: [{ id: 'id', email: 'owner@other.test', verified: '2026-10-05T12:00:00Z' }] });
    expect((await checkForwardingVerification(env, 'owner@other.test', fetcher, 'id')).status).toBe('verified');
    expect((await checkForwardingVerification(env, 'owner@other.test', fetcher, 'foreign')).status).toBe('rejected');
    expect((await checkForwardingVerification(env, 'other@other.test', fetcher)).status).toBe('pending');
  });
  it('does not repeat challenge creation after uncertain errors, and configuration/read failures send nothing', async () => {
    const send = vi.fn(async (_url, options) => { if (options?.method === 'POST') throw Error('timeout'); return Response.json({ success: true, result: [] }); }) as typeof fetch;
    expect((await requestForwardingVerification(env, { address: 'owner@other.test' }, send)).status).toBe('unknown'); expect(send).toHaveBeenCalledTimes(2);
    const failure = vi.fn(async () => new Response('', { status: 403 }));
    expect((await requestForwardingVerification(env, { address: 'owner@other.test' }, failure)).status).toBe('unknown'); expect(failure).toHaveBeenCalledTimes(1);
  });
  it('blocks loops, automation, quota overflow and unverified or different destinations', () => {
    const input = { destination: 'owner@other.test', envelopeTo: 'me@example.com', accountAddresses: ['me@example.com'], headers: new Headers(), todayCount: 0,
      verification: { address: 'owner@other.test', status: 'verified' as const } };
    expect(forwardingAllowed(input)).toBe(true);
    expect(forwardingAllowed({ ...input, todayCount: 100 })).toBe(false);
    expect(forwardingAllowed({ ...input, headers: new Headers({ 'X-Enough-Mail-Forwarded': '1' }) })).toBe(false);
    expect(forwardingAllowed({ ...input, destination: 'other@other.test' })).toBe(false);
    expect(forwardingAllowed({ ...input, destination: 'me@example.com' })).toBe(false);
  });
});
