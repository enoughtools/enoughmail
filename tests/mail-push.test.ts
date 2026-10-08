import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MailPushRegistry, chunkPushStates, handlePushJmap, type PushAuthorityProof } from '../apps/mail/src/server/push';
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const proof: PushAuthorityProof = { kind: 'browser', actorId: 'actor', organizationId: 'org', workspaceId: 'ws', accounts: [{ accountId: 'a', lease: 'lease', jobId: 'job' }] };
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db); let allowed = true, fail = false, generation = 0; let alarm: number | null = null;
  const storage = {
    sql: { exec<T>(query: string, ...bindings: unknown[]): Iterable<T> { if (fail && query.startsWith('INSERT')) throw new Error('Injected failure'); const statement = db.prepare(query); return (statement.columns().length ? statement.all(...bindings as any[]) : [statement.run(...bindings as any[])]) as T[]; } },
    transactionSync<T>(task: () => T): T { db.exec('SAVEPOINT push_test'); try { const result = task(); db.exec('RELEASE push_test'); return result; } catch (error) { db.exec('ROLLBACK TO push_test'); db.exec('RELEASE push_test'); throw error; } },
    async setAlarm(value: number) { alarm = value; }, async deleteAlarm() { alarm = null; },
  };
  const env: any = { MAIL_PUSH_ORIGINS: JSON.stringify(['https://push.example.com', 'https://127.0.0.1']), CORE: { async fetch() { return Response.json({ authorization: { allowed, effectiveActions: allowed ? ['mail.read'] : [] }, resource: { id: 'a' }, context: { actorId: 'actor', organizationId: 'org', workspaceId: 'ws' } }); } }, MAIL_ACCOUNTS: { idFromName(value: string) { return value; }, get() { return { async fetch(request: Request) { const input: any = await request.json(); if (new URL(request.url).pathname === '/credential-admission') return Response.json({ allowed, status: allowed ? 'active' : 'suspended', generation }); if (new URL(request.url).pathname === '/push-watch') return Response.json({watched:true}); if (new URL(request.url).pathname !== '/event-state') throw new Error('Unexpected state endpoint'); const context = JSON.parse(request.headers.get('X-Mail-Account-Context')!); expect(context.actor.actions).toEqual(['mail.read']); return Response.json({ states: Object.fromEntries(input.types.map((type: string) => [type, type === 'EmailDelivery' ? 'd1' : 'm1'])) }); } }; } } };
  const registry = new MailPushRegistry({ storage }, env);
  const request = (name: string, args: any = {}, extras: any = {}, path = '/jmap') => registry.fetch(new Request('https://push.internal' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopeId: 'scope', authorityContext: proof, name, args, ...extras }) }));
  const revision = async () => (await (await request('', {}, {}, '/revision')).json() as any).revision;
  const command = async (args: any, extras: any = {}) => request('PushSubscription/set', args, { operationId: crypto.randomUUID(), expectedRevision: await revision(), ...extras });
  const persisted = () => JSON.parse((db.prepare('SELECT data FROM mail_push WHERE id=1').get() as any).data);
  return { registry, env, request, command, revision, persisted, get alarm() { return alarm; }, setAllowed(value: boolean) { allowed = value; }, setGeneration(value: number) { generation = value; }, fail(value: boolean) { fail = value; } };
}
describe('Credential-scoped durable JMAP push', () => {
  it('requires verification, hides URL and keys, delivers actual state, and erases on destroy', async () => {
    const f = fixture(), posts: any[] = []; vi.stubGlobal('fetch', vi.fn(async (_url, init) => { expect(init.redirect).toBe('manual'); posts.push(JSON.parse(new TextDecoder().decode(init.body))); return new Response(null, { status: 201 }); }));
    const create: any = await (await f.command({ create: { d: { deviceClientId: 'hashed-device', url: 'https://push.example.com/callback' } } })).json();
    const id = create.created.d.id; expect(posts).toHaveLength(1); expect(posts[0]['@type']).toBe('PushVerification');
    const get: any = await (await f.request('PushSubscription/get')).json(); expect(get.list[0].verificationCode).toBeNull(); expect(get.list[0]).not.toHaveProperty('url'); expect(get.list[0]).not.toHaveProperty('keys');
    expect(await (await f.request('PushSubscription/get', { properties: ['url'] })).json()).toEqual({ type: 'forbidden' });
    await f.command({ update: { [id]: { verificationCode: posts[0].verificationCode } } }); expect(posts[1]).toMatchObject({ '@type': 'StateChange', changed: { a: { Email: 'm1', EmailDelivery: 'd1' } } });
    await f.command({ destroy: [id] }); expect(f.persisted().subscriptions).toEqual({}); expect(f.alarm).toBeNull();
  });
  it('rechecks authority before every outbound and sends nothing after mid-batch revocation', async () => {
    const f = fixture(), posts: any[] = []; vi.stubGlobal('fetch', vi.fn(async (_url, init) => { posts.push(init); f.setAllowed(false); return new Response(null, { status: 201 }); }));
    await f.command({ create: { one: { deviceClientId: 'one', url: 'https://push.example.com/one' }, two: { deviceClientId: 'two', url: 'https://push.example.com/two' } } });
    expect(posts).toHaveLength(1); expect(f.persisted().subscriptions).toEqual({});
  });
  it('rejects private origins, stale commands and changed-payload replay without publishing secrets', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })));
    const denied: any = await (await f.command({ create: { d: { deviceClientId: 'd', url: 'https://127.0.0.1/private' } } })).json(); expect(denied.notCreated.d.type).toBe('forbidden');
    const operationId = 'receipt'; const args = { create: { d: { deviceClientId: 'd', url: 'https://push.example.com/ok' } } };
    const revision = await f.revision(); const first: any = await (await f.request('PushSubscription/set', args, { operationId, expectedRevision: revision })).json();
    expect(await (await f.request('PushSubscription/set', args, { operationId, expectedRevision: revision })).json()).toEqual(first);
    expect((await (await f.request('PushSubscription/set', { destroy: [] }, { operationId, expectedRevision: revision })).json() as any).type).toBe('invalidArguments');
    expect((await (await f.request('PushSubscription/set', { destroy: [] }, { operationId: 'other', expectedRevision: revision })).json() as any).type).toBe('stateMismatch');
    expect(Object.keys(f.persisted().subscriptions)).toHaveLength(1);
  });
  it('recovers after a failed durable commit and clamps native expiry to current credential', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 }))); f.fail(true);
    expect((await (await f.command({ create: { d: { deviceClientId: 'd', url: 'https://push.example.com/ok' } } })).json() as any).type).toBe('serverFail'); f.fail(false);
    const expiresAt = Date.now() + 3600000;
    const native: any = { kind: 'credential', actorId: 'actor', organizationId: 'org', workspaceId: 'ws', accountId: 'a', lease: 'lease', jobId: 'job', credentialId: 'credential', credentialVersion: 1, actions: ['mail.read'] };
    f.env.MAIL_CREDENTIALS = { idFromName(value: string) { return value; }, get() { return { async fetch() { return Response.json({ credential: { ...native, id: 'credential', version: 1, expiresAt } }); } }; } };
    const response = await f.registry.fetch(new Request('https://push.internal/jmap', { method: 'POST', body: JSON.stringify({ scopeId: 'scope', authorityContext: native, name: 'PushSubscription/set', args: { create: { d: { deviceClientId: 'd', url: 'https://push.example.com/ok' } } }, operationId: 'native', expectedRevision: 0 }) }));
    const result: any = await response.json(); expect(Date.parse(result.created.d.expires)).toBe(expiresAt);
    f.setGeneration(1); await f.registry.alarm(); expect(f.persisted().subscriptions).toEqual({});
  });
  it('keeps standard adapter receipts stable across a lost-response retry', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })));
    f.env.MAIL_PUSH_REGISTRY = { idFromName(value: string) { return value; }, get() { return f.registry; } };
    const auth = { scope: 'scope', proof, operationId: 'stable-request' };
    const args = { create: { device: { deviceClientId: 'd', url: 'https://push.example.com/ok' } } };
    const first = await handlePushJmap(auth, 'PushSubscription/set', args, f.env);
    expect(await handlePushJmap(auth, 'PushSubscription/set', args, f.env)).toEqual(first);
    expect(Object.keys(f.persisted().subscriptions)).toHaveLength(1);
  });
  it('chunks encrypted state hints below RFC8291 limit without losing any accounts or types', () => {
    const changed = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`account-${index}`, { Email: 'x'.repeat(80), Thread: 'y'.repeat(80), Mailbox: 'z'.repeat(80) }]));
    const chunks = chunkPushStates(changed); expect(chunks.length).toBeGreaterThan(1); const merged: any = {};
    for (const chunk of chunks) { expect(new TextEncoder().encode(JSON.stringify({ '@type': 'StateChange', changed: chunk })).length).toBeLessThanOrEqual(3993); for (const [id, types] of Object.entries(chunk)) merged[id] = { ...merged[id], ...types }; }
    expect(merged).toEqual(changed);
  });
});

it('persists browser VAPID identity without exposing private signing keys and waits for changes instead of polling',async()=>{
 const f=fixture();const first:any=await (await f.request('PushSubscription/get')).json(),second:any=await (await f.request('PushSubscription/get')).json();expect(first.applicationServerKey).toBe(second.applicationServerKey);expect(first.applicationServerKey).toHaveLength(87);expect(first).not.toHaveProperty('privateKey');expect(first.deliveryStates).toEqual({a:'d1'});
 const posts:any[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{posts.push(JSON.parse(new TextDecoder().decode(init.body)));return new Response(null,{status:201});}));
 const created:any=await (await f.command({create:{browser:{deviceClientId:'device',url:'https://push.example.com/callback',types:['EmailDelivery']}}})).json();const id=created.created.browser.id;
 await f.command({update:{[id]:{verificationCode:posts[0].verificationCode}}});expect(f.persisted().subscriptions[id].nextAttempt).toBe(Date.parse(f.persisted().subscriptions[id].expires));
 expect((await f.registry.fetch(new Request('https://push.internal/wake',{method:'POST'}))).status).toBe(200);expect(posts).toHaveLength(2);
});
