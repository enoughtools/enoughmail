import { mailAuthority, type MailAuthorityEnvironment } from './authority';
interface Service { fetch(request: Request): Promise<Response> }
interface Namespace { idFromName(name: string): unknown; get(id: unknown): Service }
export interface AutomationProof { lease: string; jobId: string; expiresAt: number; actions?: string[]; credentialId?: string; credentialVersion?: number; [key: string]: unknown }
export interface AutomationRenewalInput { accountId: string; organizationId: string; workspaceId: string; actorId: string; proof: AutomationProof; lifecycleGeneration: number; status: string; pending: { operationId: string; expiresAt: number; oldLease?: string }; now: number }
export interface AutomationRenewalEnv extends MailAuthorityEnvironment {  MAIL_CREDENTIALS?: Namespace }
export type AutomationRenewalResult = { status: 'allowed'; proof: AutomationProof } | { status: 'denied' | 'retry' | 'manual'; reason: string };
class Failure extends Error { constructor(readonly reason: string, readonly transient = false) { super(reason); } }
const required = ['mail.manage', 'mail.send'];
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
async function rpc(service: Service, path: string, body: unknown): Promise<any> {
  let response: Response;
  try { response = await service.fetch(new Request(`https://mail-authority.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); }
  catch { throw new Failure('service_unavailable', true); }
  let value: any; try { value = await response.json(); } catch { throw new Failure(response.status>=500?'service_unavailable':'invalid_authority_response',response.status>=500); }
  if (!response.ok) throw new Failure(typeof value?.error === 'string' ? value.error : `authority_${response.status}`, response.status >= 500 || (response.status === 409 && value?.error === 'provider_unavailable'));
  return value;
}
/** Authority metadata is supplied by private account storage. Leases stay opaque. The caller persists pending before this RPC and latches denied results. */
export async function renewAutomationAuthority(input: AutomationRenewalInput, env: AutomationRenewalEnv): Promise<AutomationRenewalResult> {
  const denied = (reason: string): AutomationRenewalResult => ({ status: 'denied', reason });
  const { proof, pending, now } = input;
  if (input.status !== 'active' || !integer(input.lifecycleGeneration) || input.lifecycleGeneration < 0 || !integer(now) || !proof || typeof proof.lease !== 'string' || !proof.lease || typeof proof.jobId !== 'string' || !proof.jobId || !integer(proof.expiresAt) || proof.expiresAt <= now) return denied('authority_expired_or_inactive');
  if (!mailAuthority(env)) return { status: 'retry', reason: 'core_unavailable' };
  const legacy = proof.actions === undefined;
  const actions = legacy ? required : proof.actions!;
  if (!Array.isArray(actions) || !actions.length || actions.length>32 || actions.some(action => typeof action !== 'string' || !action) || !required.every(action => actions.includes(action))) return denied('invalid_issued_actions');
  const path = `/internal/native-resources/${encodeURIComponent(input.accountId)}`;
  const verify = async (lease: string) => {
    const value = await rpc(mailAuthority(env)!, `${path}/revalidate`, { lease, jobId: proof.jobId, actions });
    if (value.authorization?.allowed !== true || !Array.isArray(value.authorization?.effectiveActions) || !actions.every(action => value.authorization.effectiveActions.includes(action)) || value.resource?.id !== input.accountId || value.resource?.ownerAppId !== 'mail' || value.resource?.resourceType !== 'mail.account' || value.context?.actorId !== input.actorId || value.context?.organizationId !== input.organizationId || value.context?.workspaceId !== input.workspaceId || value.jobId !== proof.jobId) throw new Failure('authority_scope_mismatch');
  };
  const credential = async (): Promise<number> => {
    if (proof.credentialId === undefined && proof.credentialVersion === undefined) return Infinity;
    if (!env.MAIL_CREDENTIALS || typeof proof.credentialId !== 'string' || !integer(proof.credentialVersion)) throw new Failure('invalid_credential_metadata');
    const service = env.MAIL_CREDENTIALS.get(env.MAIL_CREDENTIALS.idFromName('mail-client-credentials-v1'));
    const value = await rpc(service, '/lookup-id', { id: proof.credentialId, version: proof.credentialVersion });
    const record = value.credential;
    if (!record || record.id !== proof.credentialId || record.version !== proof.credentialVersion || record.jobId !== proof.jobId || record.revokedAt !== null || record.accountId !== input.accountId || record.organizationId !== input.organizationId || record.workspaceId !== input.workspaceId || record.actorId !== input.actorId || !Array.isArray(record.actions) || !actions.every(action => record.actions.includes(action)) || !integer(record.expiresAt) || record.expiresAt <= now || record.lifecycleGeneration !== input.lifecycleGeneration) throw new Failure('credential_revoked_or_changed');
    return record.expiresAt;
  };
  try {
    await verify(proof.lease);
    const credentialExpiry = await credential();
    if (legacy) return { status: 'manual', reason: 'legacy_actions_require_fresh_authorization' };
    if (!pending || typeof pending.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pending.operationId) || !integer(pending.expiresAt) || pending.expiresAt <= now || pending.expiresAt > now + 90 * 86400000 || pending.expiresAt > credentialExpiry || (pending.oldLease !== undefined && pending.oldLease !== proof.lease)) return denied('invalid_pending_renewal');
    const renewed = await rpc(mailAuthority(env)!, `${path}/renew`, { lease: pending.oldLease ?? proof.lease, jobId: proof.jobId, actions, operationId: pending.operationId, expiresAt: pending.expiresAt });
    if (typeof renewed.lease !== 'string' || !renewed.lease || renewed.expiresAt !== pending.expiresAt) throw new Failure('invalid_renewal_response');
    await verify(proof.lease);
    const currentExpiry = await credential();
    if (renewed.expiresAt > currentExpiry) throw new Failure('credential_expiry_changed');
    await verify(renewed.lease);
    // Repeat credential lookup after the final Core RPC to detect revocation during revalidation.
    if (renewed.expiresAt > await credential()) throw new Failure('credential_expiry_changed');
    return { status: 'allowed', proof: { ...proof, lease: renewed.lease, expiresAt: renewed.expiresAt, actions: [...actions] } };
  } catch (error) {
    if (error instanceof Failure && error.transient) {
      try { await verify(proof.lease); await credential(); return { status: 'retry', reason: error.reason }; } catch (recheckError) {
        // An outage suspends dispatch; it cannot revoke authority by itself.
        if (recheckError instanceof Failure && recheckError.transient && proof.expiresAt > now) return { status: 'retry', reason: recheckError.reason };
        return denied(recheckError instanceof Failure ? recheckError.reason : 'old_authority_unverified');
      }
    }
    return denied(error instanceof Failure ? error.reason : 'invalid_authority_response');
  }
}
