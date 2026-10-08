import { isResourceOperationId } from '@open-cloud/contracts';

export const NATIVE_SEED_ADMISSION_HEADER = 'X-Open-Cloud-Native-Seed-Admission';
export const NATIVE_SEED_ADMISSION_METHOD = 'POST';
export const NATIVE_SEED_ADMISSION_PATH = '/internal/native-seed-admission';
export const NATIVE_SEED_ADMISSION_TYP = 'enough-native-seed-admission+jwt';
export const NATIVE_SEED_ADMISSION_ALG = 'ES256';
export const NATIVE_SEED_ADMISSION_ISS = 'open-cloud-core';
export const NATIVE_SEED_ADMISSION_PURPOSE = 'native-seed-admission';
export const NATIVE_SEED_ADMISSION_LIFETIME_SECONDS = 30;
export const NATIVE_SEED_ADMISSION_FUTURE_SKEW_SECONDS = 5;

export const NATIVE_SEED_ADMISSION_LIMITS = {
  maxSeedBytes: 16 * 1024, // 16384 bytes
  maxContextBytes: 4096,
  maxPayloadBytes: 6144,
  maxAssertionBytes: 8192,
  maxRawBodyBytes: 114688, // 112 KiB
  maxRingBytes: 16384,
  maxConfigBytes: 4096,
  maxPublicKeys: 4,
} as const;

export type NativeSeedAdmissionErrorCode =
  | 'invalid_request'
  | 'invalid_assertion'
  | 'invalid_claims'
  | 'invalid_envelope'
  | 'invalid_context'
  | 'invalid_signature'
  | 'invalid_key'
  | 'invalid_configuration'
  | 'configuration_unavailable'
  | 'token_expired';

export class NativeSeedAdmissionError extends Error {
  readonly status: number;
  readonly code: NativeSeedAdmissionErrorCode;

  constructor(code: NativeSeedAdmissionErrorCode, message = `Native seed admission failed: ${code}`) {
    super(`Native seed admission failed: ${code}`);
    this.name = 'NativeSeedAdmissionError';
    this.code = code;
    this.status = (code === 'configuration_unavailable' || code === 'invalid_configuration') ? 503 : 401;
  }
}

export type NativeSeedAdmissionMode = 'create-native' | 'native-upload' | 'replace-unenrolled';
export type NativeSeedAdmissionAction = 'file.create' | 'file.edit';

export interface NativeSeedAdmissionOperation {
  operationId: string;
  attemptId: string;
  requestHash: string;
}

export interface NativeSeedAdmissionEnvelope {
  version: 1;
  invocationId: string;
  contextHash: string;
  expiresAt: number;
  mode: NativeSeedAdmissionMode;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  principalBindingHash: string;
  resourceId: string;
  parentId: string | null;
  action: NativeSeedAdmissionAction;
  requestHash: string;
  operation?: NativeSeedAdmissionOperation;
  ownerAppId: string;
  installationFingerprint: string;
  mimeType: string;
  schemaId: string;
  schemaVersion: number;
  admissionRevision: number;
  admissionGeneration: number;
  provenanceContextId: string;
  content: string;
  contentHash: string;
  contentBytes: number;
}

export interface NativeSeedAdmissionClaims {
  version: 1;
  purpose: 'native-seed-admission';
  iss: 'open-cloud-core';
  aud: string;
  installationId: string;
  kidGeneration: number;
  iat: number;
  exp: number;
  invocationId: string;
  requestHash: string;
  contextHash: string;
  contentHash: string;
  contentBytes: number;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  principalBindingHash: string;
  resourceId: string;
  parentId: string | null;
  mode: NativeSeedAdmissionMode;
  action: NativeSeedAdmissionAction;
  ownerAppId: string;
  installationFingerprint: string;
  admissionRevision: number;
  admissionGeneration: number;
  provenanceContextId: string;
  operation?: NativeSeedAdmissionOperation;
}

export interface NativeSeedAdmissionInstallationContext {
  version: 1;
  installationId: string;
  organizationId: string;
  workspaceId: string;
  ownerAppId: string;
  installationFingerprint: string;
  schemaId: string;
  schemaVersion: number;
  mimeTypes: string[];
  admissionRevision: number;
  admissionGeneration: number;
}

export interface NativeSeedAdmissionPublicKeyJwk {
  kid: string;
  generation: number;
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg: 'ES256';
  use: 'sig';
}

export interface NativeSeedAdmissionPublicRing {
  version: 1;
  keys: NativeSeedAdmissionPublicKeyJwk[];
}

export interface NativeSeedAdmissionPrivateKeyJwk {
  kid: string;
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
  alg: 'ES256';
  use: 'sig';
}

export interface NativeSeedAdmissionProtectedHeader {
  alg: 'ES256';
  typ: 'enough-native-seed-admission+jwt';
  kid: string;
}

// Regex definitions
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWERCASE_HEX_64_REGEX = /^[0-9a-f]{64}$/;
const ACTOR_ID_REGEX = /^actor_[0-9a-f]{64}$/;
const KID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;
const ATTEMPT_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const INSTALLATION_ID_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OWNER_APP_ID_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NATIVE_MIME_REGEX = /^application\/vnd\.[a-z0-9][a-z0-9.+_-]*\+json$/;
const SCHEMA_ID_REGEX = /^[a-z][a-z0-9.-]{2,99}$/;
const SCOPE_ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const BASE64URL_32_BYTES_REGEX = /^[A-Za-z0-9_-]{43}$/; // 32 bytes encoded without padding is ceil(32*8/6) = 43 chars

export function failAdmission(code: NativeSeedAdmissionErrorCode, message?: string): never {
  throw new NativeSeedAdmissionError(code, message);
}

export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function checkOwnPlainData(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  code: NativeSeedAdmissionErrorCode,
): Record<string, unknown> {
  if (!isPlainObject(value)) failAdmission(code);
  if (Object.getOwnPropertySymbols(value).length > 0) failAdmission(code);

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out: Record<string, unknown> = Object.create(null);

  for (const key of Object.keys(descriptors)) {
    const d = descriptors[key]!;
    if (!allowed.includes(key) || !('value' in d) || !d.enumerable) {
      failAdmission(code);
    }
    out[key] = d.value;
  }

  for (const req of required) {
    if (!(req in out) || out[req] === undefined) {
      failAdmission(code);
    }
  }

  return out;
}

export function isPrintableAscii(s: string, min = 1, max = 128): boolean {
  if (s.length < min || s.length > max) return false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function isSafePositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

export function isNonNegativeSafeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

export function isHyphenatedUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

export function isLowerHex64(s: unknown): s is string {
  return typeof s === 'string' && LOWERCASE_HEX_64_REGEX.test(s);
}

export function parseStrictCompactJson<T = unknown>(
  bytes: Uint8Array,
  maxBytes: number,
  code: NativeSeedAdmissionErrorCode,
): { parsed: T; text: string } {
  if (bytes.byteLength > maxBytes) {
    failAdmission(code);
  }

  // Fatal UTF-8 decoding
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    failAdmission(code);
  }

  // Check UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    failAdmission(code);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failAdmission(code);
  }

  // Exact JSON.stringify canonical compact equality rejects duplicates, whitespace, alternate formats
  if (JSON.stringify(parsed) !== text) {
    failAdmission(code);
  }

  return { parsed: parsed as T, text };
}

export async function computeSha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeCallbackRequestHash(rawBody: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode('NS02-CALLBACK-v1\nPOST\n/internal/native-seed-admission\n');
  const combined = new Uint8Array(prefix.length + rawBody.length);
  combined.set(prefix, 0);
  combined.set(rawBody, prefix.length);
  return computeSha256Hex(combined);
}

export function buildOrderedContextObject(envelope: {
  version: 1;
  invocationId: string;
  expiresAt: number;
  mode: NativeSeedAdmissionMode;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  principalBindingHash: string;
  resourceId: string;
  parentId: string | null;
  action: NativeSeedAdmissionAction;
  requestHash: string;
  operation?: NativeSeedAdmissionOperation;
  ownerAppId: string;
  installationFingerprint: string;
  mimeType: string;
  schemaId: string;
  schemaVersion: number;
  admissionRevision: number;
  admissionGeneration: number;
  provenanceContextId: string;
  contentHash: string;
  contentBytes: number;
}): Record<string, unknown> {
  // Fixed order of 23 fields (or 22 if operation is omitted)
  const ctx: Record<string, unknown> = {
    version: envelope.version,
    invocationId: envelope.invocationId,
    expiresAt: envelope.expiresAt,
    mode: envelope.mode,
    organizationId: envelope.organizationId,
    workspaceId: envelope.workspaceId,
    actorId: envelope.actorId,
    principalBindingHash: envelope.principalBindingHash,
    resourceId: envelope.resourceId,
    parentId: envelope.parentId,
    action: envelope.action,
    requestHash: envelope.requestHash,
  };

  if (envelope.operation !== undefined) {
    ctx.operation = {
      operationId: envelope.operation.operationId,
      attemptId: envelope.operation.attemptId,
      requestHash: envelope.operation.requestHash,
    };
  }

  ctx.ownerAppId = envelope.ownerAppId;
  ctx.installationFingerprint = envelope.installationFingerprint;
  ctx.mimeType = envelope.mimeType;
  ctx.schemaId = envelope.schemaId;
  ctx.schemaVersion = envelope.schemaVersion;
  ctx.admissionRevision = envelope.admissionRevision;
  ctx.admissionGeneration = envelope.admissionGeneration;
  ctx.provenanceContextId = envelope.provenanceContextId;
  ctx.contentHash = envelope.contentHash;
  ctx.contentBytes = envelope.contentBytes;

  return ctx;
}

export async function computeOrderedContextHash(envelope: {
  version: 1;
  invocationId: string;
  expiresAt: number;
  mode: NativeSeedAdmissionMode;
  organizationId: string;
  workspaceId: string;
  actorId: string;
  principalBindingHash: string;
  resourceId: string;
  parentId: string | null;
  action: NativeSeedAdmissionAction;
  requestHash: string;
  operation?: NativeSeedAdmissionOperation;
  ownerAppId: string;
  installationFingerprint: string;
  mimeType: string;
  schemaId: string;
  schemaVersion: number;
  admissionRevision: number;
  admissionGeneration: number;
  provenanceContextId: string;
  contentHash: string;
  contentBytes: number;
}): Promise<{ contextHash: string; contextBytes: Uint8Array }> {
  const ctxObj = buildOrderedContextObject(envelope);
  const jsonStr = JSON.stringify(ctxObj);
  const bytes = new TextEncoder().encode(jsonStr);
  if (bytes.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxContextBytes) {
    failAdmission('invalid_context');
  }
  const hash = await computeSha256Hex(bytes);
  return { contextHash: hash, contextBytes: bytes };
}

export function parseStrictEnvelope(parsed: unknown): NativeSeedAdmissionEnvelope {
  const allowed = [
    'version', 'invocationId', 'contextHash', 'expiresAt', 'mode',
    'organizationId', 'workspaceId', 'actorId', 'principalBindingHash',
    'resourceId', 'parentId', 'action', 'requestHash', 'operation',
    'ownerAppId', 'installationFingerprint', 'mimeType', 'schemaId',
    'schemaVersion', 'admissionRevision', 'admissionGeneration',
    'provenanceContextId', 'content', 'contentHash', 'contentBytes',
  ];
  const required = allowed.filter((k) => k !== 'operation');

  const r = checkOwnPlainData(parsed, allowed, required, 'invalid_envelope');

  if (r.version !== 1) failAdmission('invalid_envelope');
  if (!isHyphenatedUuid(r.invocationId)) failAdmission('invalid_envelope');
  if (!isLowerHex64(r.contextHash)) failAdmission('invalid_envelope');
  if (!isSafePositiveInt(r.expiresAt)) failAdmission('invalid_envelope');

  if (r.mode !== 'create-native' && r.mode !== 'native-upload' && r.mode !== 'replace-unenrolled') {
    failAdmission('invalid_envelope');
  }

  if (typeof r.organizationId !== 'string' || !SCOPE_ID_REGEX.test(r.organizationId)) failAdmission('invalid_envelope');
  if (typeof r.workspaceId !== 'string' || !SCOPE_ID_REGEX.test(r.workspaceId)) failAdmission('invalid_envelope');

  if (typeof r.actorId !== 'string' || !ACTOR_ID_REGEX.test(r.actorId)) failAdmission('invalid_envelope');
  if (typeof r.principalBindingHash !== 'string' || !isLowerHex64(r.principalBindingHash)) failAdmission('invalid_envelope');
  if (r.actorId !== `actor_${r.principalBindingHash}`) failAdmission('invalid_envelope');

  // Resource / parent ID check
  if (!isHyphenatedUuid(r.resourceId)) failAdmission('invalid_envelope');
  if (r.parentId !== null && !isHyphenatedUuid(r.parentId)) failAdmission('invalid_envelope');

  // Action check
  if (r.action !== 'file.create' && r.action !== 'file.edit') failAdmission('invalid_envelope');
  if (r.mode === 'replace-unenrolled') {
    if (r.action !== 'file.edit') failAdmission('invalid_envelope');
  } else {
    if (r.action !== 'file.create') failAdmission('invalid_envelope');
  }

  // requestHash check
  if (typeof r.requestHash !== 'string' || !isLowerHex64(r.requestHash)) failAdmission('invalid_envelope');

  // Operation check
  let op: NativeSeedAdmissionOperation | undefined;
  if ('operation' in r) {
    const opRaw = checkOwnPlainData(
      r.operation,
      ['operationId', 'attemptId', 'requestHash'],
      ['operationId', 'attemptId', 'requestHash'],
      'invalid_envelope',
    );
    if (!isResourceOperationId(opRaw.operationId)) failAdmission('invalid_envelope');
    if (typeof opRaw.attemptId !== 'string' || !ATTEMPT_ID_REGEX.test(opRaw.attemptId)) failAdmission('invalid_envelope');
    if (typeof opRaw.requestHash !== 'string' || !isLowerHex64(opRaw.requestHash)) failAdmission('invalid_envelope');
    if (opRaw.requestHash !== r.requestHash) failAdmission('invalid_envelope');

    op = {
      operationId: opRaw.operationId,
      attemptId: opRaw.attemptId,
      requestHash: opRaw.requestHash,
    };
  }

  // ownerAppId
  if (typeof r.ownerAppId !== 'string' || !OWNER_APP_ID_REGEX.test(r.ownerAppId)) failAdmission('invalid_envelope');

  // installationFingerprint
  if (typeof r.installationFingerprint !== 'string' || !isLowerHex64(r.installationFingerprint)) failAdmission('invalid_envelope');

  // mimeType
  if (typeof r.mimeType !== 'string' || !NATIVE_MIME_REGEX.test(r.mimeType)) failAdmission('invalid_envelope');

  // schemaId & schemaVersion
  if (typeof r.schemaId !== 'string' || !SCHEMA_ID_REGEX.test(r.schemaId)) failAdmission('invalid_envelope');
  if (!isSafePositiveInt(r.schemaVersion)) failAdmission('invalid_envelope');

  // admissionRevision & admissionGeneration
  if (!isSafePositiveInt(r.admissionRevision)) failAdmission('invalid_envelope');
  if (!isSafePositiveInt(r.admissionGeneration)) failAdmission('invalid_envelope');

  // provenanceContextId
  if (!isHyphenatedUuid(r.provenanceContextId)) failAdmission('invalid_envelope');

  // content
  if (typeof r.content !== 'string' || hasLoneSurrogate(r.content)) failAdmission('invalid_envelope');
  const contentBytesArr = new TextEncoder().encode(r.content);
  if (contentBytesArr.byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxSeedBytes) failAdmission('invalid_envelope');

  // contentHash & contentBytes
  if (typeof r.contentHash !== 'string' || !isLowerHex64(r.contentHash)) failAdmission('invalid_envelope');
  if (!isNonNegativeSafeInt(r.contentBytes) || r.contentBytes > NATIVE_SEED_ADMISSION_LIMITS.maxSeedBytes) failAdmission('invalid_envelope');
  if (r.contentBytes !== contentBytesArr.byteLength) failAdmission('invalid_envelope');

  const out: NativeSeedAdmissionEnvelope = {
    version: 1,
    invocationId: r.invocationId as string,
    contextHash: r.contextHash as string,
    expiresAt: r.expiresAt as number,
    mode: r.mode as NativeSeedAdmissionMode,
    organizationId: r.organizationId as string,
    workspaceId: r.workspaceId as string,
    actorId: r.actorId as string,
    principalBindingHash: r.principalBindingHash as string,
    resourceId: r.resourceId as string,
    parentId: r.parentId as string | null,
    action: r.action as NativeSeedAdmissionAction,
    requestHash: r.requestHash as string,
    ownerAppId: r.ownerAppId as string,
    installationFingerprint: r.installationFingerprint as string,
    mimeType: r.mimeType as string,
    schemaId: r.schemaId as string,
    schemaVersion: r.schemaVersion as number,
    admissionRevision: r.admissionRevision as number,
    admissionGeneration: r.admissionGeneration as number,
    provenanceContextId: r.provenanceContextId as string,
    content: r.content as string,
    contentHash: r.contentHash as string,
    contentBytes: r.contentBytes as number,
  };

  if (op !== undefined) {
    out.operation = op;
  }

  return out;
}

export function parseStrictClaims(parsed: unknown): NativeSeedAdmissionClaims {
  const allowed = [
    'version', 'purpose', 'iss', 'aud', 'installationId', 'kidGeneration',
    'iat', 'exp', 'invocationId', 'requestHash', 'contextHash', 'contentHash',
    'contentBytes', 'organizationId', 'workspaceId', 'actorId', 'principalBindingHash',
    'resourceId', 'parentId', 'mode', 'action', 'ownerAppId',
    'installationFingerprint', 'admissionRevision', 'admissionGeneration',
    'provenanceContextId', 'operation',
  ];
  const required = allowed.filter((k) => k !== 'operation');

  const r = checkOwnPlainData(parsed, allowed, required, 'invalid_claims');

  if (r.version !== 1) failAdmission('invalid_claims');
  if (r.purpose !== NATIVE_SEED_ADMISSION_PURPOSE) failAdmission('invalid_claims');
  if (r.iss !== NATIVE_SEED_ADMISSION_ISS) failAdmission('invalid_claims');
  if (typeof r.aud !== 'string' || !isPrintableAscii(r.aud, 1, 256)) failAdmission('invalid_claims');
  if (typeof r.installationId !== 'string' || (!INSTALLATION_ID_REGEX.test(r.installationId) || r.installationId.length > 20)) failAdmission('invalid_claims');
  if (!isSafePositiveInt(r.kidGeneration)) failAdmission('invalid_claims');

  if (!isSafePositiveInt(r.iat)) failAdmission('invalid_claims');
  if (!isSafePositiveInt(r.exp)) failAdmission('invalid_claims');
  if (r.exp !== (r.iat as number) + NATIVE_SEED_ADMISSION_LIFETIME_SECONDS) failAdmission('invalid_claims');

  if (!isHyphenatedUuid(r.invocationId)) failAdmission('invalid_claims');
  if (typeof r.requestHash !== 'string' || !isLowerHex64(r.requestHash)) failAdmission('invalid_claims');
  if (typeof r.contextHash !== 'string' || !isLowerHex64(r.contextHash)) failAdmission('invalid_claims');
  if (typeof r.contentHash !== 'string' || !isLowerHex64(r.contentHash)) failAdmission('invalid_claims');
  if (!isNonNegativeSafeInt(r.contentBytes) || r.contentBytes > NATIVE_SEED_ADMISSION_LIMITS.maxSeedBytes) failAdmission('invalid_claims');

  if (typeof r.organizationId !== 'string' || !SCOPE_ID_REGEX.test(r.organizationId)) failAdmission('invalid_claims');
  if (typeof r.workspaceId !== 'string' || !SCOPE_ID_REGEX.test(r.workspaceId)) failAdmission('invalid_claims');

  if (typeof r.actorId !== 'string' || !ACTOR_ID_REGEX.test(r.actorId)) failAdmission('invalid_claims');
  if (typeof r.principalBindingHash !== 'string' || !isLowerHex64(r.principalBindingHash)) failAdmission('invalid_claims');
  if (r.actorId !== `actor_${r.principalBindingHash}`) failAdmission('invalid_claims');

  if (!isHyphenatedUuid(r.resourceId)) failAdmission('invalid_claims');
  if (r.parentId !== null && !isHyphenatedUuid(r.parentId)) failAdmission('invalid_claims');

  if (r.mode !== 'create-native' && r.mode !== 'native-upload' && r.mode !== 'replace-unenrolled') {
    failAdmission('invalid_claims');
  }

  if (r.action !== 'file.create' && r.action !== 'file.edit') failAdmission('invalid_claims');
  if (r.mode === 'replace-unenrolled') {
    if (r.action !== 'file.edit') failAdmission('invalid_claims');
  } else {
    if (r.action !== 'file.create') failAdmission('invalid_claims');
  }

  if (typeof r.ownerAppId !== 'string' || !OWNER_APP_ID_REGEX.test(r.ownerAppId)) failAdmission('invalid_claims');
  if (typeof r.installationFingerprint !== 'string' || !isLowerHex64(r.installationFingerprint)) failAdmission('invalid_claims');

  if (!isSafePositiveInt(r.admissionRevision)) failAdmission('invalid_claims');
  if (!isSafePositiveInt(r.admissionGeneration)) failAdmission('invalid_claims');
  if (!isHyphenatedUuid(r.provenanceContextId)) failAdmission('invalid_claims');

  let op: NativeSeedAdmissionOperation | undefined;
  if ('operation' in r) {
    const opRaw = checkOwnPlainData(
      r.operation,
      ['operationId', 'attemptId', 'requestHash'],
      ['operationId', 'attemptId', 'requestHash'],
      'invalid_claims',
    );
    if (!isResourceOperationId(opRaw.operationId)) failAdmission('invalid_claims');
    if (typeof opRaw.attemptId !== 'string' || !ATTEMPT_ID_REGEX.test(opRaw.attemptId)) failAdmission('invalid_claims');
    if (typeof opRaw.requestHash !== 'string' || !isLowerHex64(opRaw.requestHash)) failAdmission('invalid_claims');

    op = {
      operationId: opRaw.operationId,
      attemptId: opRaw.attemptId,
      requestHash: opRaw.requestHash,
    };
  }

  const out: NativeSeedAdmissionClaims = {
    version: 1,
    purpose: 'native-seed-admission',
    iss: 'open-cloud-core',
    aud: r.aud as string,
    installationId: r.installationId as string,
    kidGeneration: r.kidGeneration as number,
    iat: r.iat as number,
    exp: r.exp as number,
    invocationId: r.invocationId as string,
    requestHash: r.requestHash as string,
    contextHash: r.contextHash as string,
    contentHash: r.contentHash as string,
    contentBytes: r.contentBytes as number,
    organizationId: r.organizationId as string,
    workspaceId: r.workspaceId as string,
    actorId: r.actorId as string,
    principalBindingHash: r.principalBindingHash as string,
    resourceId: r.resourceId as string,
    parentId: r.parentId as string | null,
    mode: r.mode as NativeSeedAdmissionMode,
    action: r.action as NativeSeedAdmissionAction,
    ownerAppId: r.ownerAppId as string,
    installationFingerprint: r.installationFingerprint as string,
    admissionRevision: r.admissionRevision as number,
    admissionGeneration: r.admissionGeneration as number,
    provenanceContextId: r.provenanceContextId as string,
  };

  if (op !== undefined) {
    out.operation = op;
  }

  return out;
}

export function parseStrictInstallationContext(
  parsed: unknown,
  code: NativeSeedAdmissionErrorCode = 'invalid_configuration',
): NativeSeedAdmissionInstallationContext {
  const allowed = [
    'version', 'installationId', 'organizationId', 'workspaceId',
    'ownerAppId', 'installationFingerprint', 'schemaId', 'schemaVersion',
    'mimeTypes', 'admissionRevision', 'admissionGeneration',
  ];
  const r = checkOwnPlainData(parsed, allowed, allowed, code);

  if (r.version !== 1) failAdmission(code);
  if (typeof r.installationId !== 'string' || (!INSTALLATION_ID_REGEX.test(r.installationId) || r.installationId.length > 20)) failAdmission(code);
  if (typeof r.organizationId !== 'string' || !SCOPE_ID_REGEX.test(r.organizationId)) failAdmission(code);
  if (typeof r.workspaceId !== 'string' || !SCOPE_ID_REGEX.test(r.workspaceId)) failAdmission(code);
  if (typeof r.ownerAppId !== 'string' || !OWNER_APP_ID_REGEX.test(r.ownerAppId)) failAdmission(code);
  if (typeof r.installationFingerprint !== 'string' || !isLowerHex64(r.installationFingerprint)) failAdmission(code);
  if (typeof r.schemaId !== 'string' || !SCHEMA_ID_REGEX.test(r.schemaId)) failAdmission(code);
  if (!isSafePositiveInt(r.schemaVersion)) failAdmission(code);
  if (!isSafePositiveInt(r.admissionRevision)) failAdmission(code);
  if (!isSafePositiveInt(r.admissionGeneration)) failAdmission(code);

  if (!Array.isArray(r.mimeTypes) || Object.getPrototypeOf(r.mimeTypes) !== Array.prototype) {
    failAdmission(code);
  }
  if (r.mimeTypes.length < 1 || r.mimeTypes.length > 16) failAdmission(code);

  checkStrictArray(r.mimeTypes, code);
  const seenMimes = new Set<string>();
  for (let i = 0; i < r.mimeTypes.length; i++) {
    const d = Object.getOwnPropertyDescriptor(r.mimeTypes, String(i));
    if (!d || !('value' in d)) failAdmission(code);
    const m = d.value;
    if (typeof m !== 'string' || !NATIVE_MIME_REGEX.test(m)) failAdmission(code);
    if (seenMimes.has(m)) failAdmission(code);
    seenMimes.add(m);
  }

  const result: NativeSeedAdmissionInstallationContext = {
    version: 1,
    installationId: r.installationId as string,
    organizationId: r.organizationId as string,
    workspaceId: r.workspaceId as string,
    ownerAppId: r.ownerAppId as string,
    installationFingerprint: r.installationFingerprint as string,
    schemaId: r.schemaId as string,
    schemaVersion: r.schemaVersion as number,
    mimeTypes: Array.from(seenMimes),
    admissionRevision: r.admissionRevision as number,
    admissionGeneration: r.admissionGeneration as number,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > NATIVE_SEED_ADMISSION_LIMITS.maxConfigBytes) failAdmission(code);
  return result;
}

export function parseStrictPublicRing(
  parsed: unknown,
  code: NativeSeedAdmissionErrorCode = 'invalid_key',
): NativeSeedAdmissionPublicRing {
  const r = checkOwnPlainData(parsed, ['version', 'keys'], ['version', 'keys'], code);
  if (r.version !== 1) failAdmission(code);
  if (!Array.isArray(r.keys) || Object.getPrototypeOf(r.keys) !== Array.prototype) failAdmission(code);
  if (r.keys.length < 1 || r.keys.length > NATIVE_SEED_ADMISSION_LIMITS.maxPublicKeys) failAdmission(code);

  checkStrictArray(r.keys, code);
  const seenKids = new Set<string>();
  const outKeys: NativeSeedAdmissionPublicKeyJwk[] = [];

  for (let i = 0; i < r.keys.length; i++) {
    const desc = Object.getOwnPropertyDescriptor(r.keys, String(i));
    if (!desc || !('value' in desc)) failAdmission(code);
    const rawKey = desc.value;

    const allowed = ['kid', 'generation', 'kty', 'crv', 'x', 'y', 'alg', 'use'];
    const k = checkOwnPlainData(rawKey, allowed, allowed, code);

    if (typeof k.kid !== 'string' || !KID_REGEX.test(k.kid)) failAdmission(code);
    if (seenKids.has(k.kid)) failAdmission(code);
    seenKids.add(k.kid);

    if (!isSafePositiveInt(k.generation)) failAdmission(code);

    if (k.kty !== 'EC' || k.crv !== 'P-256' || k.alg !== 'ES256' || k.use !== 'sig') failAdmission(code);
    if (typeof k.x !== 'string') failAdmission(code);
    decodeCanonicalBase64Url(k.x, code, 32);
    if (typeof k.y !== 'string') failAdmission(code);
    decodeCanonicalBase64Url(k.y, code, 32);

    outKeys.push({
      kid: k.kid as string,
      generation: k.generation as number,
      kty: 'EC',
      crv: 'P-256',
      x: k.x as string,
      y: k.y as string,
      alg: 'ES256',
      use: 'sig',
    });
  }

  return { version: 1, keys: outKeys };
}

export function parseStrictPrivateKeyJwk(
  parsed: unknown,
  code: NativeSeedAdmissionErrorCode = 'invalid_key',
): NativeSeedAdmissionPrivateKeyJwk {
  const allowed = ['kid', 'kty', 'crv', 'x', 'y', 'd', 'alg', 'use'];
  const k = checkOwnPlainData(parsed, allowed, allowed, code);

  if (typeof k.kid !== 'string' || !KID_REGEX.test(k.kid)) failAdmission(code);
  if (k.kty !== 'EC' || k.crv !== 'P-256' || k.alg !== 'ES256' || k.use !== 'sig') failAdmission(code);
  if (typeof k.x !== 'string') failAdmission(code);
    decodeCanonicalBase64Url(k.x, code, 32);
  if (typeof k.y !== 'string') failAdmission(code);
    decodeCanonicalBase64Url(k.y, code, 32);
  if (typeof k.d !== 'string') failAdmission(code);
  decodeCanonicalBase64Url(k.d, code, 32);

  return {
    kid: k.kid as string,
    kty: 'EC',
    crv: 'P-256',
    x: k.x as string,
    y: k.y as string,
    d: k.d as string,
    alg: 'ES256',
    use: 'sig',
  };
}

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const prop of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[prop];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/** Always reads the current production clock; callers cannot renew an assertion. */
export function assertFreshness(expiresAt: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (!isSafePositiveInt(expiresAt) || !isSafePositiveInt(expiresAt - NATIVE_SEED_ADMISSION_LIFETIME_SECONDS)
    || expiresAt - NATIVE_SEED_ADMISSION_LIFETIME_SECONDS > now + NATIVE_SEED_ADMISSION_FUTURE_SKEW_SECONDS) failAdmission('invalid_claims');
  if (now >= expiresAt) failAdmission('token_expired');
}

export function decodeCanonicalBase64Url(segment: string, code: NativeSeedAdmissionErrorCode, length?: number): Uint8Array {
  if (!BASE64URL_REGEX.test(segment)) failAdmission(code);
  try {
    const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4));
    if (btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== segment) failAdmission(code);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    if (length !== undefined && bytes.byteLength !== length) failAdmission(code);
    return bytes;
  } catch { return failAdmission(code); }
}

function checkStrictArray(value: unknown[], code: NativeSeedAdmissionErrorCode): void {
  if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) failAdmission(code);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !('value' in d) || !d.enumerable) failAdmission(code);
  }
}

/** Reads only named own data; unrelated Worker bindings remain outside this codec. */
export function readConfigurationFields(env: unknown, required: readonly string[], forbidden: readonly string[] = []): Record<string, string> {
  if (!env || typeof env !== 'object') failAdmission('configuration_unavailable');
  for (const key of forbidden) if (key in env) failAdmission('invalid_configuration');
  const out: Record<string, string> = Object.create(null);
  for (const key of required) {
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (!d || !('value' in d) || !d.enumerable || typeof d.value !== 'string') failAdmission('configuration_unavailable');
    out[key] = d.value;
  }
  return out;
}
