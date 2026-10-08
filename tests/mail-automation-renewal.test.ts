import { describe, expect, it } from 'vitest';
import { renewAutomationAuthority, type AutomationRenewalEnv, type AutomationRenewalInput } from '../apps/mail/src/server/automation-renewal';
const now = 1800000000000;
const input = (): AutomationRenewalInput => ({ accountId: 'account', organizationId: 'org', workspaceId: 'workspace', actorId: 'actor', lifecycleGeneration: 3, status: 'active', now, proof: { lease: 'completely opaque old token', jobId: 'job', expiresAt: now + 10000, actions: ['mail.read', 'mail.manage', 'mail.send'] }, pending: { operationId: '12345678-1234-1234-1234-123456789abc', expiresAt: now + 86400000 } });
function harness(change?: (path: string, body: any, count: number) => Response | void) {
  const requests: { path: string; body: any }[] = [];
  const env: AutomationRenewalEnv = { CORE: { async fetch(request) {
    const path = new URL(request.url).pathname, body = await request.json() as any; requests.push({ path, body });
    const changed = change?.(path, body, requests.length); if (changed) return changed;
    if (path.endsWith('/renew')) return Response.json({ lease: 'opaque renewed value without JWT syntax', expiresAt: body.expiresAt });
    return Response.json({ authorization: { allowed: true, effectiveActions: body.actions }, resource: { id: 'account', ownerAppId: 'mail', resourceType: 'mail.account' }, context: { actorId: 'actor', organizationId: 'org', workspaceId: 'workspace' }, jobId: 'job' });
  } } };
  return { env, requests };
}
describe('Automation authority renewal', () => {
  it('preserves exact issued action order, job and opaque lease metadata with deterministic replay', async () => {
    const { env, requests } = harness(); const args = input();
    const first = await renewAutomationAuthority(args, env), second = await renewAutomationAuthority(args, env);
    expect(first).toEqual(second); expect(first.status).toBe('allowed');
    if (first.status === 'allowed') expect(first.proof).toEqual({ ...args.proof, lease: 'opaque renewed value without JWT syntax', expiresAt: args.pending.expiresAt });
    const renewals = requests.filter(request => request.path.endsWith('/renew')); expect(renewals).toHaveLength(2); expect(renewals[0].body).toEqual(renewals[1].body); expect(renewals[0].body.actions).toEqual(args.proof.actions);
  });
  it('denies action attenuation, actor scope mismatch and renewal fencing', async () => {
    for (const response of [Response.json({ error: 'renewal_fenced' }, { status: 409 }), Response.json({ error: 'forbidden' }, { status: 403 }), Response.json({ error: 'invalid_request' }, { status: 400 })]) {
      const { env } = harness(path => path.endsWith('/renew') ? response : undefined); expect((await renewAutomationAuthority(input(), env)).status).toBe('denied');
    }
    const { env } = harness(path => path.endsWith('/revalidate') ? Response.json({ authorization: { allowed: true, effectiveActions: ['mail.manage', 'mail.send'] }, resource: { id: 'account', ownerAppId: 'mail', resourceType: 'mail.account' }, context: { actorId: 'other', organizationId: 'org', workspaceId: 'workspace' }, jobId: 'job' }) : undefined);
    expect((await renewAutomationAuthority(input(), env)).status).toBe('denied');
  });
  it('retries transient renewal failures only after rechecking the old authority', async () => {
    const { env, requests } = harness(path => path.endsWith('/renew') ? Response.json({ error: 'provider_unavailable' }, { status: 503 }) : undefined);
    expect((await renewAutomationAuthority(input(), env)).status).toBe('retry'); expect(requests.at(-1)?.path).toContain('/revalidate');
    const failed = harness((path, _body, count) => count >= 3 ? Response.json({ error: 'forbidden' }, { status: 403 }) : path.endsWith('/renew') ? Response.json({ error: 'provider_unavailable' }, { status: 503 }) : undefined);
    expect((await renewAutomationAuthority(input(), failed.env)).status).toBe('denied');
  });
  it('keeps persistent availability outages retryable without allowing expired authority', async () => {
    const outage = harness(() => Response.json({ error: 'provider_unavailable' }, { status: 503 }));
    expect(await renewAutomationAuthority(input(), outage.env)).toEqual({ status: 'retry', reason: 'provider_unavailable' });
    expect(outage.requests).toHaveLength(2);
    const expired = input(); expired.proof.expiresAt = now;
    expect((await renewAutomationAuthority(expired, outage.env)).status).toBe('denied');
    expect(outage.requests).toHaveLength(2);
    expect(await renewAutomationAuthority(input(), {})).toEqual({ status: 'retry', reason: 'core_unavailable' });
  });
  it('requires manual authorization for live legacy proofs and denies expired/inactive proofs without RPC', async () => {
    const { env, requests } = harness(); const legacy = input(); delete legacy.proof.actions;
    expect((await renewAutomationAuthority(legacy, env)).status).toBe('manual'); expect(requests.some(value => value.path.endsWith('/renew'))).toBe(false);
    for (const args of [{ ...input(), status: 'trashed' }, { ...input(), proof: { ...input().proof, expiresAt: now } }]) expect((await renewAutomationAuthority(args, env)).status).toBe('denied');
  });
  it('checks all issued credential actions, expiry and lifecycle and detects revocation during renewal', async () => {
    for (const patch of [{ actions: ['mail.manage', 'mail.send'] }, { lifecycleGeneration: 2 }, { expiresAt: now }, { revokedAt: now }, { version: 2 },{jobId:'other-job'}]) {
      const args = input(); Object.assign(args.proof, { credentialId: 'credential', credentialVersion: 1 });
      const { env } = harness(); const record = { id: 'credential', version: 1, jobId:'job', revokedAt: null, accountId: 'account', organizationId: 'org', workspaceId: 'workspace', actorId: 'actor', actions: args.proof.actions, expiresAt: now + 2 * 86400000, lifecycleGeneration: 3, ...patch };
      env.MAIL_CREDENTIALS = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ credential: record }) }) };
      expect((await renewAutomationAuthority(args, env)).status).toBe('denied');
    }
    const args = input(); Object.assign(args.proof, { credentialId: 'credential', credentialVersion: 1 });
    const { env } = harness(); let lookups = 0;
    env.MAIL_CREDENTIALS = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ credential: ++lookups > 1 ? null : { id: 'credential', version: 1, jobId:'job', revokedAt: null, accountId: 'account', organizationId: 'org', workspaceId: 'workspace', actorId: 'actor', actions: args.proof.actions, expiresAt: now + 2 * 86400000, lifecycleGeneration: 3 } }) }) };
    expect((await renewAutomationAuthority(args, env)).status).toBe('denied');
  });
  it('rejects expiry widening and changed pending old lease without sending renewal RPC', async () => {
    for (const pending of [{ ...input().pending, expiresAt: now + 91 * 86400000 }, { ...input().pending, oldLease: 'another token' }]) {
      const { env, requests } = harness(); expect((await renewAutomationAuthority({ ...input(), pending }, env)).status).toBe('denied'); expect(requests.some(value => value.path.endsWith('/renew'))).toBe(false);
    }
  });
});


it('preserves duplicate trusted issued actions and retries a non-JSON proxy outage',async()=>{const current=input();current.proof.actions=['mail.manage','mail.send','mail.send'];const normal=harness();expect((await renewAutomationAuthority(current,normal.env)).status).toBe('allowed');expect(normal.requests.find(request=>request.path.endsWith('/renew'))?.body.actions).toEqual(current.proof.actions);const unavailable=harness(()=>new Response('<html>Unavailable</html>',{status:503}));expect((await renewAutomationAuthority(current,unavailable.env)).status).toBe('retry');});
