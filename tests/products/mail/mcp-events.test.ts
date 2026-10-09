import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { MailMcpEvents, MAIL_MCP_EVENT, eventProofForCredential, validateCallback } from '../../../apps/mail/src/server/mcp-events';
import type { Credential } from '../../../apps/mail/src/server/credentials';

const databases: DatabaseSync[] = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });
const accountId = '00000000-0000-4000-8000-000000000001';
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const destination = 'https://callbacks.example.com/events/one';
const email = { id: 'email-1', from: [{ email: 'person@example.com' }], subject: 'Urgent question', mailboxIds: { 'folder-inbox': true }, receivedAt: '2026-10-08T12:00:00Z' };
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage = { sql: { exec<T>(sql: string, ...values: unknown[]): Iterable<T> { const statement = db.prepare(sql); return (statement.columns().length ? statement.all(...values as any[]) : [statement.run(...values as any[])]) as T[]; } }, transactionSync<T>(run: () => T): T { db.exec('SAVEPOINT event_commit'); try { const result = run(); db.exec('RELEASE event_commit'); return result; } catch (error) { db.exec('ROLLBACK TO event_commit; RELEASE event_commit'); throw error; } } };
  const credential: Credential = { id: crypto.randomUUID(), version: 1, accountId, organizationId: 'org', workspaceId: 'workspace', actorId: 'actor', name: 'ChatGPT', lease: 'lease', jobId: crypto.randomUUID(), actions: ['mail.read'], hash: 'hash', expiresAt: Date.now() + 86400_000 * 30, createdAt: Date.now(), revokedAt: null, lifecycleGeneration: 0 };
  let revoked = false, denied = false, status = 200, verificationStatus = 200, invalidChallenge = false, outage = false;
  const deliveries: { url: string; init: RequestInit; body: any }[] = [];
  const env = { MAIL_MCP_CALLBACK_ORIGINS: 'https://callbacks.example.com', MAIL_CREDENTIALS: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ credential: revoked ? null : credential }) }) }, MAIL_AUTHORITY_SERVICE: { fetch: async () => { if (outage) throw new Error('Authority offline'); return Response.json({ authorization: { allowed: !denied, effectiveActions: denied ? [] : ['mail.read'] }, resource: { id: accountId, ownerAppId: 'mail', resourceType: 'mail.account' }, context: { actorId: 'actor', organizationId: 'org', workspaceId: 'workspace' } }); } } };
  const send = async (url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); deliveries.push({ url, init, body }); return body.type === 'verification' ? Response.json({ challenge: invalidChallenge ? 'wrong' : body.challenge }, { status: verificationStatus }) : new Response(null, { status }); };
  const restart = () => new MailMcpEvents(storage, env, send);
  const events = restart(), proof = eventProofForCredential(credential), owner = `credential:${credential.id}:1`;
  const params = { name: MAIL_MCP_EVENT, arguments: { resourceId: accountId }, delivery: { mode: 'webhook', url: destination, secret }, cursor: null };
  return { db, storage, env, credential, events, proof, owner, params, deliveries, restart, revoke: () => { revoked = true; }, deny: () => { denied = true; }, setStatus: (value: number) => { status = value; }, setVerificationStatus: (value: number) => { verificationStatus = value; }, invalidateChallenge: () => { invalidChallenge = true; }, outage: (value: boolean) => { outage = value; } };
}

describe('durable Mail MCP event delivery', () => {
  it('calls the default fetch sender with the correct Workers global receiver', async () => {
    const f = fixture();
    const fetchMock = vi.fn(function (this: unknown, _url: string, init: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      if (init.redirect === 'error') throw new TypeError('Workers supports only follow or manual redirects');
      const body = JSON.parse(String(init.body));
      return Promise.resolve(body.type === 'verification' ? Response.json({ challenge: body.challenge }) : new Response(null, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const events = new MailMcpEvents(f.storage, f.env);
    const sub: any = await events.command('events/subscribe', f.params, f.owner, f.proof);
    expect(sub.id).toEqual(expect.any(String));
    events.received(accountId, email, 'default-sender'); await events.deliver(0, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(0);
  });
  it('verifies and signs callbacks with interoperable Standard Webhooks headers', async () => {
    const f = fixture(); const sub: any = await f.events.command('events/subscribe', f.params, f.owner, f.proof);
    expect(sub).toMatchObject({ cursor: null, truncated: false });
    f.storage.transactionSync(() => f.events.received(accountId, email, 'delivery-1'));
    await f.restart().deliver(0, true);
    expect(f.deliveries).toHaveLength(2);
    for (const delivery of f.deliveries) {
      const headers = new Headers(delivery.init.headers);
      const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${headers.get('webhook-id')}.${headers.get('webhook-timestamp')}.${delivery.init.body}`).digest('base64');
      expect(headers.get('webhook-signature')).toBe('v1,' + signature);
      expect(headers.get('X-MCP-Subscription-Id')).toBe(sub.id);
      expect(delivery.init.redirect).toBe('manual');
    }
    expect(f.deliveries[1].body).toMatchObject({ name: MAIL_MCP_EVENT, timestamp: email.receivedAt, data: { resourceId: accountId, emailId: email.id }, cursor: null });
    expect(JSON.stringify(f.deliveries[1].body)).not.toContain('Urgent');
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(0);
  });
  it('canonicalizes filter identities, refreshes without duplicates, and rotates signing keys', async () => {
    const f = fixture(); const args = { ...f.params, arguments: { subject: 'URGENT', resourceId: accountId, from: 'PERSON@example.com' } };
    const first: any = await f.events.command('events/subscribe', args, f.owner, f.proof);
    const nextSecret = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
    const second: any = await f.events.command('events/subscribe', { ...args, arguments: { from: 'person@example.com', resourceId: accountId, subject: 'urgent' }, delivery: { ...args.delivery, secret: nextSecret } }, f.owner, f.proof);
    expect(second.id).toBe(first.id);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_subscriptions').get()?.n).toBe(1);
    f.events.received(accountId, email, 'delivery'); await f.events.deliver(0, true);
    expect(new Headers(f.deliveries.at(-1)!.init.headers).get('webhook-signature')?.split(' ')).toHaveLength(2);
  });
  it('applies all filters before delivery and rejects a foreign account', async () => {
    const f = fixture(); await f.events.command('events/subscribe', { ...f.params, arguments: { resourceId: accountId, from: 'other@example.com', subject: 'urgent', mailboxId: 'folder-inbox' } }, f.owner, f.proof);
    f.events.received(accountId, email, 'delivery'); await f.events.deliver(0, true);
    expect(f.deliveries).toHaveLength(1);
    await expect(f.events.command('events/subscribe', { ...f.params, arguments: { resourceId: crypto.randomUUID() } }, f.owner, f.proof)).rejects.toThrow('Account is not authorized');
  });
  it('keeps event IDs and exact bytes across retries and restarts', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.events.command('events/subscribe', f.params, f.owner, f.proof);
    f.setStatus(503); f.events.received(accountId, email, 'delivery'); await f.events.deliver(0, true);
    vi.advanceTimersByTime(30_001); f.setStatus(200); await f.restart().deliver(0, true);
    expect(f.deliveries[1].init.body).toBe(f.deliveries[2].init.body);
    expect(new Headers(f.deliveries[1].init.headers).get('webhook-timestamp')).not.toBe(new Headers(f.deliveries[2].init.headers).get('webhook-timestamp'));
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(0);
  });
  it('never commits an event from a failed mail transaction', async () => {
    const f = fixture(); await f.events.command('events/subscribe', f.params, f.owner, f.proof);
    expect(() => f.storage.transactionSync(() => { f.events.received(accountId, email, 'delivery'); throw new Error('Commit failed'); })).toThrow();
    await f.events.deliver(0, true); expect(f.deliveries).toHaveLength(1);
  });
  it.each(['credential', 'grant', 'lifecycle', 'inactive'])('stops %s revocation before sending', async kind => {
    const f = fixture(); await f.events.command('events/subscribe', f.params, f.owner, f.proof); f.events.received(accountId, email, 'delivery');
    if (kind === 'credential') f.revoke(); if (kind === 'grant') f.deny();
    await f.events.deliver(kind === 'lifecycle' ? 1 : 0, kind !== 'inactive');
    expect(f.deliveries).toHaveLength(1); expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_subscriptions').get()?.n).toBe(0);
  });
  it('does not drop authority outages as revocations', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.events.command('events/subscribe', f.params, f.owner, f.proof); f.events.received(accountId, email, 'delivery');
    f.outage(true); await f.events.deliver(0, true); expect(f.deliveries).toHaveLength(1);
    f.outage(false); vi.advanceTimersByTime(30_001); await f.events.deliver(0, true); expect(f.deliveries).toHaveLength(2);
  });
  it.each([410, 413])('does not retry HTTP %s', async status => {
    const f = fixture(); await f.events.command('events/subscribe', f.params, f.owner, f.proof); f.setStatus(status); f.events.received(accountId, email, 'delivery'); await f.events.deliver(0, true);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_outbox').get()?.n).toBe(0);
  });
  it('bounds expiry to requested TTL and credential lifetime and removes expired subscriptions', async () => {
    vi.useFakeTimers(); const f = fixture(); const result: any = await f.events.command('events/subscribe', { ...f.params, ttlMs: 1000 }, f.owner, f.proof);
    expect(Date.parse(result.refreshBefore)).toBe(Date.now() + 1000);
    vi.advanceTimersByTime(1001); f.events.received(accountId, email, 'delivery'); await f.events.deliver(0, true); expect(f.deliveries).toHaveLength(1);
    const finite: any = await f.events.command('events/subscribe', { ...f.params, ttlMs: null }, f.owner, f.proof); expect(finite.refreshBefore).not.toBeNull();
  });
  it('accepts protocol metadata and replay-age fields without storing or interpreting extensions', async () => {
    const f = fixture();
    const params = { ...f.params, _meta: { progressToken: 'progress-1' }, maxAgeMs: 300000, clientExtension: { accountId: 'untrusted-account' }, delivery: { ...f.params.delivery, _meta: { trace: 'trace-1' } } };
    const sub: any = await f.events.command('events/subscribe', params, f.owner, f.proof);
    expect(sub.id).toEqual(expect.any(String));
    const stored = f.db.prepare('SELECT json FROM mail_mcp_subscriptions').get()?.json as string;
    expect(stored).not.toContain('progress-1'); expect(stored).not.toContain('untrusted-account');
    await f.events.command('events/unsubscribe', { ...params, delivery: { mode: 'webhook', url: destination, _meta: {} } }, f.owner, f.proof);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_subscriptions').get()?.n).toBe(0);
    await expect(f.events.command('events/subscribe', { ...params, arguments: { resourceId: accountId, actorId: 'untrusted-actor' } }, f.owner, f.proof)).rejects.toThrow('Invalid event filters');
    await expect(f.events.command('events/subscribe', { ...params, maxAgeMs: -1 }, f.owner, f.proof)).rejects.toMatchObject({ code: -32602, reason: 'invalid_max_age' });
  });
  it('makes unsubscribe idempotent and isolates owners', async () => {
    const f = fixture(); await f.events.command('events/subscribe', f.params, f.owner, f.proof); f.events.received(accountId, email, 'delivery');
    await f.events.command('events/unsubscribe', f.params, 'different-client', f.proof);
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_subscriptions').get()?.n).toBe(1);
    await f.events.command('events/unsubscribe', f.params, f.owner, f.proof); await f.events.command('events/unsubscribe', f.params, f.owner, f.proof);
    await f.events.deliver(0, true); expect(f.deliveries).toHaveLength(1);
  });
  it('fails callback verification without persisting a subscription', async () => {
    const f = fixture(); f.invalidateChallenge(); await expect(f.events.command('events/subscribe', f.params, f.owner, f.proof)).rejects.toMatchObject({ code: -32015, reason: 'challenge_failed' });
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_subscriptions').get()?.n).toBe(0);
  });
  it('rejects redirecting verification endpoints without following the redirect', async () => {
    const f = fixture(); f.setVerificationStatus(302);
    await expect(f.events.command('events/subscribe', f.params, f.owner, f.proof)).rejects.toMatchObject({ code: -32015 });
    expect(f.deliveries).toHaveLength(1); expect(f.deliveries[0].init.redirect).toBe('manual');
    expect(f.db.prepare('SELECT count(*) n FROM mail_mcp_subscriptions').get()?.n).toBe(0);
  });
  it('distinguishes a rejected HTTP callback from an incorrect challenge without logging secrets', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const rejected = fixture(); rejected.setVerificationStatus(403);
      await expect(rejected.events.command('events/subscribe', rejected.params, rejected.owner, rejected.proof)).rejects.toMatchObject({ code: -32015 });
      expect(info).toHaveBeenCalledWith('EnoughMail event verification', expect.objectContaining({ stage: 'callback_status', callbackStatus: 403 }));
      const mismatch = fixture(); mismatch.invalidateChallenge();
      await expect(mismatch.events.command('events/subscribe', mismatch.params, mismatch.owner, mismatch.proof)).rejects.toMatchObject({ code: -32015 });
      expect(info).toHaveBeenCalledWith('EnoughMail event verification', expect.objectContaining({ stage: 'callback_challenge', callbackStatus: 200 }));
      const logs = JSON.stringify(info.mock.calls);
      for (const value of [secret, destination, accountId, 'Urgent question']) expect(logs).not.toContain(value);
    } finally { info.mockRestore(); }
  });
  it('accepts only exact trusted public HTTPS callback origins', () => {
    for (const url of ['https://127.0.0.1/cb', 'http://callbacks.example.com/cb', 'https://callbacks.example.com.evil.com/cb', 'https://user:pass@callbacks.example.com/cb', 'https://callbacks.example.com:8443/cb', 'https://[::1]/cb']) expect(() => validateCallback(url, 'https://callbacks.example.com')).toThrow();
    expect(validateCallback('https://connectors.api.openai.com/mcp-events/callback', 'https://chatgpt.com,https://connectors.api.openai.com')).toBe('https://connectors.api.openai.com/mcp-events/callback');
    expect(() => validateCallback('https://connectors.api.openai.com.evil.example/callback', 'https://chatgpt.com,https://connectors.api.openai.com')).toThrow();
    expect(() => validateCallback(destination)).toThrow(); expect(validateCallback(destination, 'https://callbacks.example.com')).toBe(destination);
  });
});
