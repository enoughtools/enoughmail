/** Product-defined entities with independent access; never file storage. */
export interface NativeResourceDescriptor {
  resourceType: string;
  actions: string[];
  /** Installed product opts into these actions for current workspace administrators. */
  adminReadActions: string[];
}
export interface NativeResource {
  id: string;
  ownerAppId: string;
  resourceType: string;
  name: string;
  ownerActorId: string;
  organizationId: string;
  workspaceId: string;
  version: number;
  createdAt: string;
  effectiveActions: string[];
}
export interface NativeResourceGrant { actorId: string; actions: string[] }
export interface NativeResourceAuthorization {
  allowed: boolean;
  effectiveActions: string[];
  resourceVersion: number;
  policyVersion: number;
  membershipVersion: number;
}
export function isNativeResourceDescriptor(value: unknown, appId: string): value is NativeResourceDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const valid = (entry: unknown) => typeof entry === 'string' && entry.length <= 96
    && entry.startsWith(`${appId}.`) && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(entry);
  return Object.keys(item).every(key => ['resourceType', 'actions', 'adminReadActions'].includes(key))
    && valid(item.resourceType) && Array.isArray(item.actions) && item.actions.length > 0 && item.actions.length <= 32
    && item.actions.every(valid) && new Set(item.actions).size === item.actions.length
    && Array.isArray(item.adminReadActions) && item.adminReadActions.every(action => item.actions instanceof Array && item.actions.includes(action))
    && new Set(item.adminReadActions).size === item.adminReadActions.length;
}

/** Server-held scheduled command proof; revalidation never substitutes for current grants. */
export interface NativeResourceJobLease {
  version: 1;
  resourceId: string;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  audience: string;
  jobId: string;
  actions: string[];
  expiresAt: number;
}
