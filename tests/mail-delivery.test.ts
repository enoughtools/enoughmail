import { describe, expect, it, vi } from 'vitest';
import { receiveMail, sendRawMail, MAX_OUTBOUND_BYTES } from '../apps/mail/src/server/delivery';
import { applyDomainDns, checkSpfBudget, planDomainDns, verifyDomainDns, type DnsRecord } from '../apps/mail/src/server/domains';
const requirements: DnsRecord[] = [
  { type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net', priority: 10 },
  { type: 'TXT', name: 'cf._domainkey.example.com', content: 'v=DKIM1; p=provider-key' },
  { type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
];
describe('Cloudflare delivery', () => {
  it('persists original bytes before committing metadata and does not accept failed persistence', async () => {
    const order: string[] = [];
    const put = vi.fn(async () => { order.push('r2'); });
    await receiveMail({ MAIL_BLOBS: { put, get: async () => null } }, { accountId: 'account', from: '', to: 'a@example.com', raw: new TextEncoder().encode('From: x@example.com\r\n\r\nbody') }, async stored => { order.push('account'); expect(stored.objectKey).toMatch(/^account\/blobs\/[a-f0-9]{64}$/); });
    expect(order).toEqual(['r2', 'account']);
    await expect(receiveMail({ MAIL_BLOBS: { put: async () => { throw Error('r2 down'); }, get: async () => null } }, { accountId: 'a', from: '', to: 'a@example.com', raw: new Uint8Array() }, async () => { throw Error('must not reach'); })).rejects.toThrow('r2 down');
  });
  const env = (size = 4) => ({ CF_ACCOUNT_ID: 'account', CF_API_TOKEN: 'secret', MAIL_BLOBS: { put: async () => {}, get: async () => ({ size, arrayBuffer: async () => new TextEncoder().encode('mime').buffer }) } });
  const message = { from: 'a@example.com', to: ['b@example.com'], blobId: 'blob', accountId: 'a' };
  it('fences attempted state before sending and retains unknown outcome without retry', async () => {
    const order: string[] = []; const send = vi.fn(async () => { order.push('provider'); throw Error('timeout'); }) as unknown as typeof fetch;
    const result = await sendRawMail(env(), message, async () => { order.push('durable'); }, send);
    expect(order).toEqual(['durable', 'provider']); expect(result.status).toBe('unknown'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('enforces provider limits and distinguishes HTTP rejection from uncertain provider failure', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect((await sendRawMail(env(MAX_OUTBOUND_BYTES + 1), message, undefined, fetcher)).error).toBe('messageTooLarge'); expect(fetcher).not.toHaveBeenCalled();
    expect((await sendRawMail(env(), message, undefined, async () => new Response('', { status: 403 }))).status).toBe('rejected');
    expect((await sendRawMail(env(), message, undefined, async () => new Response('', { status: 503 }))).status).toBe('unknown');
    expect((await sendRawMail(env(), message, undefined, async (_url, options) => {
      expect(options?.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { Location: 'https://foreign.example/' } });
    })).status).toBe('unknown');
  });
  it('returns per-recipient bounce/queue state from the real raw API schema', async () => {
    const result = await sendRawMail(env(), message, undefined, async (url, options) => {
      expect(String(url)).toContain('/email/sending/send_raw'); expect(JSON.parse(String(options?.body))).toEqual({ from: message.from, recipients: message.to, mime_message: 'mime' });
      return Response.json({ success: true, result: { message_id: 'provider', queued: message.to, permanent_bounces: [], delivered: [] } });
    }); expect(result).toMatchObject({ status: 'accepted', providerId: 'provider', queued: message.to });
  });
});
describe('safe mail domain plans', () => {
  it('counts nested SPF includes and refuses cycles instead of claiming a flat count is safe', async () => {
    const nested = async (domain: string) => [`v=spf1 include:${Number(domain.split('.')[0]) + 1}.example.net -all`];
    expect(await checkSpfBudget('example.com', 'v=spf1 include:1.example.net -all', nested)).toMatchObject({ valid: false, error: 'spfLookupLimit', lookups: 11 });
    expect(await checkSpfBudget('example.com', 'v=spf1 include:example.com -all', async () => ['v=spf1 include:example.com -all'])).toMatchObject({ valid: false, error: 'spfCycle' });
    expect(await checkSpfBudget('example.com', 'v=spf1 include:sender.net -all', async () => ['v=spf1 ip4:192.0.2.1 -all'])).toMatchObject({ valid: true, lookups: 1 });
  });
  it('preserves strict DMARC, merges exactly one SPF policy, blocks conflicting MX and selector records', () => {
    const current: DnsRecord[] = [
      { id: 'spf', type: 'TXT', name: 'example.com', content: 'v=spf1 ip4:192.0.2.1 -all' },
      { type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=reject; rua=mailto:reports@example.com' },
      { type: 'MX', name: 'example.com', content: 'old-provider.example.net', priority: 1 },
      { type: 'TXT', name: 'cf._domainkey.example.com', content: 'existing-key' },
    ];
    const plan = planDomainDns('example.com', current, requirements);
    expect(plan.changes.find(c => c.record.id === 'spf')?.record.content).toBe('v=spf1 ip4:192.0.2.1 include:_spf.mx.cloudflare.net -all');
    expect(plan.changes.some(c => c.record.name.startsWith('_dmarc'))).toBe(false); expect(plan.conflicts).toHaveLength(2);
  });
  it('rejects duplicate SPF even when one policy exactly matches provider requirements', () => {
    const plan = planDomainDns('example.com', [{ ...requirements[2], id: '1' }, { ...requirements[2], id: '2' }], requirements);
    expect(plan.conflicts.some(c => c.includes('Multiple SPF'))).toBe(true);
  });
  it('refuses an unsafe SPF DNS budget and unresolved recursive budget is not ready', () => {
    const existing = [{ id: 'spf', type: 'TXT', name: 'example.com', content: `v=spf1 ${Array.from({ length: 10 }, (_, i) => `include:${i}.example.net`).join(' ')} -all` }];
    expect(planDomainDns('example.com', existing, requirements).conflicts.some(c => c.includes('ten DNS'))).toBe(true);
    const plan = planDomainDns('example.com', [], requirements);
    expect(verifyDomainDns(plan, plan.requirements).ready).toBe(false);
  });
  it('refuses stale plans before any mutation and handles uncertain create outcomes', async () => {
    const plan = planDomainDns('example.com', [], requirements);
    const stale = vi.fn(async (url: string | URL | Request) => Response.json({ success: true, result: String(url).includes('dns_records') ? [requirements[0]] : { name: 'example.com' } })) as unknown as typeof fetch;
    await expect(applyDomainDns({ CF_API_TOKEN: 'secret' }, 'a'.repeat(32), plan, stale)).rejects.toThrow('dnsPlanStale');
    const failing = vi.fn(async (_url, options) => { if (options?.method === 'POST') throw Error('timeout'); return Response.json({ success: true, result: options?.method === 'GET' && String(_url).includes('dns_records') ? [] : { name: 'example.com' } }); }) as typeof fetch;
    expect((await applyDomainDns({ CF_API_TOKEN: 'secret' }, 'a'.repeat(32), plan, failing)).status).toBe('unknown');
  });
});
