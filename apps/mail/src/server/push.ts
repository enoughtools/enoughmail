import {createVapidKeys,vapidAuthorization,type VapidKeys} from './webpush-vapid';
import { mailAuthority, type MailAuthorityEnvironment } from './authority';
import { encryptWebPushPayload } from './webpush-encryption';

interface Storage { sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T> }; transactionSync<T>(callback: () => T): T; setAlarm(time: number): Promise<void>; deleteAlarm(): Promise<void> }
interface Authority { fetch(request: Request): Promise<Response> }
interface Namespace { idFromName(name: string): unknown; get(id: unknown): Authority }
interface AccountProof { accountId: string; lease: string; jobId: string }
export type PushAuthorityProof = { kind: 'browser'; actorId: string; organizationId: string; workspaceId: string; accounts: AccountProof[] } | { kind: 'credential'; actorId: string; organizationId: string; workspaceId: string; credentialId: string; credentialVersion: number; accountId: string; lease: string; jobId: string; actions: string[] };
export interface MailPushEnv extends MailAuthorityEnvironment {  MAIL_ACCOUNTS?: Namespace; MAIL_CREDENTIALS?: Namespace; MAIL_PUSH_REGISTRY?: Namespace; MAIL_PUSH_ORIGINS?: string; MAIL_PUSH_SUBJECT?:string }
interface Keys { p256dh: string; auth: string }
interface Subscription { id: string; deviceClientId: string; url: string; keys: Keys | null; code: string; verified: boolean; expires: string; types: string[] | null; nextAttempt: number; failures: number; lastStates: Record<string, Record<string, string>> }
interface PushState { vapid?: VapidKeys; revision: number; scopeId: string; authorityContext: unknown; subscriptions: Record<string, Subscription>; receipts?: Record<string, { fingerprint: string; result: unknown }> }
const TYPES = new Set(['Email', 'Mailbox', 'Thread', 'Identity', 'EmailSubmission', 'EmailDelivery', 'VacationResponse', 'Rule', 'Contact', 'Domain', 'Template']);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const problem = (type: string, description?: string) => ({ type, ...(description ? { description } : {}) });
export function chunkPushStates(changed: Record<string, Record<string, string>>): Record<string, Record<string, string>>[] {
  const chunks: Record<string, Record<string, string>>[] = []; let chunk: Record<string, Record<string, string>> = {};
  for (const [account, types] of Object.entries(changed)) for (const [type, state] of Object.entries(types)) {
    const candidate = { ...chunk, [account]: { ...chunk[account], [type]: state } };
    if (new TextEncoder().encode(JSON.stringify({ '@type': 'StateChange', changed: candidate })).length > 3993) {
      if (!Object.keys(chunk).length) throw new Error('Push state is too large');
      chunks.push(chunk); chunk = { [account]: { [type]: state } };
    } else chunk = candidate;
  }
  if (Object.keys(chunk).length) chunks.push(chunk);
  return chunks;
}

/** Recheck admission, exact account grants and credential lifetime before every push request. */
export async function authorizePush(proof: PushAuthorityProof, env: MailPushEnv): Promise<{ active: boolean; changed: Record<string, Record<string, string>>; expiresAt?: number }> {
  if (!proof || !mailAuthority(env) || !env.MAIL_ACCOUNTS || typeof proof.actorId !== 'string' || typeof proof.organizationId !== 'string' || typeof proof.workspaceId !== 'string') return { active: false, changed: {} };
  let accounts: AccountProof[];
  let expiresAt: number | undefined;
  if (proof.kind === 'credential') {
    if (!env.MAIL_CREDENTIALS || !Array.isArray(proof.actions) || !proof.actions.includes('mail.read')) return { active: false, changed: {} };
    const response = await env.MAIL_CREDENTIALS.get(env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://mail-credentials.internal/lookup-id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: proof.credentialId, version: proof.credentialVersion }) }));
    if (!response.ok) return { active: false, changed: {} };
    const value: any = await response.json(); const credential = value.credential ?? value;
    if (!credential || credential.id !== proof.credentialId || credential.version !== proof.credentialVersion || credential.actorId !== proof.actorId || credential.accountId !== proof.accountId || credential.organizationId !== proof.organizationId || credential.workspaceId !== proof.workspaceId || !credential.actions?.includes('mail.read') || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= Date.now()) return { active: false, changed: {} };
    expiresAt = credential.expiresAt;
    const admissionResponse = await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(proof.accountId)).fetch(new Request('https://mail-account.internal/credential-admission', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mail-Account-Context': JSON.stringify({ accountId: proof.accountId, organizationId: proof.organizationId, workspaceId: proof.workspaceId, actor: { id: proof.actorId, actions: ['mail.read'] } }) }, body: '{}' }));
    const admission: any = await admissionResponse.json();
    if (!admissionResponse.ok || admission.allowed !== true || admission.status !== 'active' || !Number.isSafeInteger(admission.generation) || admission.generation < 0 || admission.generation !== (credential.lifecycleGeneration ?? 0)) return { active: false, changed: {} };
    accounts = [{ accountId: proof.accountId, lease: proof.lease, jobId: proof.jobId }];
  } else if (proof.kind === 'browser' && Array.isArray(proof.accounts) && proof.accounts.length <= 100) accounts = proof.accounts;
  else return { active: false, changed: {} };
  const changed: Record<string, Record<string, string>> = {};
  for (const account of accounts) {
    if (typeof account.accountId !== 'string' || typeof account.lease !== 'string' || typeof account.jobId !== 'string') return { active: false, changed: {} };
    const response = await mailAuthority(env)!.fetch(new Request(`https://mail-authority.internal/internal/native-resources/${encodeURIComponent(account.accountId)}/revalidate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lease: account.lease, jobId: account.jobId, actions: ['mail.read'] }) }));
    if (!response.ok) return { active: false, changed: {} };
    const value: any = await response.json();
    if (!value.authorization?.allowed || !value.authorization.effectiveActions?.includes('mail.read') || value.resource?.id !== account.accountId || value.context?.actorId !== proof.actorId || value.context?.organizationId !== proof.organizationId || value.context?.workspaceId !== proof.workspaceId) return { active: false, changed: {} };
    const types = [...TYPES];
    const stateResponse = await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(account.accountId)).fetch(new Request('https://mail-account.internal/event-state', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mail-Account-Context': JSON.stringify({ accountId: account.accountId, organizationId: proof.organizationId, workspaceId: proof.workspaceId, actor: { id: proof.actorId, actions: ['mail.read'] } }) }, body: JSON.stringify({ types }) }));
    if (!stateResponse.ok) throw new Error('Push states unavailable');
    const data: any = await stateResponse.json();
    if (!data.states || typeof data.states !== 'object' || Array.isArray(data.states) || Object.entries(data.states).some(([type, state]) => !TYPES.has(type) || typeof state !== 'string')) throw new Error('Invalid push states');
    changed[account.accountId] = data.states;
  }
  return { active: accounts.length > 0, changed, ...(expiresAt ? { expiresAt } : {}) };
}

export async function handlePushJmap(auth: { scope: string; proof: PushAuthorityProof; operationId?: string }, name: string, args: Record<string, any>, env: MailPushEnv): Promise<any> {
  if (!env.MAIL_PUSH_REGISTRY) return problem('serverFail', 'Push registry is unavailable');
  const stub = env.MAIL_PUSH_REGISTRY.get(env.MAIL_PUSH_REGISTRY.idFromName(auth.scope));
  const operationId = auth.operationId ?? crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    let expectedRevision: number | undefined;
    if (name === 'PushSubscription/set') {
      const observed = await stub.fetch(new Request('https://mail-push.internal/revision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopeId: auth.scope, authorityContext: auth.proof }) }));
      const value: any = await observed.json(); if (!observed.ok || !Number.isSafeInteger(value.revision)) return value;
      expectedRevision = value.revision;
    }
    const response = await stub.fetch(new Request('https://mail-push.internal/jmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopeId: auth.scope, authorityContext: auth.proof, name, args, operationId, expectedRevision }) }));
    const value: any = await response.json(); if (value.type !== 'stateMismatch') {
      if(!value.type&&env.MAIL_ACCOUNTS){const proof=auth.proof;const accounts=proof.kind==='browser'?proof.accounts:[{accountId:proof.accountId}];for(const account of accounts){const watched=await env.MAIL_ACCOUNTS.get(env.MAIL_ACCOUNTS.idFromName(account.accountId)).fetch(new Request('https://mail-account.internal/push-watch',{method:'POST',headers:{'Content-Type':'application/json','X-Mail-Account-Context':JSON.stringify({accountId:account.accountId,organizationId:proof.organizationId,workspaceId:proof.workspaceId,actor:{id:proof.actorId,actions:['mail.read']}})},body:JSON.stringify({registryId:auth.scope,expiresAt:Date.now()+31*86400000})}));if(!watched.ok){console.warn('Mail push watch failed',{status:watched.status});throw new Error('Push change notifications could not be registered');}}}
      return value;
    }
  }
  return problem('serverFail', 'Push command could not acquire a current revision');
}

/** Credential-scoped push authority; public routes must never bind directly to this object. */
export class MailPushRegistry {
  private state: PushState | null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: { storage: Storage }, private readonly env: MailPushEnv) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_push (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL)');
    const row = [...ctx.storage.sql.exec<{ data: string }>('SELECT data FROM mail_push WHERE id=1')][0];
    this.state = row ? JSON.parse(row.data) : null;
  }
  private serial<T>(task: () => Promise<T>): Promise<T> { const result = this.queue.then(task); this.queue = result.catch(() => undefined); return result; }
  private save(): void {
    const state = this.state!; const old = state.revision;
    this.ctx.storage.transactionSync(() => {
      const existing = [...this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM mail_push WHERE id=1')][0];
      if (existing && existing.revision !== old) throw new Error('Push revision conflict');
      this.ctx.storage.sql.exec('INSERT INTO mail_push(id,revision,data) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data', old + 1, JSON.stringify({ ...state, revision: old + 1 }));
    });
    state.revision = old + 1;
  }
  private async authority(): Promise<{ active: boolean; changed: Record<string, Record<string, string>>; expiresAt?: number }> {
    if (!this.state) return { active: false, changed: {} };
    const result = await authorizePush(this.state.authorityContext as PushAuthorityProof, this.env);
    if (typeof result.active !== 'boolean' || !result.changed || typeof result.changed !== 'object' || Array.isArray(result.changed)) throw new Error('Invalid push authority response');
    for (const types of Object.values(result.changed) as any[]) if (!types || typeof types !== 'object' || Object.entries(types).some(([type, state]) => !TYPES.has(type) || typeof state !== 'string')) throw new Error('Invalid push states');
    return result;
  }
  private public(subscription: Subscription): Record<string, unknown> { return { id: subscription.id, deviceClientId: subscription.deviceClientId, verificationCode: subscription.verified ? subscription.code : null, expires: subscription.expires, types: subscription.types }; }
  private url(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid push URL');
    const url = new URL(value);
    let origins: unknown; try { origins = JSON.parse(this.env.MAIL_PUSH_ORIGINS ?? '[]'); } catch { throw new Error('Push origins are not configured'); }
    if (!Array.isArray(origins) || !origins.every(origin => typeof origin === 'string' && new URL(origin).origin === origin && new URL(origin).protocol === 'https:')) throw new Error('Push origin configuration is invalid');
    // Restrict to operator-controlled public DNS origins. Fetch cannot pin DNS;
    // an allowlist is a trust boundary, not a claim of generic rebinding protection.
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !origins.includes(url.origin) || !host.includes('.') || /^\[|^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(localhost|local|internal|invalid|test|home|lan)$/.test(host)) throw new Error('Push origin is not approved');
    return url.href;
  }
  private expiry(value: unknown, authorityExpires?: number): string {
    const now = Date.now(), maximum = Math.min(now + 30 * 86400000, authorityExpires ?? Infinity);
    if (value === null || value === undefined) return new Date(Math.min(now + 7 * 86400000, maximum)).toISOString();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now) throw new Error('Invalid push expiry');
    return new Date(Math.min(Date.parse(value), maximum)).toISOString();
  }
  private types(value: unknown): string[] | null {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.some(type => typeof type !== 'string' || !TYPES.has(type))) throw new Error('Invalid push types');
    return [...new Set(value)] as string[];
  }
  private async post(subscription: Subscription, payload: unknown): Promise<void> {
    this.url(subscription.url); // Configuration removal immediately prevents subsequent delivery.
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const body = subscription.keys ? await encryptWebPushPayload(bytes, subscription.keys) : bytes;
    const headers: Record<string, string> = { 'Content-Type': subscription.keys ? 'application/octet-stream' : 'application/json', TTL: '60' };
    if (subscription.keys) { headers['Content-Encoding'] = 'aes128gcm'; if(this.state?.vapid) headers.Authorization=await vapidAuthorization(this.state.vapid,subscription.url,this.env.MAIL_PUSH_SUBJECT); }
    const current = await this.authority();
    if (!current.active || Date.parse(subscription.expires) <= Date.now() || (current.expiresAt !== undefined && current.expiresAt <= Date.now())) throw new Error('Push authority revoked');
    const advertised = (payload as any)?.changed;
    if (advertised && Object.entries(advertised).some(([accountId, types]) => Object.keys(types as object).some(type => typeof current.changed[accountId]?.[type] !== 'string'))) throw new Error('Push authority revoked');
    const response = await fetch(subscription.url, { method: 'POST', body: body as BodyInit, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    await response.body?.cancel();
    console.info('Mail push delivery',{status:response.status,kind:(payload as any)?.['@type']});
    if (!response.ok) throw new Error(`Push HTTP ${response.status}`);
  }
  private erase(subscription: Subscription): void { subscription.url = ''; subscription.keys = null; subscription.code = ''; delete this.state!.subscriptions[subscription.id]; }
  private async process(): Promise<void> {
    if (!this.state) return;
    const now = Date.now();
    for (const item of Object.values(this.state.subscriptions)) if (Date.parse(item.expires) <= now) this.erase(item);
    if (!Object.keys(this.state.subscriptions).length) { this.save(); await this.ctx.storage.deleteAlarm(); return; }
    let authority;
    try { authority = await this.authority(); } catch { await this.ctx.storage.setAlarm(now + 60000); return; }
    if (!authority.active) { for (const item of Object.values(this.state.subscriptions)) this.erase(item); this.save(); await this.ctx.storage.deleteAlarm(); return; }
    for (const item of Object.values(this.state.subscriptions)) {
      if (item.nextAttempt > now) continue;
      const changed: Record<string, Record<string, string>> = {};
      for (const [accountId, types] of Object.entries(authority.changed)) for (const [type, state] of Object.entries(types)) {
        if ((!item.types || item.types.includes(type)) && item.lastStates[accountId]?.[type] !== state) (changed[accountId] ??= {})[type] = state;
      }
      try {
        if (!item.verified) await this.post(item, { '@type': 'PushVerification', pushSubscriptionId: item.id, verificationCode: item.code });
        else if (Object.keys(changed).length) {
          for (const chunk of chunkPushStates(changed).slice(0, 8)) {
            await this.post(item, { '@type': 'StateChange', changed: chunk });
            for (const [account, types] of Object.entries(chunk)) item.lastStates[account] = { ...item.lastStates[account], ...types };
            this.save();
          }
        }
        item.failures = 0; item.nextAttempt = item.verified ? Date.parse(item.expires) : now + 300000;
      } catch (error) { console.warn('Mail push delivery failed',{code:error instanceof Error?error.name:'unknown'}); if (String(error).includes('authority revoked')) { for (const row of Object.values(this.state.subscriptions)) this.erase(row); this.save(); await this.ctx.storage.deleteAlarm(); return; } item.failures++; item.nextAttempt = now + Math.min(3600000, 60000 * 2 ** Math.min(item.failures, 6)); }
      this.save();
    }
    this.save(); await this.schedule();
  }
  private async schedule(): Promise<void> {
    const rows = Object.values(this.state?.subscriptions ?? {});
    if (!rows.length) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...rows.flatMap(row => [row.nextAttempt, Date.parse(row.expires)]))));
  }
  async fetch(request: Request): Promise<Response> { return this.serial(async () => {
    const before = this.state ? JSON.parse(JSON.stringify(this.state)) : null;
    try {
      const path = new URL(request.url).pathname;
      if(path==='/wake'&&request.method==='POST'){if(this.state){for(const item of Object.values(this.state.subscriptions))if(item.verified&&item.failures===0)item.nextAttempt=Date.now();this.save();await this.process();}return json({awakened:true});}
      if (request.method !== 'POST' || !['/jmap', '/revision'].includes(path)) return json(problem('notFound'), 404);
      const input: any = await request.json();
      if (typeof input.scopeId !== 'string' || input.scopeId.length < 1 || input.scopeId.length > 256 || !input.authorityContext) return json(problem('forbidden'), 403);
      if (this.state && this.state.scopeId !== input.scopeId) return json(problem('forbidden'), 403);
      this.state ??= { revision: 0, scopeId: input.scopeId, authorityContext: input.authorityContext, subscriptions: {} };
      this.state.authorityContext = input.authorityContext;
      const authority = await this.authority(); if (!authority.active) return json(problem('forbidden'), 403);
      if (path === '/revision') return json({ revision: this.state.revision });
      const args = input.args ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args) || 'accountId' in args || 'ifInState' in args) return json(problem('invalidArguments'));
      if (input.name === 'PushSubscription/get') {
        if (args.properties != null && (!Array.isArray(args.properties) || args.properties.some((property: unknown) => typeof property !== 'string'))) return json(problem('invalidArguments'));
        if (args.properties?.some((property: string) => ['url', 'keys'].includes(property))) return json(problem('forbidden'));
        const ids = args.ids ?? Object.keys(this.state.subscriptions);
        if (!Array.isArray(ids) || ids.length > 500 || ids.some((id: unknown) => typeof id !== 'string')) return json(problem('invalidArguments'));
        const list = ids.filter((id: string) => this.state!.subscriptions[id]).map((id: string) => this.public(this.state!.subscriptions[id]));
        if (args.properties) for (let index = 0; index < list.length; index++) list[index] = Object.fromEntries(['id', ...args.properties].map(property => [property, list[index][property]]));
        if ((input.authorityContext as PushAuthorityProof).kind === 'browser') this.state.vapid ??= await createVapidKeys();
        this.save(); return json({ list, notFound: ids.filter((id: string) => !this.state!.subscriptions[id]), ...((input.authorityContext as PushAuthorityProof).kind === 'browser' ? {applicationServerKey:this.state.vapid!.publicKey,deliveryStates:Object.fromEntries(Object.entries(authority.changed).map(([id,types])=>[id,types.EmailDelivery]))} : {}) });
      }
      if (input.name !== 'PushSubscription/set') return json(problem('unknownMethod'));
      if (['create', 'update'].some(key => args[key] != null && (typeof args[key] !== 'object' || Array.isArray(args[key]))) || (args.destroy != null && (!Array.isArray(args.destroy) || args.destroy.some((id: unknown) => typeof id !== 'string')))) return json(problem('invalidArguments'));
      if (typeof input.operationId !== 'string' || !input.operationId || !Number.isSafeInteger(input.expectedRevision)) return json(problem('invalidArguments', 'Internal command identity and revision required'));
      const fingerprint = JSON.stringify([input.name, args]); this.state.receipts ??= {};
      const previous = this.state.receipts[input.operationId];
      if (previous) return json(previous.fingerprint === fingerprint ? previous.result : problem('invalidArguments', 'Operation reused for different request'));
      if (input.expectedRevision !== this.state.revision) return json(problem('stateMismatch'));
      const result: any = { created: {}, updated: {}, destroyed: [], notCreated: {}, notUpdated: {}, notDestroyed: {} };
      if (Object.keys(args.create ?? {}).length + Object.keys(args.update ?? {}).length + (args.destroy?.length ?? 0) > 500) return json(problem('requestTooLarge'));
      for (const [creationId, raw] of Object.entries(args.create ?? {}) as [string, any][]) {
        try {
          if (Object.keys(this.state.subscriptions).length >= 20) throw new Error('Push subscription quota reached');
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['deviceClientId', 'url', 'keys', 'verificationCode', 'expires', 'types'].includes(key))) throw new Error('Invalid push properties');
          if (typeof raw.deviceClientId !== 'string' || !raw.deviceClientId.length || raw.deviceClientId.length > 255 || raw.verificationCode != null) throw new Error('Invalid device/verification code');
          const url = this.url(raw.url); const keys: Keys | null = raw.keys ?? null;
          if (keys) await encryptWebPushPayload(new Uint8Array(), keys); // Strict key validation before any durable success.
          const id = crypto.randomUUID(), code = crypto.randomUUID().replaceAll('-', '');
          const item: Subscription = { id, code, url, keys, deviceClientId: raw.deviceClientId, verified: false, expires: this.expiry(raw.expires, authority.expiresAt), types: this.types(raw.types), nextAttempt: Date.now(), failures: 0, lastStates: {} };
          this.state.subscriptions[id] = item; result.created[creationId] = { id, expires: item.expires };
        } catch (error) { result.notCreated[creationId] = problem(String(error).includes('approved') ? 'forbidden' : 'invalidProperties', String(error)); }
      }
      for (const [id, patch] of Object.entries(args.update ?? {}) as [string, any][]) {
        const item = this.state.subscriptions[id]; if (!item) { result.notUpdated[id] = problem('notFound'); continue; }
        try {
          if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['expires', 'types', 'verificationCode'].includes(key))) throw new Error('Immutable push property');
          if ('verificationCode' in patch && patch.verificationCode !== item.code) throw new Error('Invalid verification code');
          const next = { ...item };
          if ('verificationCode' in patch) next.verified = true;
          if ('expires' in patch) next.expires = this.expiry(patch.expires, authority.expiresAt);
          if ('types' in patch) next.types = this.types(patch.types);
          next.nextAttempt = Date.now(); this.state.subscriptions[id] = next; result.updated[id] = null;
        } catch (error) { result.notUpdated[id] = problem('invalidProperties', String(error)); }
      }
      for (const id of args.destroy ?? []) { const item = this.state.subscriptions[id]; if (!item) result.notDestroyed[id] = problem('notFound'); else { this.erase(item); result.destroyed.push(id); } }
      this.state.receipts[input.operationId] = { fingerprint, result };
      const receipts = Object.keys(this.state.receipts); if (receipts.length > 1000) delete this.state.receipts[receipts[0]];
      this.save(); await this.process(); return json(result);
    } catch { const row = [...this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM mail_push WHERE id=1')][0]; this.state = row ? JSON.parse(row.data) : before; return json(problem('serverFail'), 503); }
  }); }
  async alarm(): Promise<void> { return this.serial(() => this.process()); }
}
