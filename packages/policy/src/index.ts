import {
  decodeRegistryBindings, CORE_POLICY_ACTION_DESCRIPTORS, isAppManifest, isMembershipStatus, isPolicyAction, isPolicyActionId, isWorkspaceRole, isWorkspaceResourceId, mimeTypeMatches,
  type ActorResourceContext, type AuthorizationDecision, type PermissionGrant, type PolicyAction,
  type Principal, type ResourcePolicy, type ResourcePolicyResponse, type WorkspaceActor,
  type WorkspaceContext, type WorkspaceGroup, type WorkspaceMember, type WorkspaceMembership, type PolicyActionDescriptor,
} from '@open-cloud/contracts';

export interface PolicyResult { success: boolean; meta?: { changes?: number } }
export interface PolicyStatement {
  bind(...values: (string | number | null)[]): PolicyStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<PolicyResult>;
}
export interface PolicyDatabase {
  prepare(query: string): PolicyStatement;
  /** D1 batch is transactional. Mutations fail closed if it is unavailable. */
  batch?(statements: PolicyStatement[]): Promise<PolicyResult[]>;
}
export interface PolicyEnv {
  CATALOG?: PolicyDatabase;
  ORGANIZATION_ID?: string;
  WORKSPACE_ID?: string;
  OWNER_PROVIDER?: string;
  OWNER_SUBJECT?: string;
  POLICY_LEGACY_SHARED?: string;
  /** Deployment-owned installed manifests; never supplied by an API caller. */
  OPEN_CLOUD_REGISTRY?: string;
  [binding: string]: unknown;
}
export class PolicyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'PolicyError'; }
}
/** Each environment has its own installed vocabulary; there is no mutable global registry. */
export function policyActionDescriptors(env: PolicyEnv): PolicyActionDescriptor[] {
  const descriptors = CORE_POLICY_ACTION_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
  let apps: unknown;
  try {
    const text = decodeRegistryBindings(env);
    if (text === undefined) return descriptors;
    apps = JSON.parse(text);
  } catch { throw new PolicyError(503, 'invalid_registry', 'The installed permission registry could not be verified.'); }
  if (!Array.isArray(apps)) throw new PolicyError(503, 'invalid_registry', 'The installed permission registry could not be verified.');
  const ids = new Set<string>(), actions = new Set(descriptors.map((descriptor) => descriptor.id));
  for (const app of apps) {
    if (!isAppManifest(app) || ids.has(app.id)) throw new PolicyError(503, 'invalid_registry', 'The installed permission registry could not be verified.');
    ids.add(app.id);
    for (const action of app.permissions ?? []) {
      if (actions.has(action.id)) throw new PolicyError(503, 'invalid_registry', 'The installed permission registry contains duplicate actions.');
      actions.add(action.id);
      descriptors.push({ ...action, group: app.name });
    }
  }
  return descriptors;
}
function applicableActions(descriptors: readonly PolicyActionDescriptor[], kind: string, mimeType: string | null): PolicyActionDescriptor[] {
  return descriptors.filter((descriptor) => !descriptor.resourceMimeTypes || kind === 'folder'
    || (mimeType !== null && descriptor.resourceMimeTypes.some((pattern) => mimeTypeMatches(pattern, mimeType))));
}
export function policyScope(env: PolicyEnv) {
  const organizationId = env.ORGANIZATION_ID || 'default-organization';
  const workspaceId = env.WORKSPACE_ID || 'default-workspace';
  if (![organizationId, workspaceId].every((id) => /^[A-Za-z0-9_-]{1,100}$/.test(id))) {
    throw new PolicyError(503, 'policy_not_configured', 'Workspace scope is not configured correctly.');
  }
  return { organizationId, workspaceId };
}
function ownerIdentity(env: PolicyEnv): { provider: string; subject: string } {
  if (env.AUTH_PROVIDER === 'local') return { provider: 'local', subject: 'local-developer' };
  if (!env.OWNER_PROVIDER || !env.OWNER_SUBJECT) throw new PolicyError(503, 'policy_not_configured', 'Configure the workspace owner before enabling this workspace.');
  return { provider: env.OWNER_PROVIDER, subject: env.OWNER_SUBJECT };
}
function database(env: PolicyEnv): PolicyDatabase {
  if (!env.CATALOG) throw new PolicyError(503, 'policy_unavailable', 'Workspace access storage is unavailable.');
  return env.CATALOG;
}
function validIdentity(provider: unknown, subject: unknown): provider is string {
  return typeof provider === 'string' && provider.length > 0 && provider.length <= 128 && !/[\p{Cc}]/u.test(provider)
    && typeof subject === 'string' && subject.trim().length > 0 && subject.length <= 512 && !/[\p{Cc}]/u.test(subject);
}
/** Collision-resistant provider/subject mapping. Email never participates. */
export async function actorIdFor(provider: string, subject: string): Promise<string> {
  if (!validIdentity(provider, subject)) throw new PolicyError(400, 'invalid_identity', 'Provide a valid identity provider and subject.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([provider, subject]))));
  return `actor_${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
interface State { legacy_shared: number; version: number }
interface MemberRow { role: WorkspaceMembership['role']; status: WorkspaceMembership['status']; version: number; admission: string }
interface ActorRow { id: string; kind: WorkspaceActor['kind']; provider: string; subject: string; email: string | null; display_name: string | null }
interface PolicyRow { resource_id: string; inherit: number; version: number }
interface GrantRow { id: string; subject_type: PermissionGrant['subjectType']; subject_id: string; actions_json: string }
interface ResourceRow { id: string; parent_id: string | null; organization_id: string; workspace_id: string; kind: string; mime_type: string | null }
function defaults(member: WorkspaceMembership, legacyShared: boolean, descriptors: readonly PolicyActionDescriptor[]): readonly PolicyAction[] {
  if (member.role === 'owner' || member.role === 'administrator') return descriptors.map((descriptor) => descriptor.id);
  if (member.role === 'member') return descriptors.filter((descriptor) => legacyShared ? descriptor.legacySharedMember : descriptor.defaultMember).map((descriptor) => descriptor.id);
  return [];
}
async function state(env: PolicyEnv): Promise<State | null> {
  const scope = policyScope(env);
  return database(env).prepare('SELECT legacy_shared, version FROM workspace_policy_state WHERE organization_id = ? AND workspace_id = ?')
    .bind(scope.organizationId, scope.workspaceId).first<State>();
}
async function bootstrap(env: PolicyEnv): Promise<void> {
  const scope = policyScope(env), owner = ownerIdentity(env), ownerId = await actorIdFor(owner.provider, owner.subject);
  await database(env).prepare('INSERT OR IGNORE INTO workspace_policy_state (organization_id, workspace_id, legacy_shared) VALUES (?, ?, ?)')
    .bind(scope.organizationId, scope.workspaceId, env.POLICY_LEGACY_SHARED === 'true' ? 1 : 0).run();
  await database(env).prepare('INSERT OR IGNORE INTO workspace_actors (id, kind, provider, subject) VALUES (?, ?, ?, ?)')
    .bind(ownerId, 'user', owner.provider, owner.subject).run();
  // Bootstrap only once: a suspended membership is never revived by login.
  await database(env).prepare("INSERT OR IGNORE INTO workspace_memberships (organization_id, workspace_id, actor_id, role, status, admission) VALUES (?, ?, ?, 'owner', 'active', 'bootstrap')")
    .bind(scope.organizationId, scope.workspaceId, ownerId).run();
}
async function membership(env: PolicyEnv, actorId: string): Promise<MemberRow | null> {
  const scope = policyScope(env);
  return database(env).prepare('SELECT role, status, version, admission FROM workspace_memberships WHERE organization_id = ? AND workspace_id = ? AND actor_id = ?')
    .bind(scope.organizationId, scope.workspaceId, actorId).first<MemberRow>();
}
export async function resolveWorkspaceContext(env: PolicyEnv, principal: Principal): Promise<WorkspaceContext> {
  await bootstrap(env);
  const actorId = await actorIdFor(principal.provider, principal.id), scope = policyScope(env);
  await database(env).prepare('INSERT INTO workspace_actors (id, kind, provider, subject, email, display_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET email = excluded.email, display_name = excluded.display_name WHERE workspace_actors.email IS NOT excluded.email OR workspace_actors.display_name IS NOT excluded.display_name')
    .bind(actorId, 'user', principal.provider, principal.id, principal.email, principal.displayName).run();
  const current = (await state(env))!;
  if (current.legacy_shared) {
    await database(env).prepare("INSERT OR IGNORE INTO workspace_memberships (organization_id, workspace_id, actor_id, role, status, admission) VALUES (?, ?, ?, 'member', 'active', 'legacy')")
      .bind(scope.organizationId, scope.workspaceId, actorId).run();
  }
  const member = await membership(env, actorId);
  return { ...scope, actor: { id: actorId, kind: 'user' }, membership: member ? { role: member.role, status: member.status, version: member.version } : null,
    policyVersion: current.version, legacyShared: Boolean(current.legacy_shared) };
}
/** Resolve an already-admitted verified identity without enrolling, bootstrapping or updating its profile.
 * Internal content callbacks must not turn a permission recheck into a catalog mutation.
 */
export async function resolveExistingWorkspaceContext(env: PolicyEnv, principal: Principal): Promise<WorkspaceContext> {
  const expectedActorId = await actorIdFor(principal.provider, principal.id), scope = policyScope(env);
  const observed = await database(env).prepare(`SELECT a.id, a.kind, p.legacy_shared, p.version AS policy_version,
      m.role, m.status, m.version AS membership_version
    FROM workspace_actors a JOIN workspace_policy_state p ON p.organization_id = ? AND p.workspace_id = ?
    LEFT JOIN workspace_memberships m ON m.organization_id = p.organization_id AND m.workspace_id = p.workspace_id AND m.actor_id = a.id
    WHERE a.provider = ? AND a.subject = ?`)
    .bind(scope.organizationId, scope.workspaceId, principal.provider, principal.id)
    .first<{id:string; kind:string; legacy_shared:number; policy_version:number; role:unknown; status:unknown; membership_version:number}>();
  if (!observed || observed.id !== expectedActorId || observed.kind !== 'user'
    || !isWorkspaceRole(observed.role) || observed.status !== 'active'
    || !Number.isSafeInteger(observed.membership_version) || observed.membership_version < 1
    || !Number.isSafeInteger(observed.policy_version) || observed.policy_version < 0
    || ![0,1].includes(observed.legacy_shared)) throw new PolicyError(403, 'forbidden', 'An existing active workspace membership is required.');
  return {...scope, actor:{id:observed.id,kind:'user'}, membership:{role:observed.role,status:'active',version:observed.membership_version},
    policyVersion:observed.policy_version,legacyShared:Boolean(observed.legacy_shared)};
}
async function resource(env: PolicyEnv, id: string): Promise<ResourceRow | null> {
  return database(env).prepare('SELECT id, parent_id, organization_id, workspace_id, kind, mime_type FROM workspace_resources WHERE id = ?')
    .bind(id).first<ResourceRow>();
}
async function readPolicy(env: PolicyEnv, resourceId: string): Promise<ResourcePolicy> {
  const scope = policyScope(env);
  const row = await database(env).prepare('SELECT resource_id, inherit, version FROM workspace_resource_policies WHERE organization_id = ? AND workspace_id = ? AND resource_id = ?')
    .bind(scope.organizationId, scope.workspaceId, resourceId).first<PolicyRow>();
  const grants = (await database(env).prepare('SELECT id, subject_type, subject_id, actions_json FROM workspace_permission_grants WHERE organization_id = ? AND workspace_id = ? AND resource_id = ? ORDER BY id')
    .bind(scope.organizationId, scope.workspaceId, resourceId).all<GrantRow>()).results;
  return { resourceId, inherit: row?.inherit !== 0, version: row?.version ?? 0, grants: grants.map((grant) => {
    const actions: unknown = JSON.parse(grant.actions_json);
    if (!Array.isArray(actions) || !actions.every(isPolicyActionId)) throw new PolicyError(503, 'invalid_policy', 'The resource policy could not be verified.');
    return { id: grant.id, subjectType: grant.subject_type, subjectId: grant.subject_id, actions };
  }) };
}
async function chain(env: PolicyEnv, resourceId: string): Promise<{ policies: ResourcePolicy[]; inheritsWorkspace: boolean } | null> {
  const scope = policyScope(env), policies: ResourcePolicy[] = [], visited = new Set<string>();
  let id: string | null = resourceId;
  while (id) {
    if (visited.has(id) || visited.size >= 64) throw new PolicyError(503, 'invalid_policy', 'The folder policy could not be verified.');
    visited.add(id);
    const item = await resource(env, id);
    if (!item || item.organization_id !== scope.organizationId || item.workspace_id !== scope.workspaceId) return null;
    const policy = await readPolicy(env, id); policies.push(policy);
    if (!policy.inherit) return { policies, inheritsWorkspace: false };
    id = item.parent_id;
  }
  return { policies, inheritsWorkspace: true };
}
interface EffectiveResource { decision: AuthorizationDecision; actions: Set<PolicyAction> }
/** One bounded ancestry/grant query for a page, rather than queries per file. */
async function effectiveResources(env: PolicyEnv, context: ActorResourceContext, fileIds: string[], deletedNotices = false, prospective?: { fileId: string; parentId: string | null }): Promise<Map<string, EffectiveResource>> {
  if (fileIds.length > 200) throw new PolicyError(400, 'too_many_resources', 'Check at most 200 resources at once.');
  const scope = policyScope(env), current = await state(env), member = await membership(env, context.actorId);
  const decision = { allowed: false, policyVersion: current?.version ?? 0, membershipVersion: member?.version ?? 0 };
  const result = new Map(fileIds.map((id) => [id, { decision: { ...decision }, actions: new Set<PolicyAction>() }]));
  if (context.organizationId !== scope.organizationId || context.workspaceId !== scope.workspaceId || !current || !member || member.status !== 'active') return result;
  const ids = [...new Set(fileIds.filter(isWorkspaceResourceId))]; if (!ids.length) return result;
  const descriptors = policyActionDescriptors(env);
  type AncestryRow = { root_id: string; id: string; parent_id: string | null; depth: number; inherit: number | null; actions_json: string; resource_kind: string; resource_mime_type: string | null };
  // Live pages seek the base id index; the overlay is needed only for tombstones or prospective moves.
  const usesResourceOverlay = deletedNotices || Boolean(prospective);
  const resourceTable = usesResourceOverlay ? 'resources' : 'workspace_resources';
  const rows = (await database(env).prepare(`WITH RECURSIVE ${usesResourceOverlay ? `resources AS (
    SELECT id, ${prospective ? 'CASE WHEN id = ? THEN ? ELSE parent_id END AS parent_id' : 'parent_id'}, organization_id, workspace_id, kind, mime_type FROM workspace_resources
    ${deletedNotices ? "UNION ALL SELECT id, parent_id, organization_id, workspace_id, 'file', NULL FROM workspace_resource_tombstones" : ''}
  ), ` : ''}ancestry(root_id, id, parent_id, depth, visited, resource_kind, resource_mime_type) AS (
    SELECT requested.value, r.id, r.parent_id, 1, ',' || r.id || ',', ${deletedNotices ? "'file', NULL" : 'r.kind, r.mime_type'}
      FROM json_each(?) requested ${usesResourceOverlay ? 'JOIN' : 'CROSS JOIN'} ${deletedNotices ? 'workspace_resource_tombstones' : resourceTable} r ON r.id = requested.value
      WHERE r.organization_id = ? AND r.workspace_id = ?
    UNION ALL
    SELECT a.root_id, r.id, r.parent_id, a.depth + 1, a.visited || r.id || ',', a.resource_kind, a.resource_mime_type
      FROM ancestry a JOIN ${resourceTable} r ON r.id = a.parent_id
      LEFT JOIN workspace_resource_policies p ON p.resource_id = a.id AND p.organization_id = ? AND p.workspace_id = ?
      WHERE COALESCE(p.inherit, 1) = 1 AND a.depth < 64 AND instr(a.visited, ',' || r.id || ',') = 0
        AND r.organization_id = ? AND r.workspace_id = ?
  ) SELECT a.root_id, a.id, a.parent_id, a.depth, p.inherit, a.resource_kind, a.resource_mime_type,
      json_group_array(DISTINCT permission.value) FILTER (WHERE permission.value IS NOT NULL) AS actions_json
    FROM ancestry a
    LEFT JOIN workspace_resource_policies p ON p.resource_id = a.id AND p.organization_id = ? AND p.workspace_id = ?
    LEFT JOIN workspace_permission_grants g ON g.resource_id = a.id AND g.organization_id = ? AND g.workspace_id = ?
      AND (g.subject_type = 'actor' AND g.subject_id = ? OR g.subject_type = 'role' AND g.subject_id = ?
        OR g.subject_type = 'group' AND EXISTS (
          SELECT 1 FROM workspace_groups matched_group JOIN workspace_group_members group_member ON group_member.group_id = matched_group.id
          WHERE matched_group.id = g.subject_id AND matched_group.organization_id = ? AND matched_group.workspace_id = ? AND group_member.actor_id = ?))
    LEFT JOIN json_each(CASE WHEN g.id IS NULL THEN '[]'
      WHEN json_valid(g.actions_json) AND json_type(g.actions_json) = 'array' THEN g.actions_json ELSE json('invalid') END) permission
    GROUP BY a.root_id, a.id, a.parent_id, a.depth, p.inherit, a.resource_kind, a.resource_mime_type
    ORDER BY a.root_id, a.depth`)
    .bind(...(prospective ? [prospective.fileId, prospective.parentId] : []), JSON.stringify(ids), scope.organizationId, scope.workspaceId, scope.organizationId, scope.workspaceId, scope.organizationId, scope.workspaceId,
      scope.organizationId, scope.workspaceId, scope.organizationId, scope.workspaceId, context.actorId, member.role,
      scope.organizationId, scope.workspaceId, context.actorId).all<AncestryRow>()).results;
  const byRoot = new Map<string, AncestryRow[]>();
  for (const row of rows) { const items = byRoot.get(row.root_id) ?? []; items.push(row); byRoot.set(row.root_id, items); }
  for (const [rootId, ancestry] of byRoot) {
    const last = ancestry.at(-1)!;
    // Missing/cross-scope parents and cycles cannot silently acquire defaults.
    if (last.inherit !== 0 && last.parent_id !== null) continue;
    const effective = result.get(rootId)!;
    const available = applicableActions(descriptors, ancestry[0].resource_kind, ancestry[0].resource_mime_type);
    if (member.role === 'owner' || member.role === 'administrator') { for (const action of defaults(member, false, available)) effective.actions.add(action); continue; }
    if (last.inherit !== 0) for (const action of defaults(member, Boolean(current.legacy_shared), available)) effective.actions.add(action);
    for (const row of ancestry) {
      const actions: unknown = JSON.parse(row.actions_json);
      if (!Array.isArray(actions) || !actions.every(isPolicyActionId)) throw new PolicyError(503, 'invalid_policy', 'The resource policy could not be verified.');
      for (const action of actions) if (action !== 'workspace.manage' && isPolicyAction(action, available)) effective.actions.add(action);
    }
  }
  return result;
}
export async function authorizeActorResource(env: PolicyEnv, context: ActorResourceContext, action: string, fileId: string | null = null): Promise<AuthorizationDecision> {
  if (fileId !== null) {
    const effective = (await effectiveResources(env, context, [fileId])).get(fileId)!;
    return { ...effective.decision, allowed: isPolicyActionId(action) && effective.actions.has(action) };
  }
  const scope = policyScope(env), current = await state(env), member = await membership(env, context.actorId);
  const decision = { allowed: false, policyVersion: current?.version ?? 0, membershipVersion: member?.version ?? 0 };
  const descriptors = policyActionDescriptors(env);
  if (context.organizationId !== scope.organizationId || context.workspaceId !== scope.workspaceId || !isPolicyAction(action, descriptors)
    || !current || !member || member.status !== 'active') return decision;
  return { ...decision, allowed: defaults(member, Boolean(current.legacy_shared), descriptors).includes(action) };
}
export async function authorizeResource(env: PolicyEnv, principal: Principal, action: string, fileId: string | null = null): Promise<AuthorizationDecision> {
  const context = await resolveWorkspaceContext(env, principal);
  return authorizeActorResource(env, { ...context, actorId: context.actor.id }, action, fileId);
}
export async function authorizeActorResourceAtParent(env: PolicyEnv, context: ActorResourceContext, action: string, fileId: string, parentId: string | null): Promise<AuthorizationDecision> {
  const scope = policyScope(env), current = await state(env), member = await membership(env, context.actorId);
  const decision: AuthorizationDecision = { allowed: false, policyVersion: current?.version ?? 0, membershipVersion: member?.version ?? 0 };
  if (context.organizationId !== scope.organizationId || context.workspaceId !== scope.workspaceId || !current || !member || member.status !== 'active') return decision;
  if (!isPolicyActionId(action)) return decision;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!isWorkspaceResourceId(fileId) || !UUID_REGEX.test(fileId)) return decision;
  if (parentId !== null && (!isWorkspaceResourceId(parentId) || !UUID_REGEX.test(parentId))) return decision;
  if (parentId === fileId) return decision;
  const source = await resource(env, fileId);
  if (!source || source.organization_id !== scope.organizationId || source.workspace_id !== scope.workspaceId || source.kind !== 'file') return decision;
  if (parentId !== null) {
    const visited = new Set<string>();
    let currId: string | null = parentId;
    while (currId !== null) {
      if (currId === fileId || visited.has(currId) || visited.size >= 64) return decision;
      visited.add(currId);
      const curr = await resource(env, currId);
      if (!curr || curr.organization_id !== scope.organizationId || curr.workspace_id !== scope.workspaceId || curr.kind !== 'folder') return decision;
      currId = curr.parent_id;
    }
  }
  const effective = (await effectiveResources(env, context, [fileId], false, { fileId, parentId })).get(fileId)!;
  return { ...effective.decision, allowed: effective.actions.has(action) };
}
export async function authorizeResourceAtParent(env: PolicyEnv, principal: Principal, action: string, fileId: string, parentId: string | null): Promise<AuthorizationDecision> {
  const context = await resolveWorkspaceContext(env, principal);
  return authorizeActorResourceAtParent(env, { ...context, actorId: context.actor.id }, action, fileId, parentId);
}
export async function requireAction(env: PolicyEnv, principal: Principal, action: string, fileId: string | null = null): Promise<AuthorizationDecision> {
  const decision = await authorizeResource(env, principal, action, fileId);
  if (!decision.allowed) throw new PolicyError(403, 'forbidden', 'You do not have permission for this workspace operation.');
  return decision;
}
export async function authorizeActorResources(env: PolicyEnv, context: ActorResourceContext, action: string, fileIds: string[]): Promise<Map<string, AuthorizationDecision>> {
  if (fileIds.length > 200) throw new PolicyError(400, 'too_many_resources', 'Check at most 200 resources at once.');
  const resources = await effectiveResources(env, context, fileIds);
  return new Map([...resources].map(([id, effective]) => [id, { ...effective.decision, allowed: isPolicyActionId(action) && effective.actions.has(action) }]));
}
export async function authorizeResources(env: PolicyEnv, principal: Principal, action: string, fileIds: string[]): Promise<Map<string, AuthorizationDecision>> {
  const context = await resolveWorkspaceContext(env, principal);
  return authorizeActorResources(env, { ...context, actorId: context.actor.id }, action, fileIds);
}
/** Deleted identities are authorized only for name-free deletion notices.
 * This deliberately accepts no action argument and cannot grant stale content,
 * response, room or MCP access. Normal authorization requires a live resource.
 */
export async function authorizeDeletedResources(env: PolicyEnv, principal: Principal, fileIds: string[]): Promise<Map<string, AuthorizationDecision>> {
  const context = await resolveWorkspaceContext(env, principal), resources = await effectiveResources(env, { ...context, actorId: context.actor.id }, fileIds, true);
  return new Map([...resources].map(([id, effective]) => [id, { ...effective.decision, allowed: effective.actions.has('file.read') }]));
}
export async function authorizeDeletedResource(env: PolicyEnv, principal: Principal, fileId: string): Promise<AuthorizationDecision> {
  return (await authorizeDeletedResources(env, principal, [fileId])).get(fileId)!;
}

export async function authorizeDeletedFileOperationOutcome(
  env: PolicyEnv,
  principal: Principal,
  original: {
    organizationId: string;
    workspaceId: string;
    resourceId: string;
    kind: 'file';
    parentId: string | null;
    expectedMetadataVersion: number;
  },
): Promise<AuthorizationDecision> {
  let scope: { organizationId: string; workspaceId: string };
  try {
    scope = policyScope(env);
  } catch {
    return { allowed: false, policyVersion: 0, membershipVersion: 0 };
  }

  // Detach own data before the first await. Accessors and caller aliases are not authority.
  const ownData = (value: unknown, keys: readonly string[], exact = false): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (exact) {
      const prototype = Object.getPrototypeOf(value);
      const ownKeys = Reflect.ownKeys(value);
      if (prototype !== Object.prototype && prototype !== null
        || ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || exact && !descriptor.enumerable) return null;
      result[key] = descriptor.value;
    }
    return result;
  };
  const capture = ownData(original, ['organizationId', 'workspaceId', 'resourceId', 'kind', 'parentId', 'expectedMetadataVersion'], true);
  const identity = ownData(principal, ['provider', 'id']);
  const denied = { allowed: false, policyVersion: 0, membershipVersion: 0 };
  if (!capture || !identity || !validIdentity(identity.provider, identity.id)
    || capture.organizationId !== scope.organizationId || capture.workspaceId !== scope.workspaceId
    || capture.kind !== 'file' || !isWorkspaceResourceId(capture.resourceId)
    || !(capture.parentId === null || isWorkspaceResourceId(capture.parentId))
    || capture.parentId === capture.resourceId || !Number.isSafeInteger(capture.expectedMetadataVersion)
    || (capture.expectedMetadataVersion as number) < 1
    || !Number.isSafeInteger((capture.expectedMetadataVersion as number) + 1)) return denied;
  original = capture as typeof original;
  const provider = identity.provider as string, subject = identity.id as string;
  // Deployment-owned references and vocabulary are fixed for the entire observation.
  const catalog = database(env);
  const descriptors = policyActionDescriptors(env);
  const actorId = await actorIdFor(provider, subject);

  // Query snapshot capturing all authorization state atomically
  const query = `
    WITH RECURSIVE
      snapshot_state AS (
        SELECT s.legacy_shared, s.version AS policy_version
        FROM workspace_policy_state s
        WHERE s.organization_id = ? AND s.workspace_id = ?
      ),
      snapshot_actor AS (
        SELECT a.id, a.provider, a.subject
        FROM workspace_actors a
        WHERE a.id = ? AND a.kind = 'user' AND a.provider = ? AND a.subject = ?
      ),
      snapshot_member AS (
        SELECT m.role, m.status, m.version AS membership_version
        FROM workspace_memberships m
        WHERE m.organization_id = ? AND m.workspace_id = ? AND m.actor_id = ?
      ),
      live_source AS (
        SELECT r.id FROM workspace_resources r WHERE r.id = ?
      ),
      tombstone_source AS (
        SELECT t.id, t.parent_id, t.metadata_version
        FROM workspace_resource_tombstones t
        WHERE t.id = ? AND t.organization_id = ? AND t.workspace_id = ?
      ),
      ancestry(root_id, id, parent_id, depth, visited, kind, is_valid) AS (
        SELECT
          t.id AS root_id,
          t.id AS id,
          t.parent_id AS parent_id,
          1 AS depth,
          ',' || t.id || ',' AS visited,
          'file' AS kind,
          1 AS is_valid
        FROM workspace_resource_tombstones t
        WHERE t.id = ? AND t.organization_id = ? AND t.workspace_id = ?
        UNION ALL
        SELECT
          a.root_id,
          r.id,
          r.parent_id,
          a.depth + 1,
          a.visited || r.id || ',',
          r.kind,
          CASE
            WHEN r.kind = 'folder'
             AND r.organization_id = ?
             AND r.workspace_id = ?
             AND a.depth < 64
             AND instr(a.visited, ',' || r.id || ',') = 0
            THEN 1
            ELSE 0
          END AS is_valid
        FROM ancestry a
        JOIN workspace_resources r ON r.id = a.parent_id
        WHERE a.is_valid = 1 AND a.parent_id IS NOT NULL AND a.depth <= 64
      ),
      ancestry_nodes AS (
        SELECT a.root_id, a.id, a.parent_id, a.depth, a.kind, a.is_valid, p.inherit, p.version AS policy_version,
          (SELECT r.metadata_version FROM workspace_resources r WHERE r.id = a.id) AS metadata_version
        FROM ancestry a
        LEFT JOIN workspace_resource_policies p
          ON p.resource_id = a.id AND p.organization_id = ? AND p.workspace_id = ?
        ORDER BY a.depth ASC
      ),
      effective_grants AS (
        SELECT
          an.id AS resource_id,
          an.depth,
          g.id AS grant_id,
          g.subject_type, g.subject_id,
          g.actions_json,
          CASE WHEN g.subject_type = 'group' THEN (
            SELECT json_group_array(json_object('id', wg.id, 'organization_id', wg.organization_id,
              'workspace_id', wg.workspace_id, 'version', wg.version, 'actor_id', wgm.actor_id))
            FROM workspace_groups wg LEFT JOIN workspace_group_members wgm
              ON wgm.group_id = wg.id AND wgm.actor_id = (SELECT id FROM snapshot_actor)
            WHERE wg.id = g.subject_id
          ) ELSE NULL END AS group_binding
        FROM ancestry_nodes an
        JOIN workspace_permission_grants g
          ON g.resource_id = an.id AND g.organization_id = ? AND g.workspace_id = ?
         AND (
           (g.subject_type = 'actor' AND g.subject_id = ?)
           OR (g.subject_type = 'role' AND g.subject_id = (SELECT role FROM snapshot_member))
           OR (g.subject_type = 'group' AND EXISTS (
             SELECT 1 FROM workspace_groups wg
             JOIN workspace_group_members wgm ON wgm.group_id = wg.id
             WHERE wg.id = g.subject_id AND wg.organization_id = ? AND wg.workspace_id = ? AND wgm.actor_id = ?
           ))
         )
      ),
      parsed_grant_actions AS (
        SELECT
          eg.resource_id,
          eg.depth,
          eg.grant_id, eg.subject_type, eg.subject_id, eg.actions_json, eg.group_binding,
          permission.value AS action
        FROM effective_grants eg
        JOIN json_each(
          CASE
            WHEN json_valid(eg.actions_json) AND json_type(eg.actions_json) = 'array' THEN eg.actions_json
            ELSE json('invalid')
          END
        ) permission
      )
    SELECT
      (SELECT legacy_shared FROM snapshot_state) AS legacy_shared,
      (SELECT policy_version FROM snapshot_state) AS policy_version,
      (SELECT id FROM snapshot_actor) AS actor_id,
      (SELECT role FROM snapshot_member) AS member_role,
      (SELECT status FROM snapshot_member) AS member_status,
      (SELECT membership_version FROM snapshot_member) AS membership_version,
      (SELECT count(*) FROM live_source) AS live_count,
      (SELECT id FROM tombstone_source) AS tombstone_id,
      (SELECT parent_id FROM tombstone_source) AS tombstone_parent_id,
      (SELECT metadata_version FROM tombstone_source) AS tombstone_metadata_version,
      (SELECT json_group_array(json_object(
        'id', id,
        'parent_id', parent_id,
        'depth', depth,
        'kind', kind,
        'is_valid', is_valid,
        'inherit', inherit,
        'policy_version', policy_version,
        'metadata_version', metadata_version
      )) FROM (SELECT * FROM ancestry_nodes ORDER BY depth)) AS ancestry_json,
      (SELECT json_group_array(json_object(
        'resource_id', resource_id,
        'depth', depth,
        'grant_id', grant_id,
        'subject_type', subject_type, 'subject_id', subject_id,
        'actions_json', actions_json, 'group_binding', group_binding,
        'action', action
      )) FROM (SELECT * FROM parsed_grant_actions ORDER BY depth, resource_id, grant_id, action)) AS grants_json;
  `;

  const bindParams = [
    // snapshot_state
    scope.organizationId, scope.workspaceId,
    // snapshot_actor
    actorId, provider, subject,
    // snapshot_member
    scope.organizationId, scope.workspaceId, actorId,
    // live_source
    original.resourceId,
    // tombstone_source
    original.resourceId, scope.organizationId, scope.workspaceId,
    // ancestry base
    original.resourceId, scope.organizationId, scope.workspaceId,
    // ancestry recursive
    scope.organizationId, scope.workspaceId,
    // ancestry_nodes
    scope.organizationId, scope.workspaceId,
    // effective_grants
    scope.organizationId, scope.workspaceId,
    actorId,
    // group subquery
    scope.organizationId, scope.workspaceId, actorId,
  ];

  type SnapshotRow = {
    legacy_shared: number | null;
    policy_version: number | null;
    actor_id: string | null;
    member_role: WorkspaceMembership['role'] | null;
    member_status: WorkspaceMembership['status'] | null;
    membership_version: number | null;
    live_count: number;
    tombstone_id: string | null;
    tombstone_parent_id: string | null;
    tombstone_metadata_version: number | null;
    ancestry_json: string | null;
    grants_json: string | null;
  };

  const evaluateObservation = (row: SnapshotRow | null): {
    decision: AuthorizationDecision;
    snapshotKey: string;
  } => {
    const policyVersion = row?.policy_version ?? 0;
    const membershipVersion = row?.membership_version ?? 0;
    const denied: AuthorizationDecision = { allowed: false, policyVersion, membershipVersion };

    if (!row) return { decision: denied, snapshotKey: '' };
    const snapshotKey = JSON.stringify(row);

    if (row.policy_version === null || row.legacy_shared === null) return { decision: denied, snapshotKey };
    if (!row.actor_id || !row.member_role || row.member_status !== 'active') return { decision: denied, snapshotKey };
    if (row.live_count > 0) return { decision: denied, snapshotKey };
    if (
      row.tombstone_id !== original.resourceId ||
      row.tombstone_parent_id !== original.parentId ||
      row.tombstone_metadata_version !== original.expectedMetadataVersion + 1
    ) {
      return { decision: denied, snapshotKey };
    }

    let ancestryNodes: Array<{
      id: string;
      parent_id: string | null;
      depth: number;
      kind: string;
      is_valid: number;
      inherit: number | null;
    }> = [];
    try {
      ancestryNodes = JSON.parse(row.ancestry_json || '[]');
    } catch {
      return { decision: denied, snapshotKey };
    }

    if (!ancestryNodes.length || ancestryNodes[0].id !== original.resourceId) {
      return { decision: denied, snapshotKey };
    }

    // Verify strict ancestry: every ancestor must be valid folder, no missing/cross-scope/nonfolder/cycle/>64
    for (let i = 1; i < ancestryNodes.length; i++) {
      const node = ancestryNodes[i];
      if (node.is_valid !== 1 || node.kind !== 'folder' || node.depth > 64) {
        return { decision: denied, snapshotKey };
      }
    }

    // Check if the chain reached root or terminated early
    const lastNode = ancestryNodes.at(-1)!;
    if (lastNode.parent_id !== null) {
      // The parent was not found or chain stopped before root
      return { decision: denied, snapshotKey };
    }

    // Validate grants and action permissions fails closed
    let parsedGrants: Array<{
      resource_id: string;
      depth: number;
      grant_id: string;
      action: string;
    }> = [];
    try {
      parsedGrants = JSON.parse(row.grants_json || '[]');
    } catch {
      throw new PolicyError(503, 'invalid_policy', 'The resource policy could not be verified.');
    }

    for (const g of parsedGrants) {
      if (!isPolicyActionId(g.action)) {
        throw new PolicyError(503, 'invalid_policy', 'The resource policy could not be verified.');
      }
    }

    // Deleted file kind is 'file', mime_type is null
    const available = applicableActions(descriptors, 'file', null);

    const effectiveActions = new Set<PolicyAction>();
    const memberObj: WorkspaceMembership = {
      role: row.member_role,
      status: row.member_status,
      version: row.membership_version ?? 0,
    };

    if (row.member_role === 'owner' || row.member_role === 'administrator') {
      for (const action of defaults(memberObj, false, available)) {
        effectiveActions.add(action);
      }
    } else {
      // Find whether workspace defaults apply: inherit must not be broken anywhere in the chain
      const inheritsWorkspace = ancestryNodes.every((n) => n.inherit !== 0);
      if (inheritsWorkspace) {
        for (const action of defaults(memberObj, Boolean(row.legacy_shared), available)) {
          effectiveActions.add(action);
        }
      }
    }

    // Accumulate grants up to the first node where inherit === 0
    for (const node of ancestryNodes) {
      const nodeGrants = parsedGrants.filter((g) => g.resource_id === node.id);
      for (const g of nodeGrants) {
        if (g.action !== 'workspace.manage' && isPolicyAction(g.action, available)) {
          effectiveActions.add(g.action);
        }
      }
      if (node.inherit === 0) {
        break;
      }
    }

    const hasRead = effectiveActions.has('file.read');
    const hasDelete = effectiveActions.has('file.delete');
    const allowed = hasRead && hasDelete;

    return {
      decision: {
        allowed,
        policyVersion,
        membershipVersion,
      },
      snapshotKey,
    };
  };

  const initialRow = await catalog.prepare(query).bind(...bindParams).first<SnapshotRow>();
  const initial = evaluateObservation(initialRow);
  if (!initial.decision.allowed) {
    return initial.decision;
  }

  // Final last awaited SQL fence: re-execute SAME snapshot query and require exact equality
  const finalRow = await catalog.prepare(query).bind(...bindParams).first<SnapshotRow>();
  const finalObs = evaluateObservation(finalRow);

  if (!finalObs.decision.allowed || finalObs.snapshotKey !== initial.snapshotKey) {
    return {
      allowed: false,
      policyVersion: finalObs.decision.policyVersion,
      membershipVersion: finalObs.decision.membershipVersion,
    };
  }

  return {
    allowed: true,
    policyVersion: finalObs.decision.policyVersion,
    membershipVersion: finalObs.decision.membershipVersion,
  };
}
/** Filter before pagination. The caller must continue scanning until its authorized page is full. */
export async function filterVisibleResources<T extends { id: string }>(env: PolicyEnv, principal: Principal, resources: T[]): Promise<T[]> {
  const decisions = await authorizeResources(env, principal, 'file.read', resources.map((item) => item.id));
  return resources.filter((item) => decisions.get(item.id)?.allowed);
}
export const authorizeResourceList = filterVisibleResources;
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function checkOrigin(request: Request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new PolicyError(403, 'invalid_origin', 'Use this workspace to change access.');
}
async function input(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new PolicyError(415, 'invalid_content_type', 'Send JSON to update access.');
  if (Number(request.headers.get('Content-Length')) > 64 * 1024) throw new PolicyError(413, 'request_too_large', 'The access update is too large.');
  if (!request.body) throw new PolicyError(400, 'invalid_request', 'Send an access update.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength;
      if (count > 64 * 1024) { await reader.cancel(); throw new PolicyError(413, 'request_too_large', 'The access update is too large.'); }
      chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  let value: unknown;
  const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PolicyError(400, 'invalid_request', 'Send valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyError(400, 'invalid_request', 'Send an access update object.');
  return value as Record<string, unknown>;
}
async function batch(env: PolicyEnv, statements: PolicyStatement[]): Promise<PolicyResult[]> {
  if (!database(env).batch) throw new PolicyError(503, 'policy_unavailable', 'Transactional access updates are unavailable.');
  const result = await database(env).batch!(statements);
  if (result.some((entry) => !entry.success)) throw new PolicyError(503, 'policy_unavailable', 'The access update could not be saved.');
  return result;
}
function auditStatement(env: PolicyEnv, actorId: string, action: string, resourceId: string | null, guard?: { fileId: string; operation: string }, previousStatementChanged = false) {
  const scope = policyScope(env);
  return database(env).prepare(`INSERT INTO workspace_policy_audit (id, organization_id, workspace_id, actor_id, action, resource_id, policy_version, created_at) SELECT ?, ?, ?, ?, ?, ?, version, ? FROM workspace_policy_state WHERE organization_id = ? AND workspace_id = ?${guard ? ' AND EXISTS (SELECT 1 FROM workspace_resource_policies WHERE organization_id = ? AND workspace_id = ? AND resource_id = ? AND last_operation = ?)' : ''}${previousStatementChanged ? ' AND changes() = 1' : ''}`)
    .bind(crypto.randomUUID(), scope.organizationId, scope.workspaceId, actorId, action, resourceId, new Date().toISOString(), scope.organizationId, scope.workspaceId,
      ...(guard ? [scope.organizationId, scope.workspaceId, guard.fileId, guard.operation] : []));
}
async function policyResponse(env: PolicyEnv, principal: Principal, fileId: string): Promise<ResourcePolicyResponse> {
  await requireAction(env, principal, 'file.read', fileId);
  const context = await resolveWorkspaceContext(env, principal), ancestry = await chain(env, fileId);
  if (!ancestry) throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
  const effective = (await effectiveResources(env, { ...context, actorId: context.actor.id }, [fileId])).get(fileId)!;
  const item = await resource(env, fileId);
  const actionDescriptors = applicableActions(policyActionDescriptors(env), item!.kind, item!.mime_type);
  const effectiveActions = actionDescriptors.map((descriptor) => descriptor.id).filter((action) => effective.actions.has(action));
  const canManage = effectiveActions.includes('file.share');
  // Non-managers see their effective permissions, never the membership/grant roster.
  const own = ancestry.policies[0];
  return { ...own, grants: canManage ? own.grants : [], workspacePolicyVersion: context.policyVersion, effectiveActions, canManage,
    inheritedFrom: canManage ? ancestry.policies.slice(1) : [], actionDescriptors };
}
async function validateGrants(env: PolicyEnv, fileId: string, value: unknown): Promise<PermissionGrant[]> {
  if (!Array.isArray(value) || value.length > 100) throw new PolicyError(400, 'invalid_grants', 'Provide up to 100 permission grants.');
  const scope = policyScope(env), grants: PermissionGrant[] = [], duplicates = new Set<string>();
  const item = await resource(env, fileId);
  if (!item) throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
  const descriptors = applicableActions(policyActionDescriptors(env), item.kind, item.mime_type);
  const previous = await readPolicy(env, fileId);
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError(400, 'invalid_grants', 'Provide valid permission grants.');
    const grant = raw as Record<string, unknown>;
    if (!['actor', 'group', 'role'].includes(String(grant.subjectType)) || typeof grant.subjectId !== 'string' || !grant.subjectId
      || !Array.isArray(grant.actions) || !grant.actions.length || !grant.actions.every(isPolicyActionId)
      || grant.actions.includes('workspace.manage') || new Set(grant.actions).size !== grant.actions.length) {
      throw new PolicyError(400, 'invalid_grants', 'Provide known resource permissions and subjects.');
    }
    const key = `${grant.subjectType}:${grant.subjectId}`;
    if (duplicates.has(key)) throw new PolicyError(400, 'invalid_grants', 'Combine duplicate permission subjects.');
    duplicates.add(key);
    const historical = previous.grants.find((entry) => entry.subjectType === grant.subjectType && entry.subjectId === grant.subjectId);
    // Removal deactivates execution, not saved access history. Unknown actions
    // cannot be added or transferred to another resource/permission subject.
    if (!grant.actions.every((action) => isPolicyAction(action, descriptors) || historical?.actions.includes(action as PolicyAction))) {
      throw new PolicyError(400, 'invalid_grants', 'Provide installed permissions, or preserve this entry’s existing inactive permissions.');
    }
    if (grant.subjectType === 'actor' && !(await membership(env, grant.subjectId))) throw new PolicyError(400, 'invalid_subject', 'Choose a member of this workspace.');
    if (grant.subjectType === 'role' && !isWorkspaceRole(grant.subjectId)) throw new PolicyError(400, 'invalid_subject', 'Choose a known workspace role.');
    if (grant.subjectType === 'group' && !(await database(env).prepare('SELECT id FROM workspace_groups WHERE id = ? AND organization_id = ? AND workspace_id = ?')
      .bind(grant.subjectId, scope.organizationId, scope.workspaceId).first())) throw new PolicyError(400, 'invalid_subject', 'Choose a group in this workspace.');
    grants.push({ id: crypto.randomUUID(), subjectType: grant.subjectType as PermissionGrant['subjectType'], subjectId: grant.subjectId, actions: grant.actions as PolicyAction[] });
  }
  return grants;
}
async function updatePolicy(request: Request, env: PolicyEnv, principal: Principal, fileId: string): Promise<Response> {
  await requireAction(env, principal, 'file.share', fileId); const body = await input(request);
  if (typeof body.inherit !== 'boolean' || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) throw new PolicyError(400, 'invalid_policy', 'Provide inheritance and the current policy version.');
  const grants = await validateGrants(env, fileId, body.grants), context = await resolveWorkspaceContext(env, principal), scope = policyScope(env), operation = crypto.randomUUID();
  await database(env).prepare('INSERT OR IGNORE INTO workspace_resource_policies (organization_id, workspace_id, resource_id) VALUES (?, ?, ?)')
    .bind(scope.organizationId, scope.workspaceId, fileId).run();
  const guard = 'EXISTS (SELECT 1 FROM workspace_resource_policies WHERE organization_id = ? AND workspace_id = ? AND resource_id = ? AND last_operation = ?)';
  const guardValues = [scope.organizationId, scope.workspaceId, fileId, operation];
  const statements = [database(env).prepare('UPDATE workspace_resource_policies SET inherit = ?, version = version + 1, last_operation = ? WHERE organization_id = ? AND workspace_id = ? AND resource_id = ? AND version = ?')
    .bind(body.inherit ? 1 : 0, operation, scope.organizationId, scope.workspaceId, fileId, body.expectedVersion as number),
  database(env).prepare(`DELETE FROM workspace_permission_grants WHERE organization_id = ? AND workspace_id = ? AND resource_id = ? AND ${guard}`)
    .bind(scope.organizationId, scope.workspaceId, fileId, ...guardValues),
  ...grants.map((grant) => database(env).prepare(`INSERT INTO workspace_permission_grants (id, organization_id, workspace_id, resource_id, subject_type, subject_id, actions_json) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`)
    .bind(grant.id!, scope.organizationId, scope.workspaceId, fileId, grant.subjectType, grant.subjectId, JSON.stringify(grant.actions), ...guardValues)),
  database(env).prepare(`UPDATE workspace_policy_state SET version = version + 1 WHERE organization_id = ? AND workspace_id = ? AND ${guard}`).bind(scope.organizationId, scope.workspaceId, ...guardValues),
  auditStatement(env, context.actor.id, 'file.share', fileId, { fileId, operation })];
  const results = await batch(env, statements);
  if (!results[0].meta?.changes) throw new PolicyError(409, 'policy_conflict', 'Access changed. Reload it before saving.');
  return json(await policyResponse(env, principal, fileId));
}
function publicActor(row: ActorRow): WorkspaceActor { return { id: row.id, kind: row.kind, provider: row.provider, subject: row.subject,
  ...(row.email ? { email: row.email } : {}), ...(row.display_name ? { displayName: row.display_name } : {}) }; }
async function listMembers(env: PolicyEnv): Promise<WorkspaceMember[]> {
  const scope = policyScope(env);
  const rows = (await database(env).prepare('SELECT a.*, m.role, m.status, m.version FROM workspace_actors a JOIN workspace_memberships m ON m.actor_id = a.id WHERE m.organization_id = ? AND m.workspace_id = ? ORDER BY a.id')
    .bind(scope.organizationId, scope.workspaceId).all<ActorRow & MemberRow>()).results;
  return rows.map((row) => ({ actor: publicActor(row), role: row.role, status: row.status, version: row.version }));
}
async function updateMember(request: Request, env: PolicyEnv, principal: Principal, targetId?: string): Promise<Response> {
  await requireAction(env, principal, 'workspace.manage'); const context = await resolveWorkspaceContext(env, principal), body = await input(request), scope = policyScope(env);
  if (!isWorkspaceRole(body.role) || !isMembershipStatus(body.status)) throw new PolicyError(400, 'invalid_member', 'Choose a workspace role and membership status.');
  if (body.role === 'owner' && context.membership?.role !== 'owner') throw new PolicyError(403, 'forbidden', 'Only an owner can assign the owner role.');
  if (!targetId) {
    if (!validIdentity(body.provider, body.subject)) throw new PolicyError(400, 'invalid_identity', 'Invite using the verified identity provider and subject.');
    targetId = await actorIdFor(body.provider, body.subject as string);
    await database(env).prepare('INSERT OR IGNORE INTO workspace_actors (id, kind, provider, subject) VALUES (?, ?, ?, ?)')
      .bind(targetId, 'user', body.provider, body.subject as string).run();
  }
  const existingActor = await database(env).prepare('SELECT * FROM workspace_actors WHERE id = ?').bind(targetId).first<ActorRow>();
  if (!existingActor) throw new PolicyError(404, 'not_found', 'The workspace actor was not found.');
  const owner = ownerIdentity(env), configuredOwnerId = await actorIdFor(owner.provider, owner.subject), existing = await membership(env, targetId);
  if (targetId === configuredOwnerId && (body.role !== 'owner' || body.status !== 'active')) throw new PolicyError(400, 'owner_protected', 'The configured owner must remain active. Change owner configuration deliberately before removing this owner.');
  if (existing?.role === 'owner' && context.membership?.role !== 'owner') throw new PolicyError(403, 'forbidden', 'Only an owner can change an owner membership.');
  if (targetId === context.actor.id && (body.role !== context.membership?.role || body.status !== 'active')) throw new PolicyError(400, 'self_membership', 'Ask another administrator to change your own management access.');
  await batch(env, [database(env).prepare("INSERT INTO workspace_memberships (organization_id, workspace_id, actor_id, role, status, admission) VALUES (?, ?, ?, ?, ?, 'explicit') ON CONFLICT(organization_id, workspace_id, actor_id) DO UPDATE SET role = excluded.role, status = excluded.status, admission = 'explicit', version = workspace_memberships.version + 1")
    .bind(scope.organizationId, scope.workspaceId, targetId, body.role, body.status),
  database(env).prepare('UPDATE workspace_policy_state SET version = version + 1 WHERE organization_id = ? AND workspace_id = ?').bind(scope.organizationId, scope.workspaceId),
  auditStatement(env, context.actor.id, 'workspace.manage', null)]);
  const member = (await listMembers(env)).find((entry) => entry.actor.id === targetId)!;
  return json({ member });
}
async function groups(env: PolicyEnv): Promise<WorkspaceGroup[]> {
  const scope = policyScope(env), rows = (await database(env).prepare('SELECT id, name FROM workspace_groups WHERE organization_id = ? AND workspace_id = ? ORDER BY id')
    .bind(scope.organizationId, scope.workspaceId).all<{ id: string; name: string }>()).results;
  const result: WorkspaceGroup[] = [];
  for (const group of rows) result.push({ ...group, memberActorIds: (await database(env).prepare('SELECT actor_id FROM workspace_group_members WHERE group_id = ? ORDER BY actor_id').bind(group.id).all<{ actor_id: string }>()).results.map((entry) => entry.actor_id) });
  return result;
}
async function updateGroup(request: Request, env: PolicyEnv, principal: Principal, targetId?: string): Promise<Response> {
  await requireAction(env, principal, 'workspace.manage'); const body = await input(request), scope = policyScope(env), context = await resolveWorkspaceContext(env, principal);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || /[\p{Cc}]/u.test(body.name) || !Array.isArray(body.memberActorIds)
    || body.memberActorIds.length > 100 || !body.memberActorIds.every((id) => typeof id === 'string') || new Set(body.memberActorIds).size !== body.memberActorIds.length) throw new PolicyError(400, 'invalid_group', 'Provide a group name and up to 100 unique workspace members.');
  for (const id of body.memberActorIds) if (!(await membership(env, id as string))) throw new PolicyError(400, 'invalid_subject', 'Choose members of this workspace.');
  const id = targetId ?? crypto.randomUUID();
  if (targetId && !(await database(env).prepare('SELECT id FROM workspace_groups WHERE id = ? AND organization_id = ? AND workspace_id = ?').bind(id, scope.organizationId, scope.workspaceId).first())) throw new PolicyError(404, 'not_found', 'The workspace group was not found.');
  await batch(env, [database(env).prepare('INSERT INTO workspace_groups (id, organization_id, workspace_id, name) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = workspace_groups.version + 1').bind(id, scope.organizationId, scope.workspaceId, body.name.trim()),
    database(env).prepare('DELETE FROM workspace_group_members WHERE group_id = ?').bind(id),
    ...body.memberActorIds.map((actorId) => database(env).prepare('INSERT INTO workspace_group_members (group_id, actor_id) VALUES (?, ?)').bind(id, actorId as string)),
    database(env).prepare('UPDATE workspace_policy_state SET version = version + 1 WHERE organization_id = ? AND workspace_id = ?').bind(scope.organizationId, scope.workspaceId), auditStatement(env, context.actor.id, 'workspace.manage', null)]);
  return json({ group: (await groups(env)).find((group) => group.id === id) }, targetId ? 200 : 201);
}
export async function validateInitialResourcePolicy(
  env: PolicyEnv,
  context: WorkspaceContext,
  mimeType: string,
  value: unknown,
): Promise<{ inherit: false; grants: PermissionGrant[] }> {
  if (typeof mimeType !== 'string' || !/^application\/vnd\.open-cloud\.[a-z0-9][a-z0-9.+_-]*\+json$/.test(mimeType)) {
    throw new PolicyError(400, 'invalid_mime_type', 'Initial resource policy is only supported for native files.');
  }
  const scope = policyScope(env);
  if (context.organizationId !== scope.organizationId || context.workspaceId !== scope.workspaceId) {
    throw new PolicyError(403, 'forbidden', 'You do not have access to this workspace.');
  }
  if (!context.membership || context.membership.status !== 'active' || context.actor?.kind !== 'user') {
    throw new PolicyError(403, 'forbidden', 'You do not have access to this workspace.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(400, 'invalid_policy', 'Provide an initial resource policy object.');
  }
  const policyKeys = Object.keys(value);
  if (policyKeys.some((key) => key !== 'inherit' && key !== 'grants')) {
    throw new PolicyError(400, 'invalid_policy', 'Provide only inherit and grants for initial policy.');
  }
  const record = value as Record<string, unknown>;
  if (record.inherit !== false) {
    throw new PolicyError(400, 'invalid_policy', 'Initial resource policy must set inherit to false.');
  }
  if (!Array.isArray(record.grants)) {
    throw new PolicyError(400, 'invalid_policy', 'Provide a grants array.');
  }
  if (record.grants.length > 100) {
    throw new PolicyError(400, 'invalid_grants', 'Provide at most 100 initial grants.');
  }

  const descriptors = applicableActions(policyActionDescriptors(env), 'file', mimeType);
  const subjects = new Set<string>();
  const grantIds = new Set<string>();
  const normalizedGrants: PermissionGrant[] = [];

  for (const raw of record.grants) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PolicyError(400, 'invalid_grants', 'Provide valid permission grants.');
    }
    const grant = raw as Record<string, unknown>;
    const grantKeys = Object.keys(grant);
    if (grantKeys.some((key) => key !== 'subjectType' && key !== 'subjectId' && key !== 'actions' && key !== 'id')) {
      throw new PolicyError(400, 'invalid_grants', 'Unknown grant fields are not allowed.');
    }
    if (grant.id !== undefined) {
      if (typeof grant.id !== 'string' || grant.id.length > 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(grant.id)) {
        throw new PolicyError(400, 'invalid_grants', 'Grant ID must be a valid UUID of at most 36 bytes.');
      }
      if (grantIds.has(grant.id)) {
        throw new PolicyError(400, 'invalid_grants', 'Duplicate grant IDs are not allowed.');
      }
      grantIds.add(grant.id);
    }
    if (grant.subjectType !== 'actor') {
      throw new PolicyError(400, 'invalid_subject', 'Initial resource policy allows only actor subjects.');
    }
    if (typeof grant.subjectId !== 'string' || !/^actor_[0-9a-f]{64}$/.test(grant.subjectId)) {
      throw new PolicyError(400, 'invalid_subject', 'Actor subject IDs must be formatted as actor_[hex64].');
    }
    if (subjects.has(grant.subjectId)) {
      throw new PolicyError(400, 'invalid_grants', 'Combine duplicate permission subjects.');
    }
    subjects.add(grant.subjectId);

    const activeMember = await database(env).prepare(
      "SELECT a.kind, m.status FROM workspace_memberships m JOIN workspace_actors a ON a.id = m.actor_id WHERE m.organization_id = ? AND m.workspace_id = ? AND m.actor_id = ?"
    ).bind(scope.organizationId, scope.workspaceId, grant.subjectId).first<{ kind: string; status: string }>();
    if (!activeMember || activeMember.status !== 'active' || activeMember.kind !== 'user') {
      throw new PolicyError(400, 'invalid_subject', 'Choose an active human member of this workspace.');
    }

    if (!Array.isArray(grant.actions) || !grant.actions.length || grant.actions.length > 64 || !grant.actions.every(isPolicyActionId)
      || grant.actions.includes('workspace.manage') || new Set(grant.actions).size !== grant.actions.length) {
      throw new PolicyError(400, 'invalid_grants', 'Provide unique known resource permissions.');
    }

    if (!grant.actions.every((action) => isPolicyAction(action, descriptors))) {
      throw new PolicyError(400, 'invalid_grants', 'Provide installed permissions applicable to this file type.');
    }

    const normalized: PermissionGrant = {
      subjectType: 'actor',
      subjectId: grant.subjectId,
      actions: grant.actions as PolicyAction[],
    };
    if (typeof grant.id === 'string' && grant.id) {
      normalized.id = grant.id;
    }
    normalizedGrants.push(normalized);
  }

  const REQUIRED_CREATOR_ACTIONS: PolicyAction[] = ['file.read', 'file.edit', 'file.share', 'file.move', 'file.delete'];
  const creatorGrant = normalizedGrants.find((g) => g.subjectId === context.actor.id);
  if (!creatorGrant || !REQUIRED_CREATOR_ACTIONS.every((action) => creatorGrant.actions.includes(action))) {
    throw new PolicyError(400, 'invalid_grants', 'The caller grant must include file.read, file.edit, file.share, file.move, and file.delete.');
  }

  return { inherit: false, grants: normalizedGrants };
}

export function initialResourcePolicyStatements(
  env: PolicyEnv,
  resourceId: string,
  policy: { inherit: false; grants: PermissionGrant[] },
): PolicyStatement[] {
  const scope = policyScope(env);
  const db = database(env);
  return [
    db.prepare('INSERT INTO workspace_resource_policies (organization_id, workspace_id, resource_id, inherit, version) VALUES (?, ?, ?, ?, 1)')
      .bind(scope.organizationId, scope.workspaceId, resourceId, policy.inherit ? 1 : 0),
    ...policy.grants.map((grant) =>
      db.prepare('INSERT INTO workspace_permission_grants (id, organization_id, workspace_id, resource_id, subject_type, subject_id, actions_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(grant.id ?? crypto.randomUUID(), scope.organizationId, scope.workspaceId, resourceId, grant.subjectType, grant.subjectId, JSON.stringify(grant.actions))
    ),
    db.prepare('UPDATE workspace_policy_state SET version = version + 1 WHERE organization_id = ? AND workspace_id = ?')
      .bind(scope.organizationId, scope.workspaceId),
  ];
}

export async function matchesInitialResourcePolicy(
  env: PolicyEnv,
  resourceId: string,
  policy: { inherit: false; grants: PermissionGrant[] },
): Promise<boolean> {
  const scope = policyScope(env);
  const db = database(env);
  const policyRow = await db.prepare('SELECT inherit FROM workspace_resource_policies WHERE organization_id = ? AND workspace_id = ? AND resource_id = ?')
    .bind(scope.organizationId, scope.workspaceId, resourceId).first<{ inherit: number }>();
  if (!policyRow) return false;
  if (Boolean(policyRow.inherit) !== policy.inherit) return false;

  const grantRows = (await db.prepare('SELECT id, subject_type, subject_id, actions_json FROM workspace_permission_grants WHERE organization_id = ? AND workspace_id = ? AND resource_id = ?')
    .bind(scope.organizationId, scope.workspaceId, resourceId).all<{ id: string; subject_type: string; subject_id: string; actions_json: string }>()).results;

  if (grantRows.length !== policy.grants.length) return false;

  for (const proposed of policy.grants) {
    const existing = grantRows.find((g) => g.subject_type === proposed.subjectType && g.subject_id === proposed.subjectId);
    if (!existing) return false;
    if (proposed.id && existing.id !== proposed.id) return false;
    let existingActions: unknown;
    try { existingActions = JSON.parse(existing.actions_json); } catch { return false; }
    if (!Array.isArray(existingActions)) return false;
    if (existingActions.length !== proposed.actions.length) return false;
    const actionSet = new Set(existingActions);
    if (!proposed.actions.every((action) => actionSet.has(action))) return false;
  }
  return true;
}

async function listPeople(env: PolicyEnv): Promise<Array<{ actorId: string; displayName: string }>> {
  const scope = policyScope(env);
  const rows = (await database(env).prepare(
    "SELECT a.id, a.display_name FROM workspace_actors a JOIN workspace_memberships m ON m.actor_id = a.id WHERE m.organization_id = ? AND m.workspace_id = ? AND m.status = 'active' AND a.kind = 'user' ORDER BY a.id"
  ).bind(scope.organizationId, scope.workspaceId).all<{ id: string; display_name: string | null }>()).results;
  return rows.map((row) => ({ actorId: row.id, displayName: row.display_name?.trim() || 'Workspace member' }));
}

async function handleEligibility(request: Request, env: PolicyEnv, principal: Principal, fileId: string): Promise<Response> {
  await requireAction(env, principal, 'file.share', fileId);
  const scope = policyScope(env);
  const target = await resource(env, fileId);
  if (!target || target.organization_id !== scope.organizationId || target.workspace_id !== scope.workspaceId) {
    throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
  }
  const body = await input(request);
  if (!Object.hasOwn(body, 'actorIds') || !Object.hasOwn(body, 'actions')) {
    throw new PolicyError(400, 'invalid_request', 'actorIds and actions are required.');
  }
  if (Object.keys(body).some((k) => !['actorIds', 'actions', 'relatedResourceIds'].includes(k))) {
    throw new PolicyError(400, 'invalid_request', 'Unknown fields are not allowed.');
  }
  if (!Array.isArray(body.actorIds) || !body.actorIds.length || body.actorIds.length > 32
    || !body.actorIds.every((id) => typeof id === 'string' && /^actor_[0-9a-f]{64}$/.test(id))
    || new Set(body.actorIds).size !== body.actorIds.length) {
    throw new PolicyError(400, 'invalid_request', 'Provide up to 32 unique valid actor IDs.');
  }
  if (!Array.isArray(body.actions) || !body.actions.length || body.actions.length > 8
    || !body.actions.every(isPolicyActionId) || body.actions.includes('workspace.manage')
    || new Set(body.actions).size !== body.actions.length) {
    throw new PolicyError(400, 'invalid_request', 'Provide up to 8 unique valid actions.');
  }
  const descriptors = applicableActions(policyActionDescriptors(env), target.kind, target.mime_type);
  if (!body.actions.every((action: string) => isPolicyAction(action, descriptors))) {
    throw new PolicyError(400, 'invalid_action', 'Provide installed permissions applicable to this file type.');
  }
  const relatedIds: string[] = [];
  if (body.relatedResourceIds !== undefined) {
    if (!Array.isArray(body.relatedResourceIds) || body.relatedResourceIds.length > 8
      || !body.relatedResourceIds.every((id) => typeof id === 'string' && isWorkspaceResourceId(id))
      || new Set(body.relatedResourceIds).size !== body.relatedResourceIds.length) {
      throw new PolicyError(400, 'invalid_request', 'Provide up to 8 unique valid related resource IDs.');
    }
    relatedIds.push(...(body.relatedResourceIds as string[]));
  }
  for (const relId of relatedIds) {
    const relItem = await resource(env, relId);
    if (!relItem || relItem.organization_id !== scope.organizationId || relItem.workspace_id !== scope.workspaceId) {
      throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
    }
    const decision = await authorizeResource(env, principal, 'file.read', relId);
    if (!decision.allowed) {
      throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
    }
  }
  const allFiles = [fileId, ...relatedIds];
  const eligibility: Array<{ actorId: string; eligible: boolean }> = [];
  for (const actorId of body.actorIds as string[]) {
    const member = await database(env).prepare(
      "SELECT a.kind, m.status FROM workspace_memberships m JOIN workspace_actors a ON a.id = m.actor_id WHERE m.organization_id = ? AND m.workspace_id = ? AND m.actor_id = ?"
    ).bind(scope.organizationId, scope.workspaceId, actorId).first<{ kind: string; status: string }>();
    if (!member || member.status !== 'active' || member.kind !== 'user') {
      eligibility.push({ actorId, eligible: false });
      continue;
    }
    const effective = await effectiveResources(env, { organizationId: scope.organizationId, workspaceId: scope.workspaceId, actorId }, allFiles);
    const caseActions = effective.get(fileId)?.actions;
    const hasActions = (body.actions as string[]).every((act) => caseActions?.has(act as PolicyAction));
    const hasRelated = relatedIds.every((relId) => effective.get(relId)?.actions.has('file.read'));
    eligibility.push({ actorId, eligible: Boolean(hasActions && hasRelated) });
  }
  return json({ eligibility });
}

async function handleAudience(request: Request, env: PolicyEnv, principal: Principal, fileId: string): Promise<Response> {
  await requireAction(env, principal, 'file.share', fileId);
  const scope = policyScope(env);
  const target = await resource(env, fileId);
  if (!target || target.organization_id !== scope.organizationId || target.workspace_id !== scope.workspaceId) {
    throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
  }
  const body = await input(request);
  if (Object.keys(body).some((k) => k !== 'relatedResourceIds')) {
    throw new PolicyError(400, 'invalid_request', 'Unknown fields are not allowed.');
  }
  const relatedIds: string[] = [];
  if (body.relatedResourceIds !== undefined) {
    if (!Array.isArray(body.relatedResourceIds) || body.relatedResourceIds.length > 8
      || !body.relatedResourceIds.every((id) => typeof id === 'string' && isWorkspaceResourceId(id))
      || new Set(body.relatedResourceIds).size !== body.relatedResourceIds.length) {
      throw new PolicyError(400, 'invalid_request', 'Provide up to 8 unique valid related resource IDs.');
    }
    relatedIds.push(...(body.relatedResourceIds as string[]));
  }
  for (const relId of relatedIds) {
    const relItem = await resource(env, relId);
    if (!relItem || relItem.organization_id !== scope.organizationId || relItem.workspace_id !== scope.workspaceId) {
      throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
    }
    const decision = await authorizeResource(env, principal, 'file.read', relId);
    if (!decision.allowed) {
      throw new PolicyError(404, 'not_found', 'The workspace resource was not found.');
    }
  }
  const activeHumans = (await database(env).prepare(
    "SELECT a.id, a.display_name FROM workspace_actors a JOIN workspace_memberships m ON m.actor_id = a.id WHERE m.organization_id = ? AND m.workspace_id = ? AND m.status = 'active' AND a.kind = 'user' ORDER BY a.id"
  ).bind(scope.organizationId, scope.workspaceId).all<{ id: string; display_name: string | null }>()).results;

  const descriptors = applicableActions(policyActionDescriptors(env), target.kind, target.mime_type);
  const allFiles = [fileId, ...relatedIds];
  const members: Array<{ actorId: string; displayName: string; actions: PolicyAction[] }> = [];

  for (const human of activeHumans) {
    const effective = await effectiveResources(env, { organizationId: scope.organizationId, workspaceId: scope.workspaceId, actorId: human.id }, allFiles);
    const caseEffective = effective.get(fileId);
    if (!caseEffective?.actions.has('file.read')) continue;
    if (!relatedIds.every((relId) => effective.get(relId)?.actions.has('file.read'))) continue;
    const actions = descriptors.map((d) => d.id).filter((action) => caseEffective.actions.has(action));
    members.push({ actorId: human.id, displayName: human.display_name?.trim() || 'Workspace member', actions });
  }
  return json({ members });
}

export async function handlePolicyRequest(request: Request, env: PolicyEnv, principal: Principal): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  const policyMatch = /^\/api\/policies\/([0-9a-f-]+)$/i.exec(path), memberMatch = /^\/api\/members\/(actor_[0-9a-f]{64})$/.exec(path), groupMatch = /^\/api\/groups\/([0-9a-f-]+)$/i.exec(path);
  const eligibilityMatch = /^\/api\/files\/([0-9a-f-]+)\/eligibility$/i.exec(path);
  const audienceMatch = /^\/api\/files\/([0-9a-f-]+)\/audience$/i.exec(path);
  if (!['/api/workspace', '/api/authorize', '/api/members', '/api/groups', '/api/people'].includes(path) && !policyMatch && !memberMatch && !groupMatch && !eligibilityMatch && !audienceMatch) return null;
  try {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) checkOrigin(request);
    if (path === '/api/people') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405);
      const context = await resolveWorkspaceContext(env, principal);
      if (context.membership?.status !== 'active') throw new PolicyError(403, 'forbidden', 'You do not have access to this workspace.');
      const people = await listPeople(env);
      return request.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/json' } })
        : json({ people });
    }
    if (eligibilityMatch) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const fileId = eligibilityMatch[1];
      if (!isWorkspaceResourceId(fileId)) throw new PolicyError(400, 'invalid_resource', 'Choose a valid workspace resource.');
      return await handleEligibility(request, env, principal, fileId);
    }
    if (audienceMatch) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const fileId = audienceMatch[1];
      if (!isWorkspaceResourceId(fileId)) throw new PolicyError(400, 'invalid_resource', 'Choose a valid workspace resource.');
      return await handleAudience(request, env, principal, fileId);
    }
    if (path === '/api/workspace' && (request.method === 'GET' || request.method === 'HEAD')) {
      const context = await resolveWorkspaceContext(env, principal);
      const actionDescriptors = policyActionDescriptors(env);
      const actions = context.membership?.status === 'active' ? defaults(context.membership, context.legacyShared, actionDescriptors) : [];
      return json({ ...context, actions, actionDescriptors });
    }
    if (path === '/api/authorize' && request.method === 'GET') {
      const action = url.searchParams.get('action'), fileId = url.searchParams.get('fileId');
      if (!isPolicyAction(action, policyActionDescriptors(env)) || (fileId !== null && !isWorkspaceResourceId(fileId))) throw new PolicyError(400, 'invalid_action', 'Choose an installed permission and workspace resource.');
      return json(await authorizeResource(env, principal, action, fileId));
    }
    if (path === '/api/workspace' && request.method === 'PATCH') {
      await requireAction(env, principal, 'workspace.manage'); const body = await input(request), scope = policyScope(env), context = await resolveWorkspaceContext(env, principal);
      if (typeof body.legacyShared !== 'boolean' || !Number.isSafeInteger(body.expectedVersion)) throw new PolicyError(400, 'invalid_policy', 'Provide the current workspace policy version and legacy mode.');
      const statements = [database(env).prepare('UPDATE workspace_policy_state SET legacy_shared = ?, version = version + 1 WHERE organization_id = ? AND workspace_id = ? AND version = ?').bind(body.legacyShared ? 1 : 0, scope.organizationId, scope.workspaceId, body.expectedVersion as number),
        auditStatement(env, context.actor.id, 'workspace.manage', null, undefined, true)];
      const result = await batch(env, statements); if (!result[0].meta?.changes) throw new PolicyError(409, 'policy_conflict', 'Workspace access changed. Reload it before saving.');
      return json(await resolveWorkspaceContext(env, principal));
    }
    if (policyMatch) {
      const fileId = policyMatch[1]; if (!isWorkspaceResourceId(fileId)) throw new PolicyError(400, 'invalid_resource', 'Choose a valid workspace resource.');
      if (request.method === 'GET') return json(await policyResponse(env, principal, fileId));
      if (request.method === 'PUT') return await updatePolicy(request, env, principal, fileId);
    }
    if (path === '/api/members' && request.method === 'GET') { await requireAction(env, principal, 'workspace.manage'); return json({ members: await listMembers(env) }); }
    if ((path === '/api/members' || memberMatch) && request.method === 'PUT') return await updateMember(request, env, principal, memberMatch?.[1]);
    if (path === '/api/groups' && request.method === 'GET') { await requireAction(env, principal, 'workspace.manage'); return json({ groups: await groups(env) }); }
    if (path === '/api/groups' && request.method === 'POST') return await updateGroup(request, env, principal);
    if (groupMatch && request.method === 'PUT') return await updateGroup(request, env, principal, groupMatch[1]);
    return json({ error: 'method_not_allowed' }, 405);
  } catch (error) {
    if (error instanceof PolicyError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: 'policy_unavailable', message: 'Workspace access is unavailable. Try again.' }, 503);
  }
}
