import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MailAccount, type MailAccountEnvironment } from '../apps/mail/src/server/account';
import { MailDirectory, type DirectoryAccount, type DirectoryStorage } from '../apps/mail/src/server/directory';
import { MAIL_CAPABILITY } from '../apps/mail/src/domain/model';
import ingress from '../apps/mail/src/ingress';

const zoneId = 'a'.repeat(32);
const databases: DatabaseSync[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });

/** Serialized real directory transactions make competing inbox claims observable. */
class MemoryDirectory implements DirectoryStorage {
  values = new Map<string, any>();
  private queue: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)); }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
  transaction<T>(task: (storage: DirectoryStorage) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const previous = structuredClone(this.values);
      try { return await task(this); } catch (error) { this.values = previous; throw error; }
    });
    this.queue = result.catch(() => undefined); return result;
  }
}
const accountScope = (accountId = 'account'): DirectoryAccount => ({ accountId, organizationId: 'org', workspaceId: 'workspace', ownerActorId: 'same-owner' });
async function directoryFixture() {
  const storage = new MemoryDirectory(); const directory = new MailDirectory({ storage });
  await storage.put('domain:example.com', { ...accountScope(), domain: 'example.com', verifiedAt: new Date().toISOString() });
  await storage.put('approved-zone:example.com', { domain: 'example.com', zoneId, organizationId: 'org', workspaceId: 'workspace', accountIds: ['account', 'other'], revision: 1 });
  const call = async (path: string, body: any) => directory.fetch(new Request('https://directory' + path, { method: 'POST', body: JSON.stringify(body) }));
  return { storage, directory, directoryCall: call };
}
async function fixture(shared?: Awaited<ReturnType<typeof directoryFixture>>, accountId = 'account') {
  const sharedDirectory = shared || await directoryFixture();
  const db = new DatabaseSync(':memory:'); databases.push(db); let nesting = 0;
  const storage = {
    sql: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> { const statement = db.prepare(query); return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[]; } },
    transactionSync<T>(task: () => T): T { const save = 'sender_' + ++nesting; db.exec('SAVEPOINT ' + save); try { const value = task(); db.exec('RELEASE ' + save); return value; } catch (error) { db.exec('ROLLBACK TO ' + save + '; RELEASE ' + save); throw error; } },
    async setAlarm() {}, async deleteAlarm() {},
  };
  const blobs = new Map<string, Uint8Array>();
  const actions = ['mail.read', 'mail.draft', 'mail.send', 'mail.manage', 'mail.organize'];
  const context = { ...accountScope(accountId), actor: { id: 'same-owner', actions }, authorityProof: { actions, lease: 'fixture-lease', jobId: crypto.randomUUID(), expiresAt: Date.now() + 86400000 } };
  const env: MailAccountEnvironment = {
    MAIL_BLOBS: {
      async put(key, value) { blobs.set(key, value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : new Uint8Array(value)); },
      async get(key, options) { const value = blobs.get(key); if (!value) return null; const bytes = options?.range ? value.slice(options.range.offset, options.range.offset + options.range.length) : value; return { size: value.length, body: new Response(bytes.slice()).body!, async arrayBuffer() { return bytes.slice().buffer; } }; },
      async delete(key) { blobs.delete(key); },
    },
    MAIL_DIRECTORY: { idFromName: name => name, get: () => ({ fetch: request => sharedDirectory.directory.fetch(request) }) },
    MAIL_AUTHORITY_SERVICE: { async fetch(request) { const requested = await request.json() as any; return Response.json({ authorization: { allowed: true, effectiveActions: requested.actions }, resource: { id: accountId }, context: { organizationId: 'org', workspaceId: 'workspace', actorId: 'same-owner' } }); } },
  };
  let account = new MailAccount({ storage }, env);
  async function call(name: string, args: any = {}, allowed = actions, enough = true) {
    const response = await account.fetch(new Request('https://account/jmap', { method: 'POST', body: JSON.stringify({ ...context, actor: { ...context.actor, actions: allowed }, request: { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', ...(enough ? [MAIL_CAPABILITY] : [])], methodCalls: [[name, { accountId, ...args }, 'call']] } }) }));
    return (await response.json() as any).methodResponses[0][1];
  }
  await call('Identity/get');
  db.prepare('INSERT INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Domain', 'domain', JSON.stringify({ id: 'domain', name: 'example.com', zoneId, enabled: true, sendingVerified: true }));
  account = new MailAccount({ storage }, env);
  const command = async (email = 'alias@example.com') => ({ email, operationId: crypto.randomUUID(), ifInState: (await call('Identity/get')).state });
  const seedIdentity = (identity: any) => { db.prepare('INSERT OR REPLACE INTO mail_objects(type,id,json) VALUES(?,?,?)').run('Identity', identity.id, JSON.stringify(identity)); account = new MailAccount({ storage }, env); };
  const changeDomain = (patch: Record<string, unknown>) => { const current = JSON.parse(String(db.prepare("SELECT json FROM mail_objects WHERE type='Domain' AND id='domain'").get()?.json)); db.prepare("UPDATE mail_objects SET json=? WHERE type='Domain' AND id='domain'").run(JSON.stringify({ ...current, ...patch })); account = new MailAccount({ storage }, env); };
  const draft = async (from = [{ email: 'alias@example.com' }], extra = {}) => (await call('Email/set', { create: { draft: { from, to: [{ email: 'recipient@external.test' }], subject: 'Sender test', text: 'Body', ...extra } } })).created.draft;
  return { ...sharedDirectory, accountId, db, blobs, env, context, call, command, seedIdentity, changeDomain, draft, restart() { account = new MailAccount({ storage }, env); }, accountFetch: (request: Request) => account.fetch(request), alarm: () => account.alarm(), ingest: (input: any) => account.fetch(new Request('https://account/ingest', { method: 'POST', headers: { 'x-mail-account-context': JSON.stringify({ ...context, actor: { id: 'ingress', actions: ['mail.ingest'] } }) }, body: JSON.stringify(input) })) };
}

describe('Sending from an available domain address', () => {
  it('claims a normalized address once, replays lost responses and reuses saved identity settings', async () => {
    const f = await fixture(); const command = await f.command(' Alias@EXAMPLE.com ');
    const resolved = await f.call('Identity/resolve', command, ['mail.send']);
    expect(resolved.identity).toMatchObject({ email: 'alias@example.com', verified: true, name: '' });
    expect(resolved.newState).not.toBe(resolved.oldState);
    f.restart(); expect(await f.call('Identity/resolve', command, ['mail.send'])).toEqual(resolved);
    expect((await f.call('Identity/get')).list).toHaveLength(1);
    f.seedIdentity({ ...resolved.identity, name: 'Saved name', textSignature: 'Keep signature' });
    const reused = await f.call('Identity/resolve', await f.command(), ['mail.send']);
    expect(reused.identity).toMatchObject({ id: resolved.identity.id, name: 'Saved name', textSignature: 'Keep signature' });
    expect(reused.newState).toBe(reused.oldState);
    expect(await f.storage.get('address:alias@example.com')).toMatchObject({ accountId: 'account', enabled: true });
  });

  it('requires current sending permission, an explicit revision and the Enough capability', async () => {
    const f = await fixture(); const args = await f.command();
    expect((await f.call('Identity/resolve', args, ['mail.draft'])).type).toBe('forbidden');
    expect((await f.call('Identity/resolve', args, ['mail.edit'])).type).toBe('forbidden');
    expect((await f.call('Identity/resolve', args, ['mail.send'], false)).type).toBe('unknownMethod');
    expect((await f.call('Identity/resolve', { email: args.email })).type).toBe('invalidArguments');
    expect((await f.call('Identity/resolve', { ...args, operationId: crypto.randomUUID(), ifInState: 'stale' })).type).toBe('stateMismatch');
    expect((await f.call('Identity/set', { create: { sender: { email: args.email } } }, ['mail.send'])).type).toBe('forbidden');
    expect((await f.call('Identity/get')).list).toEqual([]);
    expect(await f.storage.get('address:alias@example.com')).toBeUndefined();
  });

  it.each(['outside@external.test', 'broken', 'Name <alias@example.com>', 'alias@example.com\r\nBcc: other@external.test'])('rejects unsupported or incomplete From %s without claiming it', async email => {
    const f = await fixture(); const result = await f.call('Identity/resolve', await f.command(email));
    expect(['forbidden', 'invalidArguments']).toContain(result.type);
    expect((await f.call('Identity/get')).list).toEqual([]);
  });

  it.each([{ enabled: false }, { sendingVerified: false }])('requires an enabled verified domain %j', async patch => {
    const f = await fixture(); f.changeDomain(patch);
    expect((await f.call('Identity/resolve', await f.command())).type).toBe('forbidden');
    expect(await f.storage.get('address:alias@example.com')).toBeUndefined();
  });

  it('requires current account approval, including after a previously successful claim', async () => {
    const f = await fixture(); const initial = await f.call('Identity/resolve', await f.command()); expect(initial.identity).toBeDefined();
    await f.storage.put('approved-zone:example.com', { zoneId, organizationId: 'org', workspaceId: 'workspace', accountIds: ['other'] });
    expect((await f.call('Identity/resolve', await f.command())).type).toBe('forbidden');
    expect((await f.call('Identity/get')).list).toHaveLength(1);
  });

  it.each([true, false])('refuses another inbox ordinary address even for the same owner (enabled=%s)', async enabled => {
    const f = await fixture(); await f.storage.put('address:alias@example.com', { ...accountScope('other'), address: 'alias@example.com', enabled, catchAll: false });
    expect((await f.call('Identity/resolve', await f.command())).type).toBe('forbidden');
    const legacy = await f.call('Identity/set', { create: { sender: { email: 'alias@example.com' } } });
    expect(legacy.notCreated.sender.description).toContain('another inbox');
    expect((await f.call('Identity/get')).list).toEqual([]);
    expect(await f.storage.get('address:alias@example.com')).toMatchObject({ accountId: 'other', enabled });
  });

  it('does not reactivate a disabled address while resolving a custom From', async () => {
    const f = await fixture(); await f.storage.put('address:alias@example.com', { ...accountScope(), address: 'alias@example.com', enabled: false, catchAll: false });
    expect((await f.call('Identity/resolve', await f.command())).description).toContain('disabled');
    expect(await f.storage.get('address:alias@example.com')).toMatchObject({ enabled: false });
    expect((await f.call('Identity/get')).list).toEqual([]);
  });

  it('refuses transferred addresses even when no exact route survives', async () => {
    const f = await fixture(); await f.storage.put('identity-transfer-owner:alias@example.com', accountScope('other'));
    expect((await f.call('Identity/resolve', await f.command())).type).toBe('forbidden');
    f.seedIdentity({ id: 'moved', email: 'local@example.com', verified: false, enabled: false, transferredTo: 'other' });
    expect((await f.call('Identity/resolve', await f.command('local@example.com'))).type).toBe('forbidden');
    expect(await f.storage.get('address:alias@example.com')).toBeUndefined();
  });

  it.each(['preparing', 'committed'])('blocks claims during %s transfer reservations', async status => {
    const f = await fixture(); await f.storage.put('identity-transfer-reservation:alias@example.com', 'transfer');
    await f.storage.put('transfer', { status, expiresAt: Date.now() + 60000 });
    expect((await f.call('Identity/resolve', await f.command())).type).toBe('forbidden');
    expect((await f.call('Identity/get')).list).toEqual([]);
    const ownership = await f.directoryCall('/identity-transfer', { action: 'owner', account: accountScope(), address: 'alias@example.com' });
    expect(await ownership.json()).toEqual({ owner: 'transfer-in-progress', enabled: false });
  });

  it('can claim after an expired preparation without leaving the old reservation active', async () => {
    const f = await fixture(); await f.storage.put('identity-transfer-reservation:alias@example.com', 'transfer');
    await f.storage.put('transfer', { status: 'preparing', expiresAt: Date.now() - 1 });
    expect((await f.call('Identity/resolve', await f.command())).identity).toBeDefined();
    expect(await f.storage.get('identity-transfer-reservation:alias@example.com')).toBeUndefined();
    expect(await f.storage.get('transfer')).toMatchObject({ status: 'aborted' });
  });

  it('allows exactly one inbox to win simultaneous claims without storing a losing identity', async () => {
    const shared = await directoryFixture(); const a = await fixture(shared); const b = await fixture(shared, 'other');
    const results = await Promise.all([a.call('Identity/resolve', await a.command()), b.call('Identity/resolve', await b.command())]);
    expect(results.filter(result => result.identity)).toHaveLength(1); expect(results.filter(result => result.type === 'forbidden')).toHaveLength(1);
    const winner = results[0].identity ? a : b, loser = winner === a ? b : a;
    expect(await shared.storage.get('address:alias@example.com')).toMatchObject({ accountId: winner.accountId });
    expect((await loser.call('Identity/get')).list).toEqual([]);
  });
});

describe('Sending address failures and final submission checks', () => {
  it('retries the same exact resolution after an unconfirmed directory result without caching the outage', async () => {
    const f = await fixture(); const original = f.env.MAIL_DIRECTORY!.get;
    let fail = true;
    f.env.MAIL_DIRECTORY!.get = id => ({ async fetch(request) { if (new URL(request.url).pathname === '/claim-sending-address' && fail) { await original(id).fetch(request.clone()); return Response.json({ error: 'unavailable' }, { status: 503 }); } return original(id).fetch(request); } });
    const command = await f.command();
    expect((await f.call('Identity/resolve', command)).type).toBe('serverFail');
    expect((await f.call('Identity/get')).list).toEqual([]);
    expect(await f.storage.get('address:alias@example.com')).toMatchObject({ accountId: 'account' });
    fail = false; f.restart();
    expect((await f.call('Identity/resolve', command)).identity).toMatchObject({ email: 'alias@example.com' });
    expect((await f.call('Identity/get')).list).toHaveLength(1);
  });

  it('does not persist a management-created identity when exact route registration fails', async () => {
    const f = await fixture(); const original = f.env.MAIL_DIRECTORY!.get;
    f.env.MAIL_DIRECTORY!.get = id => ({ async fetch(request) { if (new URL(request.url).pathname === '/register-address') return Response.json({ error: 'unavailable' }, { status: 503 }); return original(id).fetch(request); } });
    const result = await f.call('Identity/set', { create: { sender: { email: 'alias@example.com' } } });
    expect(result.notCreated.sender.description).toContain('registration failed');
    expect(result.created).toEqual({});
    expect((await f.call('Identity/get')).list).toEqual([]);
  });

  it('preserves the old address when a management edit cannot register its replacement', async () => {
    const f = await fixture(); const identity = (await f.call('Identity/resolve', await f.command())).identity;
    await f.storage.put('address:replacement@example.com', { ...accountScope('other'), address: 'replacement@example.com', enabled: true, catchAll: false });
    const result = await f.call('Identity/set', { update: { [identity.id]: { email: 'replacement@example.com' } } });
    expect(result.notUpdated[identity.id]).toBeDefined();
    expect((await f.call('Identity/get')).list[0]).toMatchObject({ email: 'alias@example.com' });
    expect(await f.storage.get('address:alias@example.com')).toMatchObject({ enabled: true, accountId: 'account' });
  });

  it('allows only one management create to claim a competing address and stores no failed duplicate', async () => {
    const shared = await directoryFixture(); const a = await fixture(shared), b = await fixture(shared, 'other');
    const create = { create: { sender: { email: 'alias@example.com' } } };
    const results = await Promise.all([a.call('Identity/set', create), b.call('Identity/set', create)]);
    expect(results.filter(result => result.created.sender)).toHaveLength(1);
    expect(results.filter(result => result.notCreated.sender)).toHaveLength(1);
    expect((await a.call('Identity/get')).list.length + (await b.call('Identity/get')).list.length).toBe(1);
  });

  it.each([true, false])('blocks an ordinary foreign address saved before the ownership fix (enabled=%s)', async enabled => {
    const f = await fixture(); f.seedIdentity({ id: 'legacy', email: 'alias@example.com', verified: true });
    await f.storage.put('address:alias@example.com', { ...accountScope('other'), address: 'alias@example.com', enabled, catchAll: false });
    const draft = await f.draft();
    const result = await f.call('EmailSubmission/set', { create: { send: { emailId: draft.id, identityId: 'legacy' } } });
    expect(result.notCreated.send.description).toContain('another inbox');
    expect(result.created).toEqual({});
  });

  it('rejects multiple From addresses before accepting a submission', async () => {
    const f = await fixture(); const identity = (await f.call('Identity/resolve', await f.command())).identity;
    const draft = await f.draft([{ email: identity.email }, { email: 'foreign@external.test' }]);
    const result = await f.call('EmailSubmission/set', { create: { send: { emailId: draft.id, identityId: identity.id } } });
    expect(result.notCreated.send.description).toContain('Exactly one From');
  });

  it.each(['route-owner', 'route-disabled', 'from', 'sender', 'envelope'])('rechecks %s immediately before delayed delivery', async changed => {
    const f = await fixture(); const identity = (await f.call('Identity/resolve', await f.command())).identity; const draft = await f.draft();
    const accepted = await f.call('EmailSubmission/set', { create: { send: { emailId: draft.id, identityId: identity.id } } });
    const id = accepted.created.send.id;
    const queued = JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(id)?.json));
    queued.sendAt = new Date(Date.now() - 1).toISOString();
    if (changed === 'route-owner') await f.storage.put('address:alias@example.com', { ...accountScope('other'), address: 'alias@example.com', enabled: true, catchAll: false });
    if (changed === 'route-disabled') await f.storage.put('address:alias@example.com', { ...accountScope(), address: 'alias@example.com', enabled: false, catchAll: false });
    if (changed === 'from') queued.emailSnapshot.from.push({ email: 'foreign@external.test' });
    if (changed === 'sender') queued.emailSnapshot.sender = [{ email: 'foreign@external.test' }];
    if (changed === 'envelope') queued.envelope.mailFrom.email = 'foreign@external.test';
    f.db.prepare("UPDATE mail_objects SET json=? WHERE type='EmailSubmission' AND id=?").run(JSON.stringify(queued), id); f.restart();
    const provider = vi.fn(); vi.stubGlobal('fetch', provider); await f.alarm();
    expect(provider).not.toHaveBeenCalled();
    expect(JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(id)?.json))).toMatchObject({ status: 'failed', error: 'authorizationRevokedOrUnavailable' });
  });
});

describe('Trusted inbound recipient and pending draft From', () => {
  it('retains a hidden catch-all recipient through the full ingress worker and fresh full-body Email/get', async () => {
    const f = await fixture();
    const registered = await f.directoryCall('/register-address', { account: accountScope(), address: 'example.com', enabled: true, catchAll: true });
    expect(registered.status).toBe(200);
    const setReject = vi.fn(), forward = vi.fn();
    const env = {
      MAIL_BLOBS: { put: f.env.MAIL_BLOBS.put, async get(key: string) { const value = await f.env.MAIL_BLOBS.get(key); if (!value) return null; if (value.size === undefined) throw new Error('Fixture blob size is missing'); return { ...value, size: value.size }; } },
      MAIL_DIRECTORY: f.env.MAIL_DIRECTORY!,
      MAIL_ACCOUNTS: { idFromName: (name: string) => name, get: (id: unknown) => { expect(id).toBe('account'); return { fetch: f.accountFetch }; } },
      MAIL_CREDENTIALS: { idFromName: (name: string) => name, get: () => ({ async fetch() { return Response.json({ error: 'unused' }, { status: 500 }); } }) },
    };
    await ingress.email({
      from: 'sender@external.test', to: 'hidden-catchall@example.com',
      raw: new Response('From: Sender <sender@external.test>\r\nTo: visible@external.test\r\nDelivered-To: forged@example.com\r\nSubject: Hidden recipient ingress\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nFull ingress body').body!,
      headers: new Headers(), setReject, forward,
    }, env);
    expect(setReject).not.toHaveBeenCalled(); expect(forward).not.toHaveBeenCalled();
    f.restart();
    const query = await f.call('Email/query', { filter: { subject: 'Hidden recipient ingress' } }); expect(query.ids).toHaveLength(1);
    const full = await f.call('Email/get', { ids: query.ids, fetchAllBodyValues: true, maxBodyValueBytes: 0 });
    expect(full.list).toHaveLength(1);
    expect(full.list[0]).toMatchObject({ deliveryRecipient: 'hidden-catchall@example.com', to: [{ email: 'visible@external.test' }] });
    expect(Object.values(full.list[0].bodyValues).map((body: any) => body.value).join(' ')).toContain('Full ingress body');
    expect(await f.storage.get('address:hidden-catchall@example.com')).toBeUndefined();
  });

  it('persists only the SMTP recipient supplied by authenticated ingestion, including hidden Bcc delivery', async () => {
    const f = await fixture();
    f.blobs.set('account/blobs/incoming', new TextEncoder().encode('From: sender@external.test\r\nTo: visible@external.test\r\nDelivered-To: forged@example.com\r\nX-Original-To: forged2@example.com\r\nSubject: Inbound\r\n\r\nBody'));
    const response = await f.ingest({ blobId: 'incoming', to: ' Hidden@EXAMPLE.com ', from: 'sender@external.test' });
    const ingested = await response.json() as any; expect(response.status).toBe(200);
    f.restart(); const read = await f.call('Email/get', { ids: [ingested.id], properties: ['deliveryRecipient', 'to'] });
    expect(read.list[0]).toMatchObject({ deliveryRecipient: 'hidden@example.com', to: [{ email: 'visible@external.test' }] });
    const patch = await f.call('Email/set', { update: { [ingested.id]: { deliveryRecipient: 'forged@example.com' } } });
    expect(patch.notUpdated[ingested.id].description).toContain('Read-only');
  });

  it('does not derive trusted delivery metadata from arbitrary imported headers', async () => {
    const f = await fixture(); f.blobs.set('account/blobs/imported', new TextEncoder().encode('From: sender@external.test\r\nTo: visible@external.test\r\nDelivered-To: forged@example.com\r\n\r\nBody'));
    const result = await f.call('Email/import', { emails: { imported: { blobId: 'imported' } } });
    const read = await f.call('Email/get', { ids: [result.created.imported.id], properties: ['deliveryRecipient'] });
    expect(read.list[0]).not.toHaveProperty('deliveryRecipient');
  });

  it('preserves an incomplete draft From without claiming any identity', async () => {
    const f = await fixture(); const draft = await f.draft([], { draftFrom: 'unfinished@' }); f.restart();
    expect((await f.call('Email/get', { ids: [draft.id] })).list[0]).toMatchObject({ draftFrom: 'unfinished@' });
    expect((await f.call('Identity/get')).list).toEqual([]); expect(await f.storage.get('address:unfinished@')).toBeUndefined();
    const edited = await f.call('Email/set', { update: { [draft.id]: { draftFrom: 'next@' } } }); expect(edited.updated[draft.id]).toBeNull();
    expect((await f.call('Email/get', { ids: [draft.id], properties: ['draftFrom'] })).list[0].draftFrom).toBe('next@');
    const invalid = await f.call('Email/set', { update: { [draft.id]: { draftFrom: 'bad\r\nBcc: injected@external.test' } } }); expect(invalid.notUpdated[draft.id]).toBeDefined();
  });
});

it('sends a confirmed alias with matching SMTP and message From and removes pending draft From from Sent', async () => {
  const f = await fixture(); const identity = (await f.call('Identity/resolve', await f.command())).identity;
  const draft = await f.draft([{ email: identity.email }], { draftFrom: identity.email });
  const accepted = await f.call('EmailSubmission/set', { create: { send: { emailId: draft.id, identityId: identity.id } } });
  const id = accepted.created.send.id;
  const queued = JSON.parse(String(f.db.prepare("SELECT json FROM mail_objects WHERE type='EmailSubmission' AND id=?").get(id)?.json));
  queued.sendAt = new Date(Date.now() - 1).toISOString(); f.db.prepare("UPDATE mail_objects SET json=? WHERE type='EmailSubmission' AND id=?").run(JSON.stringify(queued), id); f.restart();
  f.env.CF_ACCOUNT_ID = 'fixture-account'; f.env.CF_API_TOKEN = 'fixture-token';
  const provider = vi.fn(async (_url: any, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); expect(body.from).toBe('alias@example.com'); return Response.json({ success: true, result: { message_id: 'alias-sent', queued: ['recipient@external.test'] } }); });
  vi.stubGlobal('fetch', provider); await f.alarm(); expect(provider).toHaveBeenCalledTimes(1);
  const submission = (await f.call('EmailSubmission/get', { ids: [id] })).list[0]; expect(submission.status).toBe('sent');
  const sent = (await f.call('Email/get', { ids: [submission.sentEmailId] })).list[0]; expect(sent.from[0].email).toBe('alias@example.com'); expect(sent).not.toHaveProperty('draftFrom');
});

it('rejects a saved pending From that does not match the chosen sending identity', async () => {
  const f = await fixture(); const identity = (await f.call('Identity/resolve', await f.command())).identity;
  const draft = await f.draft([{ email: identity.email }], { draftFrom: 'unfinished@' });
  const result = await f.call('EmailSubmission/set', { create: { send: { emailId: draft.id, identityId: identity.id } } });
  expect(result.notCreated.send.description).toContain('confirm the sending address');
});
