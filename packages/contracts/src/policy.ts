/** Provider-independent membership and resource authorization contracts. */
export const POLICY_ACTIONS = [
  'file.read', 'file.edit', 'file.create', 'file.move', 'file.delete', 'file.share',
  'workspace.manage',
] as const;
export type CorePolicyAction = typeof POLICY_ACTIONS[number];
export type PolicyAction = CorePolicyAction | `${string}.${string}`;
/** Product-owned permission vocabulary; installation does not grant permissions. */
export interface ProductPolicyAction {
  id: PolicyAction;
  label: string;
  /** Applies to matching files; folders can carry grants for inheritance. */
  resourceMimeTypes: string[];
  defaultMember?: boolean;
  legacySharedMember?: boolean;
}
export interface PolicyActionDescriptor {
  id: PolicyAction;
  label: string;
  group: string;
  resourceMimeTypes?: string[];
  defaultMember?: boolean;
  legacySharedMember?: boolean;
}
export const CORE_POLICY_ACTION_DESCRIPTORS: readonly PolicyActionDescriptor[] = [
  { id: 'file.read', label: 'View file', group: 'Files', defaultMember: true, legacySharedMember: true },
  { id: 'file.edit', label: 'Edit file', group: 'Files', defaultMember: true, legacySharedMember: true },
  { id: 'file.create', label: 'Create inside folder', group: 'Files', defaultMember: true, legacySharedMember: true },
  { id: 'file.move', label: 'Move file', group: 'Files', defaultMember: true, legacySharedMember: true },
  { id: 'file.delete', label: 'Delete file', group: 'Files', legacySharedMember: true },
  { id: 'file.share', label: 'Manage access', group: 'Files' },
  { id: 'workspace.manage', label: 'Manage workspace', group: 'Workspace' },
];
export type WorkspaceRole = 'owner' | 'administrator' | 'member' | 'guest';
export type MembershipStatus = 'active' | 'suspended';
export interface WorkspaceActor {
  id: string;
  kind: 'user' | 'service';
  provider: string;
  subject: string;
  email?: string;
  displayName?: string;
}
export interface WorkspaceMembership {
  role: WorkspaceRole;
  status: MembershipStatus;
  version: number;
}
export interface WorkspaceContext {
  organizationId: string;
  workspaceId: string;
  actor: { id: string; kind: 'user' | 'service' };
  membership: WorkspaceMembership | null;
  policyVersion: number;
  legacyShared: boolean;
}
export interface WorkspacePolicyResponse extends WorkspaceContext {
  actions: PolicyAction[];
  actionDescriptors: PolicyActionDescriptor[];
  /** Optional on legacy Core boot; opaque actor-scoped observation, never authorization. */
  catalogRevision?: string;
}
export interface WorkspaceMember extends WorkspaceMembership { actor: WorkspaceActor }
export interface WorkspaceMembersResponse { members: WorkspaceMember[] }
export interface PermissionGrant {
  id?: string;
  subjectType: 'actor' | 'group' | 'role';
  subjectId: string;
  actions: PolicyAction[];
}
export interface ResourcePolicy {
  resourceId: string;
  inherit: boolean;
  version: number;
  grants: PermissionGrant[];
}
export interface ResourcePolicyResponse extends ResourcePolicy {
  workspacePolicyVersion: number;
  effectiveActions: PolicyAction[];
  canManage: boolean;
  inheritedFrom: ResourcePolicy[];
  actionDescriptors: PolicyActionDescriptor[];
}
export interface ResourcePolicyUpdate {
  inherit: boolean;
  grants: PermissionGrant[];
  expectedVersion: number;
}
export interface AuthorizationDecision {
  allowed: boolean;
  policyVersion: number;
  membershipVersion: number;
}
export interface ActorResourceContext {
  organizationId: string;
  workspaceId: string;
  actorId: string;
}
export interface WorkspaceGroup { id: string; name: string; memberActorIds: string[] }

/** Storage syntax only. Execution and new grants require an installed descriptor. */
export function isPolicyActionId(value: unknown): value is PolicyAction {
  return typeof value === 'string' && value.length <= 96
    && ((POLICY_ACTIONS as readonly string[]).includes(value)
      || /^(?!core\.|file\.|workspace\.)[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value));
}
export function isPolicyAction(value: unknown, descriptors: readonly Pick<PolicyActionDescriptor, 'id'>[] = CORE_POLICY_ACTION_DESCRIPTORS): value is PolicyAction {
  return typeof value === 'string' && descriptors.some((descriptor) => descriptor.id === value);
}
export function isProductPolicyAction(value: unknown, appId: string): value is ProductPolicyAction {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ['core', 'file', 'workspace'].includes(appId)) return false;
  const action = value as Record<string, unknown>;
  return Object.keys(action).every((key) => ['id', 'label', 'resourceMimeTypes', 'defaultMember', 'legacySharedMember'].includes(key))
    && isPolicyActionId(action.id) && action.id.startsWith(`${appId}.`)
    && typeof action.label === 'string' && action.label.length > 0 && action.label.length <= 160
    && action.label === action.label.trim() && !/[\p{Cc}]/u.test(action.label)
    && Array.isArray(action.resourceMimeTypes) && action.resourceMimeTypes.length > 0 && action.resourceMimeTypes.length <= 32
    && action.resourceMimeTypes.every((mime) => typeof mime === 'string' && /^[a-z0-9!#$&^_.+-]{1,127}\/(?:[a-z0-9!#$&^_.+-]{1,127}|\*)$/.test(mime))
    && new Set(action.resourceMimeTypes).size === action.resourceMimeTypes.length
    && (action.defaultMember === undefined || typeof action.defaultMember === 'boolean')
    && (action.legacySharedMember === undefined || typeof action.legacySharedMember === 'boolean');
}
export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === 'owner' || value === 'administrator' || value === 'member' || value === 'guest';
}
export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return value === 'active' || value === 'suspended';
}
