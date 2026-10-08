import { directoryIdentityTransfer } from './identity-transfer';

export interface DirectoryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  transaction<T>(callback: (storage: DirectoryStorage) => Promise<T>): Promise<T>;
}
export interface DirectoryAccount {
  accountId: string; organizationId: string; workspaceId: string; ownerActorId: string;
}
export interface DirectoryRoute extends DirectoryAccount { address: string; enabled: boolean; catchAll: boolean; }
interface VerifiedDomain extends DirectoryAccount { domain: string; verifiedAt: string; }

const addressPattern = /^[^\s@<>]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i;

/** Service-bound directory. Browser calls only reach the authenticated Mail Worker. */
export class MailDirectory {
  constructor(private readonly ctx: { storage: DirectoryStorage }) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; }
    catch { return Response.json({ error: 'invalid_request' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'invalid_request' }, { status: 400 });
    if (path === '/resolve') {
      if (typeof body.address !== 'string') return Response.json({ error: 'invalid_address' }, { status: 400 });
      const address = body.address.trim().toLowerCase();
      if (!addressPattern.test(address)) return Response.json({ error: 'invalid_address' }, { status: 400 });
      const domain = address.slice(address.lastIndexOf('@') + 1);
      const exact = await this.ctx.storage.get<DirectoryRoute>('address:' + address);
      // An explicitly disabled address is a rejection, never a catch-all fallback.
      if (exact) return Response.json({ route: exact.enabled ? exact : null });
      const route = await this.ctx.storage.get<DirectoryRoute>('catchall:' + domain);
      return Response.json({ route: route?.enabled ? { ...route, address } : null });
    }
    if (path === '/resolve-provider') {
      if (typeof body.providerId !== 'string' || body.providerId.length > 1024) return Response.json({ error: 'invalid_provider_id' }, { status: 400 });
      return Response.json({ route: await this.ctx.storage.get<DirectoryAccount & { sender: string }>('provider:' + body.providerId) ?? null });
    }
    const account = body.account as DirectoryAccount | undefined;
    if (!account || !['accountId', 'organizationId', 'workspaceId', 'ownerActorId'].every(key => typeof account[key as keyof DirectoryAccount] === 'string' && account[key as keyof DirectoryAccount])) {
      return Response.json({ error: 'invalid_account' }, { status: 400 });
    }
    if (path === '/identity-transfer') return directoryIdentityTransfer(this.ctx.storage, account, body);
    if (path === '/register-provider') {
      if (typeof body.providerId !== 'string' || !body.providerId || body.providerId.length > 1024 || typeof body.sender !== 'string' || !addressPattern.test(body.sender)) return Response.json({ error: 'invalid_provider_id' }, { status: 400 });
      return this.ctx.storage.transaction(async storage => {
        const key = 'provider:' + body.providerId;
        const previous = await storage.get<DirectoryAccount & { sender: string }>(key);
        if (previous && (previous.accountId !== account.accountId || previous.organizationId !== account.organizationId || previous.workspaceId !== account.workspaceId || previous.sender !== body.sender)) return Response.json({ error: 'provider_id_conflict' }, { status: 409 });
        await storage.put(key, { ...account, sender: body.sender });
        return Response.json({ registered: true });
      });
    }
    if (path === '/zone-approval' || path === '/authorize-zone' || path === '/approve-zone') {
      if (typeof body.domain !== 'string' || typeof body.zoneId !== 'string' || !/^[a-f0-9]{32}$/.test(body.zoneId)) return Response.json({ error: 'invalid_zone' }, { status: 400 });
      const key = 'approved-zone:' + body.domain;
      return this.ctx.storage.transaction(async storage => {
        type Approval = { domain: string; zoneId: string; organizationId: string; workspaceId: string; accountIds: string[]; revision?: number };
        const previous = await storage.get<Approval>(key);
        const sameScope = previous?.organizationId === account.organizationId && previous.workspaceId === account.workspaceId && previous.zoneId === body.zoneId;
        const revision = previous?.revision ?? (previous ? 1 : 0);
        if (path === '/zone-approval') {
          if (previous && !sameScope) return Response.json({ error: 'zone_in_use' }, { status: 409 });
          return Response.json({ domain: body.domain, zoneId: body.zoneId, accountId: account.accountId, revision, approved: !!previous?.accountIds.includes(account.accountId) });
        }
        if (path === '/authorize-zone') return Response.json({ allowed: sameScope && previous!.accountIds.includes(account.accountId) });
        if (typeof body.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.operationId) || typeof body.approvedBy !== 'string' || !body.approvedBy) return Response.json({ error: 'invalid_approval' }, { status: 400 });
        if (previous && !sameScope) return Response.json({ error: 'zone_in_use' }, { status: 409 });
        const receiptKey = `zone-command:${account.organizationId}:${account.workspaceId}:${body.approvedBy}:${body.operationId}`;
        const canonical = JSON.stringify(body);
        const receipt = await storage.get<string>(receiptKey);
        if (receipt && receipt !== canonical) return Response.json({ error: 'operation_conflict' }, { status: 409 });
        if (receipt) return Response.json({ approved: true, domain: body.domain, zoneId: body.zoneId, accountId: account.accountId, revision, replayed: true });
        if (body.expectedRevision !== revision) return Response.json({ error: 'revision_conflict' }, { status: 409 });
        await storage.put(key, { domain: body.domain, zoneId: body.zoneId, organizationId: account.organizationId, workspaceId: account.workspaceId, accountIds: [...new Set([...(previous?.accountIds ?? []), account.accountId])], revision: revision + 1 });
        await storage.put(receiptKey, canonical);
        return Response.json({ approved: true, domain: body.domain, zoneId: body.zoneId, accountId: account.accountId, revision: revision + 1 });
      });
    }
    if (path === '/verify-domain') {
      // Verification is performed by the Worker against Cloudflare's zone API.
      // This internal operation cannot be called through a public Mail route.
      if (typeof body.domain !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(body.domain)) return Response.json({ error: 'invalid_domain' }, { status: 400 });
      const domain = body.domain;
      return this.ctx.storage.transaction(async storage => {
        const previous = await storage.get<VerifiedDomain>('domain:' + domain);
        if (previous && (previous.organizationId !== account.organizationId || previous.workspaceId !== account.workspaceId)) return Response.json({ error: 'domain_in_use' }, { status: 409 });
        await storage.put('domain:' + domain, { ...account, domain, verifiedAt: new Date().toISOString() });
        return Response.json({ verified: true });
      });
    }
    if (path === '/register-address') {
      if (typeof body.address !== 'string' || typeof body.enabled !== 'boolean') return Response.json({ error: 'invalid_address' }, { status: 400 });
      const address = body.address.trim().toLowerCase();
      const catchAll = body.catchAll === true;
      const domain = catchAll ? address : address.slice(address.lastIndexOf('@') + 1);
      if (catchAll ? !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) : !addressPattern.test(address)) return Response.json({ error: 'invalid_address' }, { status: 400 });
      return this.ctx.storage.transaction(async storage => {
        const verified = await storage.get<VerifiedDomain>('domain:' + domain);
        if (!verified || verified.organizationId !== account.organizationId || verified.workspaceId !== account.workspaceId) return Response.json({ error: 'domain_not_verified' }, { status: 403 });
        const key = (catchAll ? 'catchall:' : 'address:') + address;
        if (!catchAll) {
          const reservationKey = await storage.get<string>('identity-transfer-reservation:' + address);
          if (reservationKey) {
            const reservation = await storage.get<{ status: string; expiresAt: number }>(reservationKey);
            if (reservation?.status === 'preparing' && reservation.expiresAt <= Date.now()) {
              await storage.put(reservationKey, { ...reservation, status: 'aborted' });
              await storage.delete('identity-transfer-reservation:' + address);
            } else if (reservation && ['preparing', 'committed'].includes(reservation.status)) return Response.json({ error: 'identity_transfer_in_progress' }, { status: 409 });
          }
        }
        const previous = await storage.get<DirectoryRoute>(key);
        if (previous && previous.accountId !== account.accountId) return Response.json({ error: 'address_in_use' }, { status: 409 });
        const route: DirectoryRoute = { ...account, address, enabled: body.enabled as boolean, catchAll };
        await storage.put(key, route);
        return Response.json({ route });
      });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}
