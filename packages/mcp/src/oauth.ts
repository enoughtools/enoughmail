import { CORE_POLICY_ACTION_DESCRIPTORS, isPolicyActionId, type PolicyActionDescriptor, type Principal } from '@open-cloud/contracts';

/** Deliberately narrow public-client OAuth surface; no client URL is fetched. */
export const MCP_OAUTH_ACTIONS = ['file.read', 'file.edit'] as const;
export interface OAuthStatement {
  bind(...values: Array<string | number | null>): OAuthStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}
export interface OAuthDatabase { prepare(query: string): OAuthStatement }
export interface OAuthEnv {
  CATALOG: OAuthDatabase;
  MCP_PUBLIC_ORIGIN?: string;
  MCP_ENABLED?: string;
}
export interface OAuthWorkspaceContext {
  organizationId: string;
  workspaceId: string;
  actor: { id: string };
  membership: { status: string; version?: number } | null;
}
export interface OAuthCallbacks {
  identify(request: Request): Promise<Principal>;
  /** Must resolve current admission; a client-supplied organization is never trusted. */
  resolveContext(principal: Principal): Promise<OAuthWorkspaceContext>;
  /** Current installed MCP actions, supplied by Core; consent rechecks this list. */
  actionDescriptors?(): readonly PolicyActionDescriptor[];
}
export interface McpClientGrant {
  id: string;
  clientId: string;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  actions: string[];
  /** null means the user's currently accessible files, never unrestricted access. */
  resourceIds: string[] | null;
  version: number;
}
export interface McpAuthorization { grant: McpClientGrant; principal: Principal }
export interface McpGrantSummary {
  id: string;
  clientId: string;
  clientName: string;
  actions: string[];
  resourceIds: string[] | null;
  createdAt: string;
  revokedAt: string | null;
  version: number;
}

interface ClientRow { id: string; name: string; redirect_uris: string; registered_expires_at: number; consented?: number }
interface PendingRow {
  id: string; csrf_hash: string; client_id: string; redirect_uri: string; audience: string;
  state: string | null; challenge: string; actions: string; organization_id: string;
  workspace_id: string; actor_id: string; provider: string; subject: string;
  expires_at: number; consumed_at: number | null;
}
interface GrantRow {
  id: string; client_id: string; organization_id: string; workspace_id: string; actor_id: string;
  provider: string; subject: string; email: string; display_name: string; audience: string;
  actions: string; resource_ids: string | null; version: number; created_at: number; revoked_at: number | null;
}
interface CodeRow {
  code_hash: string; grant_id: string; client_id: string; redirect_uri: string;
  audience: string; challenge: string; expires_at: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = () => Math.floor(Date.now() / 1000);
const MAX_BODY = 16_384;
const MAX_CLIENTS = 1_000;
const REGISTRATION_LIFETIME = 1_800;
const REGISTRATION_WINDOW = 300;
const MAX_REGISTRATIONS_PER_WINDOW = 20;
const CLEANUP_BATCH = 100;
const MAX_PENDING_PER_ACTOR = 20;
const MAX_ACTIVE_GRANTS_PER_ACTOR = 100;
const MAX_SCOPE_ACTIONS = 64;
const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: SECURITY_HEADERS });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function string(value: unknown, max = 2_048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function strings(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('Invalid OAuth storage.');
  return parsed;
}
function activeActionDescriptors(callbacks: OAuthCallbacks): readonly PolicyActionDescriptor[] {
  let descriptors: readonly PolicyActionDescriptor[];
  try {
    descriptors = callbacks.actionDescriptors ? callbacks.actionDescriptors()
      : CORE_POLICY_ACTION_DESCRIPTORS.filter((descriptor) => (MCP_OAUTH_ACTIONS as readonly string[]).includes(descriptor.id));
  } catch { throw new OAuthError('server_not_configured', 'The active permission vocabulary is unavailable.', 503); }
  if (!Array.isArray(descriptors) || new Set(descriptors.map((descriptor) => descriptor?.id)).size !== descriptors.length
    || !descriptors.every((descriptor) => descriptor && isPolicyActionId(descriptor.id)
      && string(descriptor.label, 160) && string(descriptor.group, 160))) {
    throw new OAuthError('server_not_configured', 'The active permission vocabulary could not be verified.', 503);
  }
  return descriptors;
}
function scope(value: string | null, descriptors: readonly PolicyActionDescriptor[]): string[] {
  const actions = value === null ? ['file.read'] : value.split(' ');
  if (!actions.length || actions.length > MAX_SCOPE_ACTIONS || new Set(actions).size !== actions.length
    || !actions.every(action => descriptors.some((descriptor) => descriptor.id === action))) {
    throw new OAuthError('invalid_scope', 'Select up to 64 distinct permissions from the current installed tool vocabulary.');
  }
  return actions;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function secret(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
function publicOrigin(request: Request, env: OAuthEnv): string {
  const requested = new URL(request.url);
  let configured: URL;
  try { configured = new URL(env.MCP_PUBLIC_ORIGIN ?? (LOOPBACK.has(requested.hostname) ? requested.origin : '')); }
  catch { throw new OAuthError('server_not_configured', 'A trusted MCP public origin must be configured.', 503); }
  if (configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash
    || (configured.protocol !== 'https:' && !(configured.protocol === 'http:' && LOOPBACK.has(configured.hostname)))) {
    throw new OAuthError('server_not_configured', 'The MCP public origin is invalid.', 503);
  }
  if (requested.origin !== configured.origin) throw new OAuthError('invalid_request', 'This request used an unexpected server origin.');
  return configured.origin;
}
function redirectUri(value: unknown): value is string {
  if (!string(value)) return false;
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password && !parsed.hash
      && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)));
  } catch { return false; }
}
function requireOrigin(request: Request, origin: string): void {
  if (request.headers.get('Origin') !== origin) throw new OAuthError('invalid_request', 'A same-origin browser request is required.', 403);
}
function one(parameters: URLSearchParams, name: string, required = true, max = 2_048): string | null {
  const values = parameters.getAll(name);
  if (values.length > 1 || (required && values.length !== 1) || (values.length && !string(values[0], max))) {
    throw new OAuthError('invalid_request', `The ${name} parameter is invalid.`);
  }
  return values[0] ?? null;
}
async function readBody(request: Request): Promise<string> {
  if (!request.body) throw new OAuthError('invalid_request', 'A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new OAuthError('invalid_request', 'The request body is too large.', 413); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new OAuthError('invalid_request', 'The request body is not valid UTF-8.'); }
}
async function formBody(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', 'Use a form-encoded request body.');
  }
  return new URLSearchParams(await readBody(request));
}
function requireContext(context: OAuthWorkspaceContext): void {
  if (!string(context.organizationId, 256) || !string(context.workspaceId, 256) || !string(context.actor?.id, 256)
    || !context.membership || context.membership.status !== 'active') {
    throw new OAuthError('access_denied', 'Active workspace membership is required.', 403);
  }
}
function contextMatches(context: OAuthWorkspaceContext, record: { organization_id: string; workspace_id: string; actor_id: string }): boolean {
  return context.organizationId === record.organization_id && context.workspaceId === record.workspace_id && context.actor.id === record.actor_id;
}
function principalFromGrant(row: GrantRow): Principal {
  return { id: row.subject, provider: row.provider, email: row.email, displayName: row.display_name };
}
function authorizationFromGrant(row: GrantRow): McpAuthorization {
  return {
    principal: principalFromGrant(row),
    grant: {
      id: row.id, clientId: row.client_id, organizationId: row.organization_id, workspaceId: row.workspace_id,
      actorId: row.actor_id, actions: strings(row.actions), resourceIds: row.resource_ids === null ? null : strings(row.resource_ids), version: row.version,
    },
  };
}
async function currentIdentity(request: Request, callbacks: OAuthCallbacks) {
  const principal = await callbacks.identify(request);
  const context = await callbacks.resolveContext(principal);
  requireContext(context);
  return { principal, context };
}
async function cleanup(env: OAuthEnv): Promise<void> {
  // Bounded persisted records, with no idle DO, timer or alarm per client.
  const now = NOW();
  for (const [table, key] of [['mcp_oauth_pending', 'id'], ['mcp_oauth_codes', 'code_hash'], ['mcp_oauth_tokens', 'token_hash']]) {
    await env.CATALOG.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires_at <= ? LIMIT ?)`)
      .bind(now, CLEANUP_BATCH).run();
  }
  await env.CATALOG.prepare(`DELETE FROM mcp_oauth_clients WHERE id IN (
    SELECT c.id FROM mcp_oauth_clients c WHERE c.registered_expires_at <= ?
    AND NOT EXISTS (SELECT 1 FROM mcp_client_grants g WHERE g.client_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM mcp_oauth_pending p WHERE p.client_id = c.id)
    ORDER BY c.registered_expires_at LIMIT ?)`)
    .bind(now, CLEANUP_BATCH).run();
  await env.CATALOG.prepare(`DELETE FROM mcp_registration_admission WHERE (subject_hash, window_start) IN (
    SELECT subject_hash, window_start FROM mcp_registration_admission WHERE window_start < ? LIMIT ?)`)
    .bind(Math.floor(now / REGISTRATION_WINDOW) * REGISTRATION_WINDOW, CLEANUP_BATCH).run();
}
async function admitRegistration(request: Request, env: OAuthEnv): Promise<void> {
  // Cloudflare overwrites this header on the public edge. Missing addresses
  // intentionally share one bucket, rather than allowing unbounded bypass.
  const address = request.headers.get('CF-Connecting-IP');
  const subject = address && /^[0-9a-fA-F:.]{3,128}$/.test(address) ? address : 'unknown-network';
  const subjectHash = await digest(JSON.stringify([env.MCP_PUBLIC_ORIGIN ?? new URL(request.url).origin, subject]));
  const window = Math.floor(NOW() / REGISTRATION_WINDOW) * REGISTRATION_WINDOW;
  const admitted = await env.CATALOG.prepare(`INSERT INTO mcp_registration_admission (subject_hash, window_start, registrations)
    SELECT ?, ?, 1 WHERE (SELECT COUNT(*) FROM mcp_registration_admission WHERE window_start = ?) < ?
      OR EXISTS (SELECT 1 FROM mcp_registration_admission WHERE subject_hash = ? AND window_start = ?)
    ON CONFLICT(subject_hash, window_start) DO UPDATE SET registrations = registrations + 1
      WHERE registrations < ? RETURNING registrations`)
    .bind(subjectHash, window, window, MAX_CLIENTS, subjectHash, window, MAX_REGISTRATIONS_PER_WINDOW).first<{ registrations: number }>();
  if (!admitted) throw new OAuthError('temporarily_unavailable', 'Client registration is temporarily rate limited. Try again in five minutes.', 429);
}
async function register(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new OAuthError('invalid_client_metadata', 'Use a JSON registration request.');
  }
  let body: unknown;
  try { body = JSON.parse(await readBody(request)); }
  catch (error) { if (error instanceof OAuthError) throw error; throw new OAuthError('invalid_client_metadata', 'The registration is not valid JSON.'); }
  if (!isRecord(body) || !string(body.client_name, 120) || !Array.isArray(body.redirect_uris)
    || !body.redirect_uris.length || body.redirect_uris.length > 8 || !body.redirect_uris.every(redirectUri)
    || new Set(body.redirect_uris).size !== body.redirect_uris.length
    || (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none')
    || (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.length !== 1 || body.grant_types[0] !== 'authorization_code'))
    || (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== 'code'))) {
    throw new OAuthError('invalid_client_metadata', 'Register a public authorization-code client with exact HTTPS or loopback redirect URIs.');
  }
  await cleanup(env);
  await admitRegistration(request, env);
  const clientId = crypto.randomUUID();
  // Only live, unapproved clients use anonymous admission slots. Approved
  // client metadata cannot be crowded out by anonymous registrations.
  const inserted = await env.CATALOG.prepare(`INSERT INTO mcp_oauth_clients (id, name, redirect_uris, created_at, registered_expires_at)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM mcp_oauth_clients c WHERE c.registered_expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM mcp_client_grants g WHERE g.client_id = c.id)) < ?`)
    .bind(clientId, body.client_name, JSON.stringify(body.redirect_uris), NOW(), NOW() + REGISTRATION_LIFETIME, NOW(), MAX_CLIENTS).run();
  if (!inserted.success || inserted.meta?.changes !== 1) throw new OAuthError('temporarily_unavailable', 'Client registration has reached its configured capacity.', 429);
  return json({ client_id: clientId, client_id_issued_at: NOW(), client_name: body.client_name, redirect_uris: body.redirect_uris,
    grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }, 201);
}
function consentHtml(client: ClientRow, pendingId: string, csrf: string, actions: string[], descriptors: readonly PolicyActionDescriptor[], principal: Principal, redirect: string): string {
  const labels = new Map<string, string>(descriptors.map((descriptor) => [descriptor.id, `${descriptor.group}: ${descriptor.label}`]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Enough Tools</title>
    <style>body{font:16px/1.5 system-ui,sans-serif;color:#12151c;background:#f4f5f8;margin:0;padding:24px}main{max-width:640px;margin:40px auto;background:white;border:1px solid #12151c;padding:32px}h1{font-family:Georgia,serif;font-weight:400}label{display:block;margin:16px 0}input[type=text],textarea{display:block;width:100%;box-sizing:border-box;padding:12px;font:inherit;border:1px solid #12151c}button{font:inherit;border:1px solid #12151c;background:#fff;padding:12px 20px;cursor:pointer}button[value=approve]{background:#3b4fe4;color:white}small{display:block;color:#525a68;overflow-wrap:anywhere}.buttons{display:flex;gap:12px;flex-wrap:wrap}</style></head><body><main>
    <h1>Connect ${escapeHtml(client.name)}</h1><p>Signed in as ${escapeHtml(principal.displayName)} (${escapeHtml(principal.email)}).</p>
    <p>This client will act on your behalf. It receives only the permissions you select, for files you can currently access. Workspace policies continue to apply.</p>
    <form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escapeHtml(pendingId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    ${actions.map(action => `<label><input type="checkbox" name="action" value="${escapeHtml(action)}" checked> ${escapeHtml(labels.get(action)!)}</label>`).join('')}
    <label><input type="radio" name="resource_scope" value="accessible" checked> All files I can access, including future files</label>
    <label><input type="radio" name="resource_scope" value="selected"> Only these file IDs</label><textarea name="resource_ids" rows="3" aria-label="Specific file IDs" placeholder="One file ID per line"></textarea>
    <p><small>The authorization result returns to ${escapeHtml(redirect)}. Client names are supplied by clients; approve only a client you recognize.</small></p>
    <div class="buttons"><button name="decision" value="approve" type="submit">Allow access</button><button name="decision" value="deny" type="submit">Cancel</button></div></form>
    </main></body></html>`;
}
async function authorizeGet(request: Request, env: OAuthEnv, callbacks: OAuthCallbacks, origin: string): Promise<Response> {
  const parameters = new URL(request.url).searchParams;
  if (one(parameters, 'response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only authorization codes are supported.');
  const clientId = one(parameters, 'client_id')!;
  const redirect = one(parameters, 'redirect_uri')!;
  const resource = one(parameters, 'resource')!;
  const challenge = one(parameters, 'code_challenge')!;
  if (resource !== `${origin}/mcp`) throw new OAuthError('invalid_target', 'The requested resource is not this MCP endpoint.');
  if (one(parameters, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new OAuthError('invalid_request', 'PKCE with a SHA-256 challenge is required.');
  }
  const descriptors = activeActionDescriptors(callbacks);
  const actions = scope(one(parameters, 'scope', false, MAX_SCOPE_ACTIONS * 97), descriptors);
  const state = one(parameters, 'state', false, 1_024);
  const client = await env.CATALOG.prepare(`SELECT id, name, redirect_uris, registered_expires_at,
    EXISTS (SELECT 1 FROM mcp_client_grants g WHERE g.client_id = mcp_oauth_clients.id) AS consented
    FROM mcp_oauth_clients WHERE id = ?`).bind(clientId).first<ClientRow>();
  if (!client || (!client.consented && client.registered_expires_at <= NOW()) || !strings(client.redirect_uris).includes(redirect)) throw new OAuthError('invalid_request', 'The client or exact registered redirect URI is invalid or expired.');
  const { principal, context } = await currentIdentity(request, callbacks);
  await cleanup(env);
  const pendingId = secret();
  const csrf = secret();
  const inserted = await env.CATALOG.prepare(`INSERT INTO mcp_oauth_pending
    (id, csrf_hash, client_id, redirect_uri, audience, state, challenge, actions, organization_id, workspace_id, actor_id, provider, subject, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM mcp_oauth_pending WHERE actor_id = ? AND consumed_at IS NULL AND expires_at > ?) < ?`)
    .bind(pendingId, await digest(csrf), clientId, redirect, resource, state, challenge, JSON.stringify(actions), context.organizationId,
      context.workspaceId, context.actor.id, principal.provider, principal.id, NOW() + 600, context.actor.id, NOW(), MAX_PENDING_PER_ACTOR).run();
  if (!inserted.success || inserted.meta?.changes !== 1) throw new OAuthError('temporarily_unavailable', 'Too many pending consent requests. Try again shortly.', 429);
  return new Response(consentHtml(client, pendingId, csrf, actions, descriptors, principal, redirect), { headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}
function authorizationRedirect(pending: PendingRow, fields: Record<string, string>): Response {
  const target = new URL(pending.redirect_uri);
  for (const name of ['code', 'error', 'error_description', 'state']) target.searchParams.delete(name);
  for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
  if (pending.state !== null) target.searchParams.set('state', pending.state);
  return new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: target.href } });
}
async function authorizePost(request: Request, env: OAuthEnv, callbacks: OAuthCallbacks, origin: string): Promise<Response> {
  requireOrigin(request, origin);
  const body = await formBody(request);
  const pendingId = one(body, 'request_id', true, 128)!;
  const csrf = one(body, 'csrf', true, 128)!;
  const decision = one(body, 'decision')!;
  if (decision !== 'approve' && decision !== 'deny') throw new OAuthError('invalid_request', 'Choose whether to allow access.');
  const { principal, context } = await currentIdentity(request, callbacks);
  const pending = await env.CATALOG.prepare('SELECT * FROM mcp_oauth_pending WHERE id = ?').bind(pendingId).first<PendingRow>();
  if (!pending || pending.consumed_at !== null || pending.expires_at <= NOW() || pending.csrf_hash !== await digest(csrf)
    || pending.provider !== principal.provider || pending.subject !== principal.id || !contextMatches(context, pending) || pending.audience !== `${origin}/mcp`) {
    throw new OAuthError('invalid_request', 'The consent request is invalid or expired.');
  }
  const actions = body.getAll('action');
  const requested = strings(pending.actions);
  if (decision === 'approve') scope(requested.join(' '), activeActionDescriptors(callbacks));
  if (decision === 'approve' && (!actions.length || new Set(actions).size !== actions.length || !actions.every(action => requested.includes(action)))) {
    throw new OAuthError('invalid_scope', 'Select at least one of the requested permissions.');
  }
  let resourceIds: string[] | null = null;
  if (decision === 'approve') {
    const selection = one(body, 'resource_scope')!;
    const enteredIds = body.getAll('resource_ids');
    if (enteredIds.length > 1 || (enteredIds[0]?.length ?? 0) > 10_000) throw new OAuthError('invalid_request', 'The file selection is invalid.');
    const ids = enteredIds[0] ?? '';
    if (selection === 'selected') {
      resourceIds = ids.split(/[\s,]+/).filter(Boolean);
      if (!resourceIds.length || resourceIds.length > 100 || new Set(resourceIds).size !== resourceIds.length || !resourceIds.every(id => UUID.test(id))) {
        throw new OAuthError('invalid_request', 'Select between 1 and 100 distinct file IDs.');
      }
    } else if (selection !== 'accessible') throw new OAuthError('invalid_request', 'Select a file access scope.');
  }
  if (decision === 'approve') {
    const count = await env.CATALOG.prepare(`SELECT COUNT(*) AS count FROM mcp_client_grants
      WHERE organization_id = ? AND workspace_id = ? AND actor_id = ? AND revoked_at IS NULL`)
      .bind(context.organizationId, context.workspaceId, context.actor.id).first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_ACTIVE_GRANTS_PER_ACTOR) throw new OAuthError('temporarily_unavailable', 'Revoke an existing client grant before adding another.', 429);
  }
  const claimed = await env.CATALOG.prepare(`UPDATE mcp_oauth_pending SET consumed_at = ?
    WHERE id = ? AND consumed_at IS NULL AND expires_at > ? RETURNING id`).bind(NOW(), pending.id, NOW()).first<{ id: string }>();
  if (!claimed) throw new OAuthError('invalid_request', 'This consent request has already been used.');
  if (decision === 'deny') return authorizationRedirect(pending, { error: 'access_denied' });
  const grantId = crypto.randomUUID();
  const created = await env.CATALOG.prepare(`INSERT INTO mcp_client_grants
    (id, client_id, organization_id, workspace_id, actor_id, provider, subject, email, display_name, audience, actions, resource_ids, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM mcp_client_grants WHERE organization_id = ? AND workspace_id = ? AND actor_id = ? AND revoked_at IS NULL) < ?`)
    .bind(grantId, pending.client_id, context.organizationId, context.workspaceId, context.actor.id, principal.provider, principal.id,
      principal.email, principal.displayName, pending.audience, JSON.stringify(actions), resourceIds === null ? null : JSON.stringify(resourceIds), NOW(),
      context.organizationId, context.workspaceId, context.actor.id, MAX_ACTIVE_GRANTS_PER_ACTOR).run();
  if (!created.success || created.meta?.changes !== 1) throw new OAuthError('temporarily_unavailable', 'The client grant could not be created.', 429);
  const code = secret();
  const inserted = await env.CATALOG.prepare(`INSERT INTO mcp_oauth_codes (code_hash, grant_id, client_id, redirect_uri, audience, challenge, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(await digest(code), grantId, pending.client_id, pending.redirect_uri, pending.audience, pending.challenge, NOW() + 300).run();
  if (!inserted.success) throw new OAuthError('temporarily_unavailable', 'The authorization code could not be created.', 503);
  return authorizationRedirect(pending, { code });
}
async function exchange(request: Request, env: OAuthEnv, callbacks: OAuthCallbacks, origin: string): Promise<Response> {
  const body = await formBody(request);
  if (one(body, 'grant_type') !== 'authorization_code') throw new OAuthError('unsupported_grant_type', 'Only authorization codes are supported.');
  const clientId = one(body, 'client_id')!;
  const redirect = one(body, 'redirect_uri')!;
  const audience = one(body, 'resource')!;
  const rawCode = one(body, 'code', true, 128)!;
  const verifier = one(body, 'code_verifier', true, 128)!;
  if (audience !== `${origin}/mcp`) throw new OAuthError('invalid_target', 'The requested resource is not this MCP endpoint.');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant', 'The authorization code or proof key is invalid.');
  const codeHash = await digest(rawCode);
  const code = await env.CATALOG.prepare('SELECT * FROM mcp_oauth_codes WHERE code_hash = ?').bind(codeHash).first<CodeRow>();
  if (!code || code.expires_at <= NOW() || code.client_id !== clientId || code.redirect_uri !== redirect || code.audience !== audience || code.challenge !== await digest(verifier)) {
    throw new OAuthError('invalid_grant', 'The authorization code or proof key is invalid.');
  }
  const grant = await env.CATALOG.prepare('SELECT * FROM mcp_client_grants WHERE id = ? AND revoked_at IS NULL').bind(code.grant_id).first<GrantRow>();
  if (!grant || grant.audience !== audience) throw new OAuthError('invalid_grant', 'The client authorization is no longer active.');
  let context: OAuthWorkspaceContext;
  try { context = await callbacks.resolveContext(principalFromGrant(grant)); requireContext(context); }
  catch { throw new OAuthError('invalid_grant', 'The client authorization is no longer active.'); }
  if (!contextMatches(context, grant)) throw new OAuthError('invalid_grant', 'The client authorization is no longer active.');
  const consumed = await env.CATALOG.prepare('DELETE FROM mcp_oauth_codes WHERE code_hash = ? AND expires_at > ? RETURNING code_hash')
    .bind(codeHash, NOW()).first<{ code_hash: string }>();
  if (!consumed) throw new OAuthError('invalid_grant', 'The authorization code has already been used.');
  const token = secret();
  const inserted = await env.CATALOG.prepare(`INSERT INTO mcp_oauth_tokens (token_hash, grant_id, grant_version, audience, created_at, expires_at)
    SELECT ?, id, version, audience, ?, ? FROM mcp_client_grants WHERE id = ? AND revoked_at IS NULL AND version = ?`)
    .bind(await digest(token), NOW(), NOW() + 3_600, grant.id, grant.version).run();
  if (!inserted.success || inserted.meta?.changes !== 1) throw new OAuthError('invalid_grant', 'The client authorization is no longer active.');
  return json({ access_token: token, token_type: 'Bearer', expires_in: 3_600, scope: strings(grant.actions).join(' ') });
}
async function grantRequest(request: Request, env: OAuthEnv, callbacks: OAuthCallbacks, origin: string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== '/api/mcp/grants' && !/^\/api\/mcp\/grants\/[^/]+\/revoke$/.test(path)) return null;
  const { context } = await currentIdentity(request, callbacks);
  if (path === '/api/mcp/grants' && request.method === 'GET') {
    const rows = await env.CATALOG.prepare(`SELECT g.id, g.client_id, c.name AS client_name, g.actions, g.resource_ids, g.created_at, g.revoked_at, g.version
      FROM mcp_client_grants g JOIN mcp_oauth_clients c ON c.id = g.client_id
      WHERE g.organization_id = ? AND g.workspace_id = ? AND g.actor_id = ?
      ORDER BY (g.revoked_at IS NOT NULL) ASC, g.created_at DESC, g.id DESC LIMIT 200`)
      .bind(context.organizationId, context.workspaceId, context.actor.id).all<Pick<GrantRow, 'id' | 'client_id' | 'actions' | 'resource_ids' | 'created_at' | 'revoked_at' | 'version'> & { client_name: string }>();
    return json({ grants: rows.results.map(row => ({ id: row.id, clientId: row.client_id, clientName: row.client_name,
      actions: strings(row.actions), resourceIds: row.resource_ids === null ? null : strings(row.resource_ids),
      createdAt: new Date(row.created_at * 1_000).toISOString(), revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at * 1_000).toISOString(), version: row.version })) });
  }
  if (path !== '/api/mcp/grants' && request.method === 'POST') {
    requireOrigin(request, origin);
    const id = path.split('/')[4];
    if (!UUID.test(id)) throw new OAuthError('invalid_request', 'The client grant was not found.', 404);
    const revoked = await env.CATALOG.prepare(`UPDATE mcp_client_grants SET revoked_at = COALESCE(revoked_at, ?),
      version = CASE WHEN revoked_at IS NULL THEN version + 1 ELSE version END
      WHERE id = ? AND organization_id = ? AND workspace_id = ? AND actor_id = ? RETURNING id`)
      .bind(NOW(), id, context.organizationId, context.workspaceId, context.actor.id).first<{ id: string }>();
    if (!revoked) throw new OAuthError('invalid_request', 'The client grant was not found.', 404);
    return json({ revoked: true, grantId: id });
  }
  return json({ error: 'method_not_allowed', error_description: 'This method is not supported.' }, 405);
}

/** Metadata and protocol routes bypass browser login; consent and grant management do not. */
export async function handleOAuthRequest(request: Request, env: OAuthEnv, callbacks: OAuthCallbacks): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const metadata = path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp';
  const known = metadata || ['/oauth/register', '/oauth/authorize', '/oauth/token'].includes(path) || path === '/api/mcp/grants' || /^\/api\/mcp\/grants\/[^/]+\/revoke$/.test(path);
  if (!known) return null;
  if (env.MCP_ENABLED === 'false') return json({ error: 'not_found' }, 404);
  try {
    const origin = publicOrigin(request, env);
    if (metadata && request.method === 'GET') {
      const actions = activeActionDescriptors(callbacks).map((descriptor) => descriptor.id);
      if (path === '/.well-known/oauth-authorization-server') return json({ issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'], scopes_supported: actions, client_id_metadata_document_supported: false });
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: actions, bearer_methods_supported: ['header'] });
    }
    if (path === '/oauth/register' && request.method === 'POST') return await register(request, env);
    if (path === '/oauth/authorize' && request.method === 'GET') return await authorizeGet(request, env, callbacks, origin);
    if (path === '/oauth/authorize' && request.method === 'POST') return await authorizePost(request, env, callbacks, origin);
    if (path === '/oauth/token' && request.method === 'POST') return await exchange(request, env, callbacks, origin);
    const grantResponse = await grantRequest(request, env, callbacks, origin);
    if (grantResponse) return grantResponse;
    return json({ error: 'method_not_allowed', error_description: 'This method is not supported.' }, 405);
  } catch (error) {
    if (error instanceof OAuthError) return json({ error: error.code, error_description: error.message }, error.status);
    throw error;
  }
}

/** The caller must re-resolve membership and authorize every actual tool target. */
export async function validateMcpToken(request: Request, env: OAuthEnv): Promise<McpAuthorization | null> {
  if (env.MCP_ENABLED === 'false') return null;
  let origin: string;
  try { origin = publicOrigin(request, env); } catch { return null; }
  const path = new URL(request.url).pathname;
  if (path !== '/mcp' && path !== '/api/mcp/connections'
    && !/^\/api\/mcp\/connections\/[0-9a-f-]+(?:\/(?:ready|close|invocations\/[0-9a-f-]+(?:\/cancel)?))?$/.test(path)) return null;
  const authorization = request.headers.get('Authorization');
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)) return null;
  const tokenHash = await digest(authorization.slice(7));
  const grant = await env.CATALOG.prepare(`SELECT g.* FROM mcp_oauth_tokens t JOIN mcp_client_grants g ON g.id = t.grant_id
    WHERE t.token_hash = ? AND t.expires_at > ? AND t.audience = ? AND g.audience = ?
    AND g.revoked_at IS NULL AND t.grant_version = g.version`).bind(tokenHash, NOW(), `${origin}/mcp`, `${origin}/mcp`).first<GrantRow>();
  if (!grant) return null;
  return authorizationFromGrant(grant);
}

/** For a signed internal assertion: the verifier must compare every claim to this current record. */
export async function getMcpGrantById(env: OAuthEnv, id: string): Promise<McpAuthorization | null> {
  if (env.MCP_ENABLED === 'false' || !UUID.test(id)) return null;
  const row = await env.CATALOG.prepare('SELECT * FROM mcp_client_grants WHERE id = ? AND revoked_at IS NULL').bind(id).first<GrantRow>();
  return row ? authorizationFromGrant(row) : null;
}
