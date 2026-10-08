import type { WorkspacePolicyResponse, NativeResource } from '@open-cloud/contracts';
import type { MailAuthority } from './authority';

export class MailAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message); }
}

export interface MailWorkspaceAccount {
  accountId: string;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  membershipRole?: string;
}

/** Private, user-owned Mail storage. This does not register a new Core resource kind. */
export async function mailAccountForWorkspace(value: WorkspacePolicyResponse): Promise<MailWorkspaceAccount> {
  if (!value || typeof value.organizationId !== 'string' || !value.organizationId ||
      typeof value.workspaceId !== 'string' || !value.workspaceId ||
      !value.actor || typeof value.actor.id !== 'string' || !value.actor.id || value.actor.kind !== 'user' ||
      !value.membership || value.membership.status !== 'active' ||
      !['owner', 'administrator', 'member', 'guest'].includes(value.membership.role) ||
      !Number.isSafeInteger(value.membership.version) || value.membership.version < 1) {
    throw new MailAccessError('workspace_access_required', 'Active workspace membership is required.');
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    'enough.mail.private-account.v1', value.organizationId, value.workspaceId, value.actor.id,
  ])));
  return {
    accountId: 'a' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    organizationId: value.organizationId, workspaceId: value.workspaceId, actorId: value.actor.id, membershipRole: value.membership.role,
  };
}

export async function authorizeMailWorkspace(request: Request, core?: MailAuthority): Promise<MailWorkspaceAccount> {
  if (!core) throw new MailAccessError('core_unavailable', 'Workspace services are unavailable.', 503);
  // Only forward credentials needed by Core's own identity verifier. Never trust
  // caller actor/account headers or a catalog response supplied by the browser.
  const headers = new Headers();
  for (const name of ['Cf-Access-Jwt-Assertion', 'Cookie']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const url = new URL(request.url);
  url.pathname = '/api/workspace'; url.search = '';
  let response: Response;
  try { response = await core.fetch(new Request(url, { headers })); }
  catch { throw new MailAccessError('core_unavailable', 'Workspace services are unavailable.', 503); }
  if (!response.ok) throw new MailAccessError('workspace_access_required', 'Current workspace access could not be verified.', response.status === 401 ? 401 : response.status === 403 ? 403 : 503);
  let value: WorkspacePolicyResponse;
  try { value = await response.json() as WorkspacePolicyResponse; }
  catch { throw new MailAccessError('core_unavailable', 'Workspace services returned an invalid response.', 503); }
  return mailAccountForWorkspace(value);
}

export class MailAuthorityClient {
  constructor(private readonly core?: MailAuthority) {}

  async call<T>(request: Request, path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!this.core) throw new MailAccessError('core_unavailable', 'Workspace services are unavailable.', 503);
    const url = new URL(request.url); url.pathname = path.split('?')[0]; url.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    const headers = new Headers();
    for (const name of ['Cf-Access-Jwt-Assertion', 'Cookie']) {
      const value = request.headers.get(name); if (value) headers.set(name, value);
    }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await this.core.fetch(new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    if (!response.ok) throw new MailAccessError('workspace_operation_denied', 'This workspace operation is unavailable.', response.status);
    return response.json() as Promise<T>;
  }

  async accounts(request: Request): Promise<NativeResource[]> {
    const result = await this.call<{ resources: NativeResource[] }>(request, '/api/native-resources?ownerAppId=mail');
    if (!Array.isArray(result.resources)) throw new MailAccessError('invalid_core_response', 'Invalid account list.', 503);
    return result.resources.filter(resource => resource.ownerAppId === 'mail' && resource.resourceType === 'mail.account');
  }

  async account(request: Request, accountId: string): Promise<{ account: NativeResource; grants?: unknown[]; canManage?: boolean }> {
    const result = await this.call<{ resource: NativeResource; grants?: unknown[]; canManage?: boolean }>(request, `/api/native-resources/${encodeURIComponent(accountId)}`);
    if (!result.resource || result.resource.id !== accountId || result.resource.ownerAppId !== 'mail' || result.resource.resourceType !== 'mail.account') throw new MailAccessError('account_not_found', 'This account is unavailable.', 404);
    return { account: result.resource, grants: result.grants, canManage: result.canManage };
  }

  async authorize(request: Request, accountId: string, actions: string[]): Promise<NativeResource> {
    const result = await this.call<{ allowed: boolean; effectiveActions: string[] }>(request, `/api/native-resources/${encodeURIComponent(accountId)}/authorize`, 'POST', { actions });
    if (result.allowed !== true || !actions.every(action => result.effectiveActions?.includes(action))) throw new MailAccessError('account_permission_denied', 'You do not have permission to use this account.');
    const { account } = await this.account(request, accountId);
    const effectiveActions = result.effectiveActions.filter(action => account.effectiveActions.includes(action));
    if (!actions.every(action => effectiveActions.includes(action))) throw new MailAccessError('account_permission_denied', 'Account permissions changed. Refresh and try again.');
    return { ...account, effectiveActions };
  }
}

/** Compatibility export for existing stack consumers. */
export { MailAuthorityClient as MailCoreClient };
