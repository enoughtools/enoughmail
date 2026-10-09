import { createHash } from 'node:crypto';
import { boundedBytes, type Credential } from './credentials';
import { mailAuthority, type MailAuthorityEnvironment } from './authority';
import type { MailSqlStorage } from './store';
import type { MailObject } from '../domain/model';

export const MAIL_MCP_EVENT = 'mail.email.received';
const DAY = 86_400_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export class MailEventError extends Error {
  constructor(readonly code: number, message: string, readonly reason?: string) { super(message); }
}
export interface MailEventProof {
  accountId: string; organizationId: string; workspaceId: string; actorId: string;
  lease: string; jobId: string; expiresAt: number;
  credentialId?: string; credentialVersion?: number; lifecycleGeneration: number;
}
interface Namespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
export interface MailEventsEnv extends MailAuthorityEnvironment {
  MAIL_CREDENTIALS?: Namespace;
  /** Exact, operator-trusted ChatGPT callback origins; no wildcards or caller additions. */
  MAIL_MCP_CALLBACK_ORIGINS?: string;
}
interface Filters { resourceId: string; from?: string; subject?: string; mailboxId?: string }
interface Subscription { id: string; owner: string; name: string; arguments: Filters; url: string; secret: string; previousSecret?: string; rotateUntil?: number; expiresAt: number; proof: MailEventProof }
interface Pending { id: string; subscription_id: string; body: string; attempts: number; next_attempt: number }
export type WebhookSender = (url: string, init: RequestInit) => Promise<Response>;

export function mailEventDefinition() {
  return { name: MAIL_MCP_EVENT, description: 'An email was accepted through SMTP ingress for this mail account. Imports, drafts, and later edits do not trigger it.', delivery: ['webhook'],
    inputSchema: { type: 'object', properties: { resourceId: { type: 'string', description: 'Mail account ID.', maxLength: 128 }, from: { type: 'string', description: 'Exact sender email address (case insensitive).', maxLength: 320 }, subject: { type: 'string', description: 'Subject substring (case insensitive).', maxLength: 255 }, mailboxId: { type: 'string', description: 'Mailbox after incoming rules.', maxLength: 128 } }, required: ['resourceId'], additionalProperties: false },
    payloadSchema: { type: 'object', properties: { resourceId: { type: 'string' }, emailId: { type: 'string' } }, required: ['resourceId', 'emailId'], additionalProperties: false } };
}
export function eventProofForCredential(value: Credential): MailEventProof {
  return { accountId: value.accountId, organizationId: value.organizationId, workspaceId: value.workspaceId, actorId: value.actorId, lease: value.lease, jobId: value.jobId, expiresAt: value.expiresAt, credentialId: value.id, credentialVersion: value.version, lifecycleGeneration: value.lifecycleGeneration ?? 0 };
}
function filters(value: unknown): Filters {
  if (!object(value) || Object.keys(value).some(key => !['resourceId', 'from', 'subject', 'mailboxId'].includes(key)) || typeof value.resourceId !== 'string' || !value.resourceId || value.resourceId.length > 128) throw new MailEventError(-32602, 'Invalid event filters');
  for (const key of ['from', 'subject', 'mailboxId']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key] || String(value[key]).length > (key === 'from' ? 320 : key === 'subject' ? 255 : 128))) throw new MailEventError(-32602, 'Invalid event filter');
  return { resourceId: value.resourceId, ...(value.from ? { from: String(value.from).toLowerCase() } : {}), ...(value.subject ? { subject: String(value.subject).toLowerCase() } : {}), ...(value.mailboxId ? { mailboxId: String(value.mailboxId) } : {}) };
}
function keyBytes(secret: unknown): Uint8Array<ArrayBuffer> {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new MailEventError(-32602, 'Invalid webhook signing key');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(secret.slice(6)), char => char.charCodeAt(0)); } catch { throw new MailEventError(-32602, 'Invalid webhook signing key'); }
  if (bytes.length < 24 || bytes.length > 64) throw new MailEventError(-32602, 'Invalid webhook signing key');
  return bytes;
}
export function validateCallback(value: unknown, configured?: string): string {
  let url: URL;
  try { if (typeof value !== 'string' || value.length > 2048) throw new Error(); url = new URL(value); } catch { throw new MailEventError(-32602, 'Invalid callback URL'); }
  // Workers fetch cannot pin arbitrary DNS answers. Limit delivery to explicit,
  // operator-trusted provider origins instead of accepting arbitrary destinations.
  const origins = (configured ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !origins.includes(url.origin) || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new MailEventError(-32015, 'Callback origin is not configured as a trusted provider', 'destination_not_allowed');
  return url.href;
}
async function signedRequest(sub: Pick<Subscription, 'id' | 'secret' | 'previousSecret' | 'rotateUntil'>, id: string, body: string): Promise<RequestInit> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signatures = [];
  for (const secret of [sub.secret, ...(sub.previousSecret && (sub.rotateUntil ?? 0) > Date.now() ? [sub.previousSecret] : [])]) {
    const key = await crypto.subtle.importKey('raw', keyBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
    signatures.push('v1,' + btoa(String.fromCharCode(...bytes)));
  }
  // Workers supports only follow/manual. Inspect the response and never follow 3xx.
  return { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': sub.id }, body };
}
async function revalidate(proof: MailEventProof, env: MailEventsEnv): Promise<boolean> {
  const denied = (stage: string, status?: number): false => {
    console.info('EnoughMail event verification', { stage, ...(status !== undefined ? { status } : {}) });
    return false;
  };
  const authority = mailAuthority(env); if (!authority || proof.expiresAt <= Date.now()) return denied('authority_missing_or_expired');
  if (proof.credentialId) {
    if (!env.MAIL_CREDENTIALS) return denied('credential_binding_missing');
    const response = await env.MAIL_CREDENTIALS.get(env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1')).fetch(new Request('https://mail-credentials.internal/lookup-id', { method: 'POST', body: JSON.stringify({ id: proof.credentialId, version: proof.credentialVersion, accountId: proof.accountId }) }));
    if (!response.ok) throw new Error('Credential authority unavailable');
    const { credential } = await response.json() as { credential: Credential | null };
    if (!credential) return denied('credential_not_found');
    const matches = { id: credential.id === proof.credentialId, version: credential.version === proof.credentialVersion, active: credential.expiresAt > Date.now() && credential.revokedAt === null, account: credential.accountId === proof.accountId, actor: credential.actorId === proof.actorId, organization: credential.organizationId === proof.organizationId, workspace: credential.workspaceId === proof.workspaceId, lease: credential.lease === proof.lease, job: credential.jobId === proof.jobId, generation: (credential.lifecycleGeneration ?? 0) === proof.lifecycleGeneration, read: credential.actions.includes('mail.read') };
    if (Object.values(matches).some(value => !value)) {
      console.info('EnoughMail event verification', { stage: 'credential_mismatch', fields: Object.keys(matches).filter(key => !matches[key as keyof typeof matches]) });
      return false;
    }
  }
  const response = await authority.fetch(new Request(`https://mail-authority.internal/internal/native-resources/${encodeURIComponent(proof.accountId)}/revalidate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lease: proof.lease, jobId: proof.jobId, actions: ['mail.read'] }) }));
  if (response.status === 403 || response.status === 404 || response.status === 401) return denied('native_authority_denied', response.status);
  if (!response.ok) throw new Error('Mail authority unavailable');
  const value = await response.json() as any;
  const allowed = value.authorization?.allowed === true && value.authorization.effectiveActions?.includes('mail.read') && value.resource?.id === proof.accountId && value.resource?.ownerAppId === 'mail' && value.resource?.resourceType === 'mail.account' && value.context?.actorId === proof.actorId && value.context?.organizationId === proof.organizationId && value.context?.workspaceId === proof.workspaceId;
  return allowed || denied('native_authority_mismatch');
}

/** Account-local durable subscriptions and outbox. Called under the account queue. */
export class MailMcpEvents {
  constructor(private storage: MailSqlStorage, private env: MailEventsEnv, private send: WebhookSender = (url, init) => fetch(url, init)) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_mcp_subscriptions(id TEXT PRIMARY KEY,json TEXT NOT NULL,expires INTEGER NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS mail_mcp_outbox(id TEXT NOT NULL,subscription_id TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,subscription_id))');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS mail_mcp_due ON mail_mcp_outbox(next_attempt)');
  }
  private subscriptions(): Subscription[] { return [...this.storage.sql.exec<{ json: string }>('SELECT json FROM mail_mcp_subscriptions ORDER BY id')].map(row => JSON.parse(row.json)); }
  private remove(id: string) { this.storage.sql.exec('DELETE FROM mail_mcp_outbox WHERE subscription_id=?', id); this.storage.sql.exec('DELETE FROM mail_mcp_subscriptions WHERE id=?', id); }
  clear() { this.storage.transactionSync(() => { this.storage.sql.exec('DELETE FROM mail_mcp_outbox'); this.storage.sql.exec('DELETE FROM mail_mcp_subscriptions'); }); }
  private prune() { for (const sub of this.subscriptions()) if (sub.expiresAt <= Date.now()) this.remove(sub.id); }
  async command(method: string, params: unknown, owner: string, proof: MailEventProof): Promise<unknown> {
    this.prune();
    // Protocol envelopes may include client metadata and extension fields.
    // Read only the supported fields; account filters and authority stay exact.
    if (!object(params) || params.name !== MAIL_MCP_EVENT || !object(params.delivery) || params.delivery.mode !== 'webhook') throw new MailEventError(-32602, 'Invalid event subscription', 'invalid_event_or_delivery');
    if (params.maxAgeMs !== undefined && params.maxAgeMs !== null && (!Number.isSafeInteger(params.maxAgeMs) || Number(params.maxAgeMs) < 0)) throw new MailEventError(-32602, 'Invalid replay age', 'invalid_max_age');
    const args = filters(params.arguments);
    if (args.resourceId !== proof.accountId || !owner || proof.expiresAt <= Date.now()) throw new MailEventError(-32602, 'Account is not authorized');
    const url = validateCallback(params.delivery.url, this.env.MAIL_MCP_CALLBACK_ORIGINS);
    const id = 'sub_' + createHash('sha256').update(JSON.stringify([owner, proof.accountId, url, params.name, args])).digest('hex');
    if (method === 'events/unsubscribe') { this.storage.transactionSync(() => this.remove(id)); return {}; }
    if (method !== 'events/subscribe') throw new MailEventError(-32601, 'Unknown event method');
    if (params.cursor !== undefined && params.cursor !== null) throw new MailEventError(-32602, 'This event does not support replay');
    if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || Number(params.ttlMs) <= 0)) throw new MailEventError(-32602, 'Invalid subscription lifetime');
    keyBytes(params.delivery.secret);
    const previous = this.subscriptions().find(sub => sub.id === id);
    if (!previous && this.subscriptions().length >= 100) throw new MailEventError(-32000, 'Account subscription limit reached');
    const expiresAt = Math.min(proof.expiresAt, Date.now() + Math.min(DAY, Number(params.ttlMs ?? DAY)));
    const sub: Subscription = { id, owner, name: MAIL_MCP_EVENT, arguments: args, url, secret: String(params.delivery.secret), expiresAt, proof, ...(previous && previous.secret !== params.delivery.secret ? { previousSecret: previous.secret, rotateUntil: Date.now() + 300_000 } : previous?.rotateUntil && previous.rotateUntil > Date.now() ? { previousSecret: previous.previousSecret, rotateUntil: previous.rotateUntil } : {}) };
    const challenge = crypto.randomUUID(), verification = JSON.stringify({ type: 'verification', challenge });
    let verificationStage = 'permission_before_callback';
    let callbackStatus: number | undefined;
    try {
      if (!await revalidate(proof, this.env)) throw new Error('Permission revoked');
      verificationStage = 'callback_request';
      const response = await this.send(url, await signedRequest(sub, 'verification_' + crypto.randomUUID(), verification));
      callbackStatus = response.status;
      verificationStage = 'callback_status';
      if (!response.ok) { await response.body?.cancel(); throw new Error('Callback rejected verification'); }
      verificationStage = 'callback_json';
      const echo = JSON.parse(new TextDecoder().decode(await boundedBytes(new Request('https://verification.internal', { method: 'POST', body: response.body, duplex: 'half' } as RequestInit), 4096)));
      verificationStage = 'callback_challenge';
      if (typeof echo.challenge !== 'string' || echo.challenge.length !== challenge.length || [...challenge].reduce((different, char, index) => different | (char.charCodeAt(0) ^ echo.challenge.charCodeAt(index)), 0) !== 0) throw new Error('Callback challenge mismatch');
      verificationStage = 'permission_after_callback';
      if (!await revalidate(proof, this.env)) throw new Error('Permission revoked');
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'Unknown';
      const runtimeReason = error instanceof Error && error.message.includes('Illegal invocation') ? 'illegal_invocation'
        : error instanceof Error && error.message.includes('different request') ? 'io_context'
        : error instanceof Error && error.message.includes('fetch failed') ? 'fetch_failed' : 'verification_failed';
      console.info('EnoughMail event verification', { stage: verificationStage, ...(callbackStatus !== undefined ? { callbackStatus } : {}), errorType, runtimeReason });
      throw new MailEventError(-32015, 'Callback verification failed', 'challenge_failed');
    }
    this.storage.sql.exec('INSERT INTO mail_mcp_subscriptions(id,json,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,expires=excluded.expires', id, JSON.stringify(sub), expiresAt);
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }
  /** Must run inside the same SQL transaction as the accepted SMTP receipt. */
  received(resourceId: string, email: MailObject, deliveryId: string) {
    this.prune();
    for (const sub of this.subscriptions()) {
      const filter = sub.arguments;
      if (filter.resourceId !== resourceId || filter.from && !(email.from ?? []).some((from: any) => String(from.email).toLowerCase() === filter.from) || filter.subject && !String(email.subject ?? '').toLowerCase().includes(filter.subject) || filter.mailboxId && !email.mailboxIds?.[filter.mailboxId]) continue;
      const pending = [...this.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM mail_mcp_outbox WHERE subscription_id=?', sub.id)][0].n;
      if (pending >= 1000) { this.remove(sub.id); continue; } // Bounded failure: stop an overloaded subscription, never reject incoming mail.
      const id = 'evt_' + createHash('sha256').update(JSON.stringify([resourceId, deliveryId])).digest('hex');
      const body = JSON.stringify({ eventId: id, name: MAIL_MCP_EVENT, timestamp: email.receivedAt, data: { resourceId, emailId: email.id }, cursor: null });
      this.storage.sql.exec('INSERT OR IGNORE INTO mail_mcp_outbox(id,subscription_id,body) VALUES(?,?,?)', id, sub.id, body);
    }
  }
  next(): number | undefined {
    const next = [...this.storage.sql.exec<{ at: number | null }>('SELECT min(next_attempt) at FROM mail_mcp_outbox')][0]?.at;
    const expiry = [...this.storage.sql.exec<{ at: number | null }>('SELECT min(expires) at FROM mail_mcp_subscriptions')][0]?.at;
    const times = [next, expiry].filter((value): value is number => value !== null && value !== undefined);
    return times.length ? Math.min(...times) : undefined;
  }
  async deliver(lifecycleGeneration: number, active: boolean): Promise<void> {
    this.prune();
    if (!active) { this.clear(); return; }
    for (const item of this.storage.sql.exec<Pending>('SELECT * FROM mail_mcp_outbox WHERE next_attempt<=? ORDER BY next_attempt,id LIMIT 20', Date.now())) {
      const sub = this.subscriptions().find(value => value.id === item.subscription_id);
      if (!sub) { this.storage.sql.exec('DELETE FROM mail_mcp_outbox WHERE id=? AND subscription_id=?', item.id, item.subscription_id); continue; }
      let retry = true;
      try {
        validateCallback(sub.url, this.env.MAIL_MCP_CALLBACK_ORIGINS);
        const init = await signedRequest(sub, item.id, item.body);
        if (sub.proof.lifecycleGeneration !== lifecycleGeneration || !await revalidate(sub.proof, this.env)) { this.storage.transactionSync(() => this.remove(sub.id)); continue; }
        const response = await this.send(sub.url, init);
        await response.body?.cancel();
        if (response.status === 410 || response.status >= 400 && response.status < 500 && ![408, 413, 429].includes(response.status)) { this.storage.transactionSync(() => this.remove(sub.id)); continue; }
        retry = !response.ok && response.status !== 413;
      } catch { /* Authority outages and transient transport failures share bounded retry. */ }
      if (!retry || item.attempts >= 7) this.storage.sql.exec('DELETE FROM mail_mcp_outbox WHERE id=? AND subscription_id=?', item.id, sub.id);
      else this.storage.sql.exec('UPDATE mail_mcp_outbox SET attempts=attempts+1,next_attempt=? WHERE id=? AND subscription_id=?', Date.now() + Math.min(3600_000, 30_000 * 2 ** item.attempts), item.id, sub.id);
    }
  }
}
