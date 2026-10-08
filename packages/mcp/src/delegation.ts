import type { Principal } from '@open-cloud/contracts';
import { MCP_MAX_DELEGATION_BYTES, MCP_MAX_GRANT_ACTIONS, MCP_MAX_REQUEST_BYTES } from '@open-cloud/contracts';

export const DELEGATION_HEADER = 'X-Open-Cloud-Delegation';
export const LOCAL_MCP_SIGNING_KEY = 'mcp-local-development-signing-key-only-not-for-production';

export interface DelegationEnv { MCP_SIGNING_KEY?: string; AUTH_PROVIDER: 'local' | 'cloudflare-access' }
export interface DelegationClaims {
  version: 1;
  issuer: 'open-cloud-core';
  audience: string;
  issuedAt: number;
  expiresAt: number;
  requestId: string;
  requestHash: string;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  principal: Principal;
  clientId: string;
  grantId: string;
  grantVersion: number;
  actions: string[];
  resourceIds: string[] | null;
  fileId: string;
  action: string;
}

export class DelegationError extends Error {
  readonly status = 401;
  readonly code = 'invalid_delegation';
  constructor() { super('The delegated request is invalid or expired.'); }
}

const encoder = new TextEncoder();
function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new DelegationError();
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
}
function signingKey(request: Request, env: DelegationEnv): string {
  const local = env.AUTH_PROVIDER === 'local' && ['localhost', '127.0.0.1', '[::1]', 'core.internal'].includes(new URL(request.url).hostname);
  const key = env.MCP_SIGNING_KEY ?? (local ? LOCAL_MCP_SIGNING_KEY : '');
  if (key.length < 32 || (!local && key === LOCAL_MCP_SIGNING_KEY)) throw new DelegationError();
  return key;
}
/** Configuration readiness without returning any secret material. */
export function isDelegationConfigured(request: Request, env: DelegationEnv): boolean {
  try { signingKey(request, env); return true; } catch { return false; }
}
async function key(request: Request, env: DelegationEnv): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(signingKey(request, env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function delegationRequestHash(request: Request, body: string): Promise<string> {
  const input = `${request.method.toUpperCase()}\n${new URL(request.url).pathname}\n${body}`;
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input))));
}

/** An assertion is audience-bound and binds the exact request bytes, not browser credentials. */
export async function signDelegation(
  request: Request,
  env: DelegationEnv,
  input: Omit<DelegationClaims, 'version' | 'issuer' | 'issuedAt' | 'expiresAt' | 'requestHash'>,
  body: string,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: DelegationClaims = {
    ...input, version: 1, issuer: 'open-cloud-core', issuedAt, expiresAt: issuedAt + 30,
    requestHash: await delegationRequestHash(request, body),
  };
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await key(request, env), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyDelegation(
  request: Request,
  env: DelegationEnv,
  options: { audience: string; body: string; now?: number },
): Promise<DelegationClaims> {
  try {
    const token = request.headers.get(DELEGATION_HEADER);
    if (!token || token.length > MCP_MAX_DELEGATION_BYTES) throw new DelegationError();
    const segments = token.split('.');
    if (segments.length !== 2 || !await crypto.subtle.verify('HMAC', await key(request, env), decode(segments[1]), encoder.encode(segments[0]))) throw new DelegationError();
    const value: unknown = JSON.parse(new TextDecoder().decode(decode(segments[0])));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DelegationError();
    const claims = value as DelegationClaims;
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (claims.version !== 1 || claims.issuer !== 'open-cloud-core' || claims.audience !== options.audience
      || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
      || claims.issuedAt > now + 5 || claims.expiresAt <= now || claims.expiresAt - claims.issuedAt > 30
      || !claims.principal || typeof claims.principal.id !== 'string' || typeof claims.principal.provider !== 'string'
      || typeof claims.principal.email !== 'string' || typeof claims.principal.displayName !== 'string'
      || !Number.isSafeInteger(claims.grantVersion) || claims.grantVersion < 1
      || !['requestId', 'organizationId', 'workspaceId', 'actorId', 'clientId', 'grantId', 'fileId', 'action'].every((field) => typeof claims[field as keyof DelegationClaims] === 'string' && String(claims[field as keyof DelegationClaims]).length > 0)
      || !Array.isArray(claims.actions) || claims.actions.length > MCP_MAX_GRANT_ACTIONS || !claims.actions.every((action) => typeof action === 'string' && action.length <= 96)
      || !claims.actions.includes(claims.action)
      || !(claims.resourceIds === null || (Array.isArray(claims.resourceIds) && claims.resourceIds.length <= 100 && claims.resourceIds.every((id) => typeof id === 'string') && claims.resourceIds.includes(claims.fileId)))
      || claims.requestHash !== await delegationRequestHash(request, options.body)) throw new DelegationError();
    return claims;
  } catch { throw new DelegationError(); }
}

/**
 * DelegationClaimsV2 represents a cryptographically signed assertion issued by Core.
 * IMPORTANT: This assertion is NOT live authority. It conveys identity and scope binding
 * for an MCP invocation, but does not verify live membership, current policy, storage state,
 * or tool descriptor existence. Those must be enforced by downstream authorization layers.
 */
export type DelegationScopeV2 =
  | { kind: 'file'; resourceId: string }
  | { kind: 'folder'; resourceId: string }
  | { kind: 'workspace' };

export interface McpOAuthObservationV2 {
  tokenHash: string;
  expiresAt: number;
  audience: string;
}

export interface DelegationClaimsV2 {
  version: 2;
  issuer: 'open-cloud-core';
  audience: string;
  issuedAt: number;
  expiresAt: number;
  requestId: string;
  requestHash: string;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  principal: Principal;
  clientId: string;
  grantId: string;
  grantVersion: number;
  actions: string[];
  resourceIds: string[] | null;
  scope: DelegationScopeV2;
  toolName: string;
  requiredActions: string[];
  oauthObservation?: McpOAuthObservationV2;
}

export type DelegationInputV2 = Omit<DelegationClaimsV2, 'version' | 'issuer' | 'issuedAt' | 'expiresAt' | 'requestHash'>;

export interface VerifyDelegationV2Options {
  audience: string;
  body: string;
  now?: number;
  toolName?: string;
  scope?: DelegationScopeV2;
}

export const DELEGATION_V2_HMAC_PREFIX = 'open-cloud-delegation-v2\n';

const UUID_PATTERN_V2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIENCE_PATTERN_V2 = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TOOL_NAME_PATTERN_V2 = /^[a-z][a-z0-9_]{2,79}$/;
const ACTION_PATTERN_V2 = /^(?:file\.(?:read|edit|create|move|delete|share)|workspace\.manage|(?!core\.|file\.|workspace\.)[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)$/;
const V2_RESERVED_CORE_TOOLS = ['core_list_files', 'core_get_file'] as const;

function isUuidV2(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN_V2.test(value);
}

function isValidActionNameV2(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 96 && ACTION_PATTERN_V2.test(value);
}

function hasLoneSurrogateV2(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function decodeBase64UrlCanonicalV2(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new DelegationError();
  const bytes = decode(value);
  if (base64url(bytes) !== value) throw new DelegationError();
  return bytes;
}

export function validateOAuthObservationV2(value: unknown): McpOAuthObservationV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DelegationError();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new DelegationError();
  if (Object.getOwnPropertySymbols(value).length > 0) throw new DelegationError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const REQUIRED = ['tokenHash', 'expiresAt', 'audience'];
  if (keys.length !== REQUIRED.length || !REQUIRED.every(k => Object.hasOwn(descriptors, k))) {
    throw new DelegationError();
  }
  for (const k of REQUIRED) {
    const d = descriptors[k]!;
    if (!('value' in d) || !d.enumerable) throw new DelegationError();
  }
  const tokenHash = descriptors.tokenHash!.value;
  const expiresAt = descriptors.expiresAt!.value;
  const audience = descriptors.audience!.value;

  if (typeof tokenHash !== 'string' || tokenHash.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) {
    throw new DelegationError();
  }
  const decoded = decode(tokenHash);
  if (decoded.byteLength !== 32 || base64url(decoded) !== tokenHash) {
    throw new DelegationError();
  }

  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new DelegationError();
  }

  if (typeof audience !== 'string' || audience.length === 0 || audience.length > 2048
    || hasLoneSurrogateV2(audience) || /[\u0000-\u001f\u007f-\u009f]/.test(audience)) {
    throw new DelegationError();
  }

  return { tokenHash, expiresAt, audience };
}

function validateUtf8BodyV2(body: string): void {
  if (typeof body !== 'string' || hasLoneSurrogateV2(body)) throw new DelegationError();
  const bodyBytes = encoder.encode(body);
  if (bodyBytes.byteLength > MCP_MAX_REQUEST_BYTES) throw new DelegationError();
}

function parseAndValidateBodyV2(body: string, toolName: string, scope: DelegationScopeV2): Record<string, unknown> {
  validateUtf8BodyV2(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DelegationError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DelegationError();
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('tool') || !keys.includes('arguments')) throw new DelegationError();
  const b = parsed as { tool: unknown; arguments: unknown };
  if (typeof b.tool !== 'string' || b.tool !== toolName) throw new DelegationError();
  if (!b.arguments || typeof b.arguments !== 'object' || Array.isArray(b.arguments)) throw new DelegationError();
  const args = b.arguments as Record<string, unknown>;

  if (scope.kind === 'file') {
    if (args.fileId !== scope.resourceId) throw new DelegationError();
    if (Object.hasOwn(args, 'folderId')) throw new DelegationError();
  } else if (scope.kind === 'folder') {
    if (args.folderId !== scope.resourceId) throw new DelegationError();
    if (Object.hasOwn(args, 'fileId')) throw new DelegationError();
  } else if (scope.kind === 'workspace') {
    if (Object.hasOwn(args, 'fileId') || Object.hasOwn(args, 'folderId')) throw new DelegationError();
  } else {
    throw new DelegationError();
  }
  return args;
}

function validateScopeAndResourcesV2(scope: unknown, resourceIds: unknown): DelegationScopeV2 {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new DelegationError();
  const sKeys = Object.keys(scope);
  const s = scope as Record<string, unknown>;

  if (s.kind === 'workspace') {
    if (sKeys.length !== 1 || sKeys[0] !== 'kind') throw new DelegationError();
    if (resourceIds !== null) throw new DelegationError();
    return { kind: 'workspace' };
  }

  if (s.kind === 'file' || s.kind === 'folder') {
    if (sKeys.length !== 2 || !sKeys.includes('kind') || !sKeys.includes('resourceId')) throw new DelegationError();
    if (!isUuidV2(s.resourceId)) throw new DelegationError();
    const resourceId = s.resourceId;
    if (resourceIds !== null) {
      if (!Array.isArray(resourceIds) || resourceIds.length < 1 || resourceIds.length > 100) throw new DelegationError();
      if (new Set(resourceIds).size !== resourceIds.length) throw new DelegationError();
      if (!resourceIds.every(isUuidV2)) throw new DelegationError();
      if (!resourceIds.includes(resourceId)) throw new DelegationError();
    }
    return { kind: s.kind, resourceId };
  }

  throw new DelegationError();
}

function validateActionsV2(actions: unknown, requiredActions: unknown): void {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MCP_MAX_GRANT_ACTIONS) throw new DelegationError();
  if (new Set(actions).size !== actions.length) throw new DelegationError();
  if (!actions.every(isValidActionNameV2)) throw new DelegationError();

  if (!Array.isArray(requiredActions) || requiredActions.length < 1 || requiredActions.length > 8) throw new DelegationError();
  if (new Set(requiredActions).size !== requiredActions.length) throw new DelegationError();
  if (!requiredActions.every(isValidActionNameV2)) throw new DelegationError();
  if (!requiredActions.every(a => actions.includes(a))) throw new DelegationError();
}

function validatePrincipalV2(principal: unknown): Principal {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) throw new DelegationError();
  const keys = Object.keys(principal);
  const REQUIRED = ['id', 'email', 'displayName', 'provider'];
  if (keys.length !== 4 || !REQUIRED.every(k => Object.hasOwn(principal, k))) throw new DelegationError();
  const p = principal as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.length < 1 || p.id.length > 256 ||
      typeof p.provider !== 'string' || p.provider.length < 1 || p.provider.length > 128 ||
      typeof p.email !== 'string' || p.email.length < 1 || p.email.length > 256 ||
      typeof p.displayName !== 'string' || p.displayName.length < 1 || p.displayName.length > 256) {
    throw new DelegationError();
  }
  // Provider subject and internal workspace actor are distinct identities.
  return { id: p.id, email: p.email, displayName: p.displayName, provider: p.provider };
}

function validateIdentifiersV2(input: {
  audience: unknown;
  toolName: unknown;
  requestId: unknown;
  organizationId: unknown;
  workspaceId: unknown;
  actorId: unknown;
  clientId: unknown;
  grantId: unknown;
  grantVersion: unknown;
}): void {
  if (typeof input.audience !== 'string' || input.audience.length < 1 || input.audience.length > 40 || !AUDIENCE_PATTERN_V2.test(input.audience)) {
    throw new DelegationError();
  }
  if (typeof input.toolName !== 'string' || !TOOL_NAME_PATTERN_V2.test(input.toolName)) {
    throw new DelegationError();
  }
  const prefix = `${input.audience.replaceAll('-', '_')}_`;
  if (!input.toolName.startsWith(prefix) || (V2_RESERVED_CORE_TOOLS as readonly string[]).includes(input.toolName)) {
    throw new DelegationError();
  }
  if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 128 ||
      typeof input.organizationId !== 'string' || input.organizationId.length < 1 || input.organizationId.length > 128 ||
      typeof input.workspaceId !== 'string' || input.workspaceId.length < 1 || input.workspaceId.length > 128 ||
      typeof input.actorId !== 'string' || input.actorId.length < 1 || input.actorId.length > 256 ||
      typeof input.clientId !== 'string' || input.clientId.length < 1 || input.clientId.length > 128 ||
      typeof input.grantId !== 'string' || input.grantId.length < 1 || input.grantId.length > 128) {
    throw new DelegationError();
  }
  if (!Number.isSafeInteger(input.grantVersion) || Number(input.grantVersion) < 1) {
    throw new DelegationError();
  }
}

/**
 * Signs a V2 delegation token binding audience, toolName, scope, and request body.
 * Note: Pure signed cryptographic assertion; does not derive authority from oauth observation.
 */
export async function signDelegationV2(
  request: Request,
  env: DelegationEnv,
  input: DelegationInputV2,
  body: string,
): Promise<string> {
  const BASE_INPUT_KEYS = [
    'audience', 'requestId', 'organizationId', 'workspaceId', 'actorId',
    'principal', 'clientId', 'grantId', 'grantVersion', 'actions',
    'resourceIds', 'scope', 'toolName', 'requiredActions',
  ];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DelegationError();
  if (Object.getOwnPropertySymbols(input).length > 0) throw new DelegationError();

  const inDescriptors = Object.getOwnPropertyDescriptors(input);
  const inKeys = Object.keys(inDescriptors);
  const hasObservation = Object.hasOwn(inDescriptors, 'oauthObservation');

  for (const k of inKeys) {
    const d = inDescriptors[k]!;
    if (!('value' in d) || !d.enumerable) throw new DelegationError();
  }

  const expectedLength = BASE_INPUT_KEYS.length + (hasObservation ? 1 : 0);
  if (inKeys.length !== expectedLength || !BASE_INPUT_KEYS.every(k => Object.hasOwn(inDescriptors, k))) {
    throw new DelegationError();
  }

  let validatedObservation: McpOAuthObservationV2 | undefined;
  if (hasObservation) {
    validatedObservation = validateOAuthObservationV2(inDescriptors.oauthObservation!.value);
  }

  // Snapshot input before awaits so caller mutation cannot make malformed output
  const snap = structuredClone(input);

  // Validate own body and runtime input
  validateIdentifiersV2(snap);
  validatePrincipalV2(snap.principal);
  validateActionsV2(snap.actions, snap.requiredActions);
  validateScopeAndResourcesV2(snap.scope, snap.resourceIds);
  parseAndValidateBodyV2(body, snap.toolName, snap.scope);

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 30;
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || !Number.isSafeInteger(expiresAt)) throw new DelegationError();

  const requestHash = await delegationRequestHash(request, body);
  const cryptoKey = await key(request, env);

  const claims: DelegationClaimsV2 = {
    version: 2,
    issuer: 'open-cloud-core',
    audience: snap.audience,
    issuedAt,
    expiresAt,
    requestId: snap.requestId,
    requestHash,
    organizationId: snap.organizationId,
    workspaceId: snap.workspaceId,
    actorId: snap.actorId,
    principal: snap.principal,
    clientId: snap.clientId,
    grantId: snap.grantId,
    grantVersion: snap.grantVersion,
    actions: snap.actions,
    resourceIds: snap.resourceIds,
    scope: snap.scope,
    toolName: snap.toolName,
    requiredActions: snap.requiredActions,
    ...(validatedObservation !== undefined ? { oauthObservation: validatedObservation } : {}),
  };

  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(DELEGATION_V2_HMAC_PREFIX + payload),
  );
  const token = `${payload}.${base64url(new Uint8Array(signatureBytes))}`;

  if (token.length > MCP_MAX_DELEGATION_BYTES) throw new DelegationError();

  // Verify freshness after all awaits
  const nowAfter = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(nowAfter) || nowAfter >= expiresAt || nowAfter < issuedAt) throw new DelegationError();

  return token;
}

/**
 * Verifies a V2 delegation token against the incoming request and body.
 * Note: Pure signed cryptographic assertion; does not verify live authority or policy.
 */
export async function verifyDelegationV2(
  request: Request,
  env: DelegationEnv,
  options: VerifyDelegationV2Options,
): Promise<DelegationClaimsV2> {
  const realStart = Date.now();
  try {
    if (!options || typeof options !== 'object' || typeof options.audience !== 'string' || typeof options.body !== 'string') {
      throw new DelegationError();
    }
    if (options.now !== undefined && (!Number.isSafeInteger(options.now) || options.now <= 0)) throw new DelegationError();
    validateUtf8BodyV2(options.body);
    const referenceNow = options.now;
    const token = request.headers.get(DELEGATION_HEADER);
    if (!token || token.length > MCP_MAX_DELEGATION_BYTES) throw new DelegationError();
    if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(token)) throw new DelegationError();

    const segments = token.split('.');
    if (segments.length !== 2) throw new DelegationError();

    const payloadBytes = decodeBase64UrlCanonicalV2(segments[0]);
    const sigBytes = decodeBase64UrlCanonicalV2(segments[1]);
    if (sigBytes.byteLength !== 32) throw new DelegationError();

    const cryptoKey = await key(request, env);
    const valid = await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      sigBytes,
      encoder.encode(DELEGATION_V2_HMAC_PREFIX + segments[0]),
    );
    if (!valid) throw new DelegationError();

    let jsonStr: string;
    try {
      jsonStr = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    } catch {
      throw new DelegationError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new DelegationError();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DelegationError();

    const BASE_CLAIM_KEYS_V2 = [
      'version', 'issuer', 'audience', 'issuedAt', 'expiresAt',
      'requestId', 'requestHash', 'organizationId', 'workspaceId', 'actorId',
      'principal', 'clientId', 'grantId', 'grantVersion', 'actions',
      'resourceIds', 'scope', 'toolName', 'requiredActions',
    ];
    const rawKeys = Object.keys(parsed);
    const hasObservation = Object.hasOwn(parsed, 'oauthObservation');
    const expectedClaimCount = BASE_CLAIM_KEYS_V2.length + (hasObservation ? 1 : 0);
    if (rawKeys.length !== expectedClaimCount || !BASE_CLAIM_KEYS_V2.every(k => Object.hasOwn(parsed, k))) {
      throw new DelegationError();
    }

    if (hasObservation) {
      validateOAuthObservationV2((parsed as Record<string, unknown>).oauthObservation);
    }

    const claims = parsed as DelegationClaimsV2;

    if (claims.version !== 2 || claims.issuer !== 'open-cloud-core') throw new DelegationError();
    if (claims.audience !== options.audience) throw new DelegationError();

    // Read the clock after every awaited cryptographic operation, including the final hash.
    const assertFresh = () => {
      const currentMilliseconds = Date.now();
      const now = referenceNow === undefined ? Math.floor(currentMilliseconds / 1000)
        : referenceNow + Math.max(0, Math.floor((currentMilliseconds - realStart) / 1000));
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt <= 0
        || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= claims.issuedAt
        || claims.expiresAt - claims.issuedAt > 30 || claims.issuedAt > now + 5 || claims.expiresAt <= now) {
        throw new DelegationError();
      }
    };
    assertFresh();

    validateIdentifiersV2(claims);
    validatePrincipalV2(claims.principal);
    validateActionsV2(claims.actions, claims.requiredActions);
    validateScopeAndResourcesV2(claims.scope, claims.resourceIds);

    // Optional caller trusted descriptor exact binding expectations
    if (options.toolName !== undefined && claims.toolName !== options.toolName) {
      throw new DelegationError();
    }
    if (options.scope !== undefined) {
      validateScopeAndResourcesV2(options.scope, null);
      if (options.scope.kind !== claims.scope.kind) throw new DelegationError();
      if ((options.scope.kind === 'file' || options.scope.kind === 'folder') &&
          options.scope.resourceId !== (claims.scope as { resourceId: string }).resourceId) {
        throw new DelegationError();
      }
    }

    // Verify request hash
    const expectedHash = await delegationRequestHash(request, options.body);
    if (claims.requestHash !== expectedHash) throw new DelegationError();

    // Verify body structure and scope anchor binding
    parseAndValidateBodyV2(options.body, claims.toolName, claims.scope);
    assertFresh();

    return claims;
  } catch (err) {
    if (err instanceof DelegationError) throw err;
    throw new DelegationError();
  }
}

