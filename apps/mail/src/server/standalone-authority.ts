import type { NativeResource, Principal } from '@open-cloud/contracts';
import type { DirectoryStorage } from './directory';

export interface StandaloneAuthorityEnv {
  MAIL_OWNER_SUBJECT?: string;
  /** JSON array of additional Cloudflare Access subjects admitted as members. */
  MAIL_MEMBER_SUBJECTS?: string;
  AUTH_PROVIDER: string;
}
const actions = ['mail.read', 'mail.organize', 'mail.draft', 'mail.send', 'mail.manage'];
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const scope = { organizationId: 'enough-mail', workspaceId: 'standalone' };
type Account = NativeResource & { grants: { actorId: string; actions: string[] }[] };
type Lease = { accountId: string; actorId: string; jobId: string; actions: string[]; expiresAt: number };
class Denied extends Error { constructor(readonly status = 403, readonly code = 'permission_denied') { super(code); } }

/** Mail-owned authority, reachable exclusively through a Durable Object binding.
 * Explicit configured admission prevents the first visitor becoming an owner.
 * Random server-held leases are opaque and checked against live admission/grants.
 */
export class StandaloneMailAuthority {
  constructor(private readonly ctx: { storage: DirectoryStorage }, private readonly env: StandaloneAuthorityEnv) {}
  private role(actorId: string): 'owner' | 'member' | undefined {
    if (!this.env.MAIL_OWNER_SUBJECT || !['cloudflare-access', 'local'].includes(this.env.AUTH_PROVIDER)) return;
    if (actorId === this.env.MAIL_OWNER_SUBJECT) return 'owner';
    const members: unknown = JSON.parse(this.env.MAIL_MEMBER_SUBJECTS ?? '[]');
    if (Array.isArray(members) && members.includes(actorId)) return 'member';
  }
  private effective(account: Account, actorId: string): string[] {
    if (!this.role(actorId)) return [];
    return account.ownerActorId === actorId ? [...actions] : account.grants.find(grant => grant.actorId === actorId)?.actions ?? [];
  }
  private publicAccount(account: Account, actorId: string): NativeResource {
    const { grants: _, ...resource } = account;
    return { ...resource, effectiveActions: this.effective(account, actorId) };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      const internal = path.startsWith('/internal/native-resources/');
      const body: any = request.method === 'GET' ? {} : await request.json();
      let principal: Principal | undefined;
      if (!internal) {
        try { principal = JSON.parse(request.headers.get('X-Mail-Verified-Principal') ?? 'null'); } catch { throw new Denied(401); }
        if (!principal || principal.provider !== this.env.AUTH_PROVIDER || !principal.id || !this.role(principal.id)) throw new Denied(403, 'mail_admission_required');
      }
      return await this.ctx.storage.transaction(async storage => {
        const actorId = principal?.id ?? '';
        if (path === '/api/workspace' && request.method === 'GET') return Response.json({
          ...scope, actor: { id: actorId, kind: 'user' }, membership: { role: this.role(actorId), status: 'active', version: 1 },
          policyVersion: 1, legacyShared: false, actions: [], actionDescriptors: [],
        });
        if (path === '/api/people' && request.method === 'GET') {
          const subjects = [this.env.MAIL_OWNER_SUBJECT, ...JSON.parse(this.env.MAIL_MEMBER_SUBJECTS ?? '[]')];
          return Response.json({ people: [...new Set(subjects)].filter(id => typeof id === 'string' && this.role(id)).map(id => ({ id, actorId: id, name: id })) });
        }
        if (path === '/api/native-resources') {
          if (request.method === 'GET') {
            const ids = await storage.get<string[]>('account-ids') ?? [];
            const accounts = await Promise.all(ids.map(id => storage.get<Account>('account:' + id)));
            return Response.json({ resources: accounts.filter((account): account is Account => !!account && this.effective(account, actorId).length > 0).map(account => this.publicAccount(account, actorId)) });
          }
          if (request.method !== 'POST') throw new Denied(405);
          if (!uuid(body.operationId) || body.ownerAppId !== 'mail' || body.resourceType !== 'mail.account' || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255) throw new Denied(400, 'invalid_account_command');
          const key = `command:${actorId}:${body.operationId}`, canonical = JSON.stringify([path, body]);
          const receipt = await storage.get<{ canonical: string; result: unknown }>(key);
          if (receipt) { if (receipt.canonical !== canonical) throw new Denied(409, 'operation_conflict'); return Response.json(receipt.result); }
          const id = crypto.randomUUID();
          const account: Account = { id, ownerAppId: 'mail', resourceType: 'mail.account', name: body.name.trim(), ownerActorId: actorId, ...scope, version: 1, createdAt: new Date().toISOString(), effectiveActions: [], grants: [] };
          await storage.put('account:' + id, account);
          await storage.put('account-ids', [...(await storage.get<string[]>('account-ids') ?? []), id]);
          const result = { resourceId: id };
          await storage.put(key, { canonical, result });
          return Response.json(result, { status: 201 });
        }
        const match = path.match(/^\/(api|internal)\/native-resources\/([^/]+)(?:\/(authorize|grants|lease|revalidate|renew))?$/);
        if (!match) throw new Denied(404, 'not_found');
        const [, channel, id, operation] = match;
        const account = await storage.get<Account>('account:' + id);
        if (!account) throw new Denied(404, 'account_not_found');
        if (channel === 'internal') {
          if (request.method !== 'POST' || !['revalidate', 'renew'].includes(operation)) throw new Denied();
          const lease = typeof body.lease === 'string' ? await storage.get<Lease>('lease:' + body.lease) : undefined;
          if (!lease || lease.accountId !== id || lease.jobId !== body.jobId || lease.expiresAt <= Date.now() || !Array.isArray(body.actions) || !body.actions.length || !body.actions.every((action: string) => lease.actions.includes(action) && this.effective(account, lease.actorId).includes(action))) throw new Denied();
          if (operation === 'revalidate') return Response.json({ resource: this.publicAccount(account, lease.actorId), context: { ...scope, actorId: lease.actorId }, jobId: lease.jobId, authorization: { allowed: true, effectiveActions: lease.actions.filter(action => this.effective(account, lease.actorId).includes(action)) } });
          if (!uuid(body.operationId) || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + 90 * 86400000) throw new Denied(400);
          const key = `renew:${body.lease}:${body.operationId}`, canonical = JSON.stringify(body);
          const receipt = await storage.get<{ canonical: string; token: string }>(key);
          if (receipt) { if (receipt.canonical !== canonical) throw new Denied(409, 'operation_conflict'); return Response.json({ lease: receipt.token, expiresAt: body.expiresAt }); }
          const token = crypto.randomUUID() + crypto.randomUUID();
          await storage.put('lease:' + token, { ...lease, actions: body.actions, expiresAt: body.expiresAt });
          await storage.put(key, { canonical, token });
          return Response.json({ lease: token, expiresAt: body.expiresAt });
        }
        const current = this.effective(account, actorId);
        if (!current.length) throw new Denied();
        if (!operation && request.method === 'GET') return Response.json({ resource: this.publicAccount(account, actorId), canManage: current.includes('mail.manage'), ...(current.includes('mail.manage') ? { grants: account.grants } : {}) });
        if (operation === 'authorize' && request.method === 'POST') return Response.json({ allowed: Array.isArray(body.actions) && body.actions.length > 0 && body.actions.every((action: string) => current.includes(action)), effectiveActions: current });
        if (operation === 'grants' && request.method === 'PUT') {
          if (!current.includes('mail.manage')) throw new Denied();
          if (!uuid(body.operationId) || !Array.isArray(body.grants) || body.grants.length > 100 || body.grants.some((grant: any) => !grant || !this.role(grant.actorId) || grant.actorId === account.ownerActorId || !Array.isArray(grant.actions) || grant.actions.some((action: string) => !actions.includes(action))) || new Set(body.grants.map((grant: any) => grant.actorId)).size !== body.grants.length) throw new Denied(400, 'invalid_grants');
          const key = `command:${actorId}:${body.operationId}`, canonical = JSON.stringify([path, body]);
          const receipt = await storage.get<string>(key);
          if (receipt) { if (receipt !== canonical) throw new Denied(409, 'operation_conflict'); return Response.json({ updated: true }); }
          if (body.expectedVersion !== account.version) throw new Denied(409, 'revision_conflict');
          await storage.put('account:' + id, { ...account, grants: body.grants, version: account.version + 1 });
          await storage.put(key, canonical);
          return Response.json({ updated: true });
        }
        if (operation === 'lease' && request.method === 'POST') {
          const reason = typeof body.jobId !== 'string' || !body.jobId || body.jobId.length > 128 ? 'invalidJob'
            : !Array.isArray(body.actions) || !body.actions.length || !body.actions.every((action: string) => current.includes(action)) ? 'invalidActions'
            : !Number.isSafeInteger(body.expiresAt) ? 'invalidExpiry'
            : body.expiresAt <= Date.now() ? 'expired' : body.expiresAt > Date.now() + 90 * 86400000 ? 'expiryTooFar' : null;
          if (reason) { console.warn('Mail lease rejected', { reason }); throw new Denied(400, 'invalid_lease'); }
          const token = crypto.randomUUID() + crypto.randomUUID();
          await storage.put('lease:' + token, { accountId: id, actorId, jobId: body.jobId, actions: body.actions, expiresAt: body.expiresAt } satisfies Lease);
          return Response.json({ lease: token, expiresAt: body.expiresAt });
        }
        throw new Denied(405);
      });
    } catch (error) {
      return Response.json({ error: error instanceof Denied ? error.code : 'authority_unavailable' }, { status: error instanceof Denied ? error.status : 503 });
    }
  }
}
