/**
 * Browser-safe pure TypeScript wire grammar for per-resource deletion fencing.
 *
 * IMPORTANT CONTRACT BOUNDARY:
 * Passing any parser in this module establishes grammar validity ONLY.
 * It does NOT establish authority, verified proof, cryptographic validity,
 * capacity allocation, primary deletion matching, or runtime authorization.
 * All signature verification, Durable Object holds, capacity reservations,
 * and catalog transaction CAS belong to Core C2-C6 and product adapters.
 */

import { isResourceOperationId, type ResourceOperationId } from './resource-operations';

export type ResourceDeleteControlPhase =
  | 'prepare'
  | 'held'
  | 'delete_committed'
  | 'abort_excluded'
  | 'aborted'
  | 'delete_settled';

export interface ResourceDeleteProductRevision {
  /** Generic indicator: unopened native resource vs materialized state. Product alone checks sequence. */
  kind: 'materialized' | 'unopened';
  /** Opaque exact revision string (<= 4096 UTF-8 bytes). */
  value: string;
  /** Lowercase 64-hex SHA-256 hash syntax; actual value hash equality verification belongs to C3/product. */
  sha256: string;
}

export interface ResourceDeleteControlIdentity {
  version: 1;
  organizationId: string;
  workspaceId: string;
  resourceId: string;
  parentId: string | null;
  actorId: string;
  ownerAppId: string;
  installationId: string;
  authorityEpoch: number;
  operationId: ResourceOperationId;
  requestSha256: string;
  controlEnvelopeSha256: string;
  operationAttemptId: string;
  controlId: string;
  expectedMetadataVersion: number;
  productRevision: ResourceDeleteProductRevision;
}

export interface ResourceDeleteCapacity {
  version: 1;
  organizationId: string;
  workspaceId: string;
  ownerAppId: string;
  installationId: string;
  /** Permanent controls across this installation in Core's shared catalog database. */
  coreSlots: number;
  /** Permanent controls per resource Room under this installation's provisioned policy. */
  productSlots: number;
}

export interface ResourceDeleteInstallationLatch {
  version: 1;
  organizationId: string;
  workspaceId: string;
  resourceId: string;
  ownerAppId: string;
  installationId: string;
  authorityEpoch: number;
  required: true;
}

export interface ResourceDeleteCommittedEvidence {
  version: 1;
  kind: 'own_delete_committed';
  identity: ResourceDeleteControlIdentity;
  expectedOperationRevision: number;
  heldControlRevision: number;
  decisionControlRevision: number;
  holdId: string;
  holdSha256: string;
  deletionId: string;
  tombstoneMetadataVersion: number;
}

export interface ResourceDeleteAbortExclusionEvidence {
  version: 1;
  kind: 'abort_excluded';
  identity: ResourceDeleteControlIdentity;
  expectedOperationRevision: number;
  heldControlRevision: number;
  decisionControlRevision: number;
  holdId: string;
  holdSha256: string;
  exclusionId: string;
  primaryDeletionExcluded: true;
}

export type ResourceDeleteControlMessage =
  | {
      version: 1;
      identity: ResourceDeleteControlIdentity;
      expectedOperationRevision: number;
      controlRevision: number;
      phase: 'prepare';
      requiredActions: ['file.read', 'file.delete'];
    }
  | {
      version: 1;
      identity: ResourceDeleteControlIdentity;
      expectedOperationRevision: number;
      controlRevision: number;
      phase: 'held';
      holdId: string;
      holdSha256: string;
    }
  | {
      version: 1;
      identity: ResourceDeleteControlIdentity;
      expectedOperationRevision: number;
      controlRevision: number;
      phase: 'delete_committed';
      evidence: ResourceDeleteCommittedEvidence;
    }
  | {
      version: 1;
      identity: ResourceDeleteControlIdentity;
      expectedOperationRevision: number;
      controlRevision: number;
      phase: 'abort_excluded';
      evidence: ResourceDeleteAbortExclusionEvidence;
    }
  | {
      version: 1;
      identity: ResourceDeleteControlIdentity;
      expectedOperationRevision: number;
      controlRevision: number;
      phase: 'aborted';
      evidence: ResourceDeleteAbortExclusionEvidence;
      acknowledgementId: string;
    }
  | {
      version: 1;
      identity: ResourceDeleteControlIdentity;
      expectedOperationRevision: number;
      controlRevision: number;
      phase: 'delete_settled';
      evidence: ResourceDeleteCommittedEvidence;
      acknowledgementId: string;
    };

export interface ResourceDeleteProofTransport {
  version: 1;
  message: ResourceDeleteControlMessage;
  proof: string;
  issuedAt: number;
  expiresAt: number;
}

export type ResourceDeleteControlOutcome =
  | {
      version: 1;
      operationId: ResourceOperationId;
      controlId: string;
      stage: 'pending' | 'unknown' | 'blocked_held';
    }
  | {
      version: 1;
      operationId: ResourceOperationId;
      controlId: string;
      stage: 'delete_settled';
      deletionId: string;
    }
  | {
      version: 1;
      operationId: ResourceOperationId;
      controlId: string;
      stage: 'aborted';
      exclusionId: string;
    };

export const RESOURCE_DELETE_FENCE_LIMITS = {
  scopeMaxBytes: 128,
  opaqueRevisionMaxBytes: 4096,
  proofMaxBytes: 8192,
  messageMaxBytes: 16384,
  proofLifetimeMaxSeconds: 300,
} as const;

export class ResourceDeleteFenceContractError extends Error {
  readonly code = 'invalid_resource_delete_fence' as const;
  constructor(readonly field: string, message = `Invalid resource delete fence field: ${field}`) {
    super(message);
    this.name = 'ResourceDeleteFenceContractError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SCOPE_ID = /^[\x21-\x7e]{1,128}$/;
const ATTEMPT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const APP_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const fail: (field: string) => never = (field) => {
  throw new ResourceDeleteFenceContractError(field);
};

const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isSha256 = (v: unknown): v is string => typeof v === 'string' && SHA256.test(v);
const isScopeId = (v: unknown): v is string => typeof v === 'string' && SCOPE_ID.test(v);
const isAttemptId = (v: unknown): v is string => typeof v === 'string' && ATTEMPT_ID.test(v);
const isOwnerAppId = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 64 && APP_SLUG.test(v);
const isSafeInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

function isUtf8BytesWithin(s: string, maxBytes: number): boolean {
  if (hasLoneSurrogate(s)) return false;
  return new TextEncoder().encode(s).byteLength <= maxBytes;
}

/** Own data properties of a plain object, read via descriptors so accessors are never invoked. */
function ownData(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(field);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail(field);
  if (Object.getOwnPropertySymbols(value).length > 0) return fail(field);
  const out: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    const d = descriptors[key]!;
    if (!allowed.includes(key) || !('value' in d) || !d.enumerable) return fail(`${field}.${key}`);
    out[key] = d.value;
  }
  for (const key of required) {
    if (!(key in out)) return fail(`${field}.${key}`);
  }
  return out;
}

function dataArray(value: unknown, min: number, max: number, field: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail(field);
  const length = value.length;
  if (length < min || length > max) return fail(field);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) return fail(field);
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const d = descriptors[String(i)];
    if (!d || !('value' in d) || !d.enumerable) return fail(`${field}[${i}]`);
    out.push(d.value);
  }
  if (Object.keys(descriptors).length !== length + 1) return fail(field);
  return out;
}

export function parseResourceDeleteProductRevision(
  input: unknown,
  field = 'productRevision'
): ResourceDeleteProductRevision {
  const allowed = ['kind', 'value', 'sha256'];
  const r = ownData(input, allowed, allowed, field);
  if (r.kind !== 'materialized' && r.kind !== 'unopened') fail(`${field}.kind`);
  if (
    typeof r.value !== 'string' ||
    r.value.length === 0 ||
    !isUtf8BytesWithin(r.value, RESOURCE_DELETE_FENCE_LIMITS.opaqueRevisionMaxBytes)
  ) {
    fail(`${field}.value`);
  }
  if (!isSha256(r.sha256)) fail(`${field}.sha256`);
  return input as ResourceDeleteProductRevision;
}

export function parseResourceDeleteControlIdentity(
  input: unknown,
  field = 'identity'
): ResourceDeleteControlIdentity {
  const allowed = [
    'version',
    'organizationId',
    'workspaceId',
    'resourceId',
    'parentId',
    'actorId',
    'ownerAppId',
    'installationId',
    'authorityEpoch',
    'operationId',
    'requestSha256',
    'controlEnvelopeSha256',
    'operationAttemptId',
    'controlId',
    'expectedMetadataVersion',
    'productRevision',
  ];
  const r = ownData(input, allowed, allowed, field);
  if (r.version !== 1) fail(`${field}.version`);
  if (!isScopeId(r.organizationId)) fail(`${field}.organizationId`);
  if (!isScopeId(r.workspaceId)) fail(`${field}.workspaceId`);
  if (!isUuid(r.resourceId)) fail(`${field}.resourceId`);
  if (r.parentId !== null && !isUuid(r.parentId)) fail(`${field}.parentId`);
  if (!isScopeId(r.actorId)) fail(`${field}.actorId`);
  if (!isOwnerAppId(r.ownerAppId)) fail(`${field}.ownerAppId`);
  if (!isScopeId(r.installationId)) fail(`${field}.installationId`);
  if (!isSafeInt(r.authorityEpoch, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.authorityEpoch`);
  if (!isResourceOperationId(r.operationId)) fail(`${field}.operationId`);
  if (!isSha256(r.requestSha256)) fail(`${field}.requestSha256`);
  if (!isSha256(r.controlEnvelopeSha256)) fail(`${field}.controlEnvelopeSha256`);
  if (!isAttemptId(r.operationAttemptId)) fail(`${field}.operationAttemptId`);
  if (!isUuid(r.controlId)) fail(`${field}.controlId`);
  if (!isSafeInt(r.expectedMetadataVersion, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.expectedMetadataVersion`);
  parseResourceDeleteProductRevision(r.productRevision, `${field}.productRevision`);

  return input as ResourceDeleteControlIdentity;
}

export function parseResourceDeleteCapacity(
  input: unknown,
  field = 'capacity'
): ResourceDeleteCapacity {
  const allowed = [
    'version',
    'organizationId',
    'workspaceId',
    'ownerAppId',
    'installationId',
    'coreSlots',
    'productSlots',
  ];
  const r = ownData(input, allowed, allowed, field);
  if (r.version !== 1) fail(`${field}.version`);
  if (!isScopeId(r.organizationId)) fail(`${field}.organizationId`);
  if (!isScopeId(r.workspaceId)) fail(`${field}.workspaceId`);
  if (!isOwnerAppId(r.ownerAppId)) fail(`${field}.ownerAppId`);
  if (!isScopeId(r.installationId)) fail(`${field}.installationId`);
  if (!isSafeInt(r.coreSlots, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.coreSlots`);
  if (!isSafeInt(r.productSlots, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.productSlots`);
  return input as ResourceDeleteCapacity;
}

export function parseResourceDeleteInstallationLatch(
  input: unknown,
  field = 'latch'
): ResourceDeleteInstallationLatch {
  const allowed = [
    'version',
    'organizationId',
    'workspaceId',
    'resourceId',
    'ownerAppId',
    'installationId',
    'authorityEpoch',
    'required',
  ];
  const r = ownData(input, allowed, allowed, field);
  if (r.version !== 1) fail(`${field}.version`);
  if (!isScopeId(r.organizationId)) fail(`${field}.organizationId`);
  if (!isScopeId(r.workspaceId)) fail(`${field}.workspaceId`);
  if (!isUuid(r.resourceId)) fail(`${field}.resourceId`);
  if (!isOwnerAppId(r.ownerAppId)) fail(`${field}.ownerAppId`);
  if (!isScopeId(r.installationId)) fail(`${field}.installationId`);
  if (!isSafeInt(r.authorityEpoch, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.authorityEpoch`);
  if (r.required !== true) fail(`${field}.required`);
  return input as ResourceDeleteInstallationLatch;
}

export function parseResourceDeleteCommittedEvidence(
  input: unknown,
  field = 'evidence'
): ResourceDeleteCommittedEvidence {
  const allowed = [
    'version',
    'kind',
    'identity',
    'expectedOperationRevision',
    'heldControlRevision',
    'decisionControlRevision',
    'holdId',
    'holdSha256',
    'deletionId',
    'tombstoneMetadataVersion',
  ];
  const r = ownData(input, allowed, allowed, field);
  if (r.version !== 1) fail(`${field}.version`);
  if (r.kind !== 'own_delete_committed') fail(`${field}.kind`);
  const identity = parseResourceDeleteControlIdentity(r.identity, `${field}.identity`);
  if (!isSafeInt(r.expectedOperationRevision, 1, 999999)) fail(`${field}.expectedOperationRevision`);
  if (!isSafeInt(r.heldControlRevision, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.heldControlRevision`);
  if (!isSafeInt(r.decisionControlRevision, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.decisionControlRevision`);
  if (r.decisionControlRevision <= r.heldControlRevision) fail(`${field}.decisionControlRevision`);
  if (!isUuid(r.holdId)) fail(`${field}.holdId`);
  if (!isSha256(r.holdSha256)) fail(`${field}.holdSha256`);
  if (!isUuid(r.deletionId)) fail(`${field}.deletionId`);
  if (!isSafeInt(r.tombstoneMetadataVersion, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.tombstoneMetadataVersion`);
  const expectedTombstone = identity.expectedMetadataVersion + 1;
  if (!Number.isSafeInteger(expectedTombstone) || r.tombstoneMetadataVersion !== expectedTombstone) {
    fail(`${field}.tombstoneMetadataVersion`);
  }
  return input as ResourceDeleteCommittedEvidence;
}

export function parseResourceDeleteAbortExclusionEvidence(
  input: unknown,
  field = 'evidence'
): ResourceDeleteAbortExclusionEvidence {
  const allowed = [
    'version',
    'kind',
    'identity',
    'expectedOperationRevision',
    'heldControlRevision',
    'decisionControlRevision',
    'holdId',
    'holdSha256',
    'exclusionId',
    'primaryDeletionExcluded',
  ];
  const r = ownData(input, allowed, allowed, field);
  if (r.version !== 1) fail(`${field}.version`);
  if (r.kind !== 'abort_excluded') fail(`${field}.kind`);
  parseResourceDeleteControlIdentity(r.identity, `${field}.identity`);
  if (!isSafeInt(r.expectedOperationRevision, 1, 999999)) fail(`${field}.expectedOperationRevision`);
  if (!isSafeInt(r.heldControlRevision, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.heldControlRevision`);
  if (!isSafeInt(r.decisionControlRevision, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.decisionControlRevision`);
  if (r.decisionControlRevision <= r.heldControlRevision) fail(`${field}.decisionControlRevision`);
  if (!isUuid(r.holdId)) fail(`${field}.holdId`);
  if (!isSha256(r.holdSha256)) fail(`${field}.holdSha256`);
  if (!isUuid(r.exclusionId)) fail(`${field}.exclusionId`);
  if (r.primaryDeletionExcluded !== true) fail(`${field}.primaryDeletionExcluded`);
  return input as ResourceDeleteAbortExclusionEvidence;
}

function checkIdentityEquality(
  outer: ResourceDeleteControlIdentity,
  inner: ResourceDeleteControlIdentity,
  field: string
): void {
  if (outer.version !== inner.version) fail(`${field}.version`);
  if (outer.organizationId !== inner.organizationId) fail(`${field}.organizationId`);
  if (outer.workspaceId !== inner.workspaceId) fail(`${field}.workspaceId`);
  if (outer.resourceId !== inner.resourceId) fail(`${field}.resourceId`);
  if (outer.parentId !== inner.parentId) fail(`${field}.parentId`);
  if (outer.actorId !== inner.actorId) fail(`${field}.actorId`);
  if (outer.ownerAppId !== inner.ownerAppId) fail(`${field}.ownerAppId`);
  if (outer.installationId !== inner.installationId) fail(`${field}.installationId`);
  if (outer.authorityEpoch !== inner.authorityEpoch) fail(`${field}.authorityEpoch`);
  if (outer.operationId !== inner.operationId) fail(`${field}.operationId`);
  if (outer.requestSha256 !== inner.requestSha256) fail(`${field}.requestSha256`);
  if (outer.controlEnvelopeSha256 !== inner.controlEnvelopeSha256) fail(`${field}.controlEnvelopeSha256`);
  if (outer.operationAttemptId !== inner.operationAttemptId) fail(`${field}.operationAttemptId`);
  if (outer.controlId !== inner.controlId) fail(`${field}.controlId`);
  if (outer.expectedMetadataVersion !== inner.expectedMetadataVersion) fail(`${field}.expectedMetadataVersion`);
  if (outer.productRevision.kind !== inner.productRevision.kind) fail(`${field}.productRevision.kind`);
  if (outer.productRevision.value !== inner.productRevision.value) fail(`${field}.productRevision.value`);
  if (outer.productRevision.sha256 !== inner.productRevision.sha256) fail(`${field}.productRevision.sha256`);
}

export function parseResourceDeleteControlMessage(
  input: unknown,
  field = 'message'
): ResourceDeleteControlMessage {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail(field);
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return fail(field);
  if (Object.getOwnPropertySymbols(input).length > 0) return fail(field);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const phaseDesc = descriptors['phase'];
  if (!phaseDesc || !('value' in phaseDesc) || !phaseDesc.enumerable) return fail(`${field}.phase`);
  const phase = phaseDesc.value;

  const baseAllowed = ['version', 'identity', 'expectedOperationRevision', 'controlRevision', 'phase'];
  let r: Record<string, unknown>;
  switch (phase) {
    case 'prepare':
      r = ownData(input, [...baseAllowed, 'requiredActions'], [...baseAllowed, 'requiredActions'], field);
      break;
    case 'held':
      r = ownData(input, [...baseAllowed, 'holdId', 'holdSha256'], [...baseAllowed, 'holdId', 'holdSha256'], field);
      break;
    case 'delete_committed':
      r = ownData(input, [...baseAllowed, 'evidence'], [...baseAllowed, 'evidence'], field);
      break;
    case 'abort_excluded':
      r = ownData(input, [...baseAllowed, 'evidence'], [...baseAllowed, 'evidence'], field);
      break;
    case 'aborted':
      r = ownData(
        input,
        [...baseAllowed, 'evidence', 'acknowledgementId'],
        [...baseAllowed, 'evidence', 'acknowledgementId'],
        field
      );
      break;
    case 'delete_settled':
      r = ownData(
        input,
        [...baseAllowed, 'evidence', 'acknowledgementId'],
        [...baseAllowed, 'evidence', 'acknowledgementId'],
        field
      );
      break;
    default:
      return fail(`${field}.phase`);
  }

  if (r.version !== 1) fail(`${field}.version`);
  const identity = parseResourceDeleteControlIdentity(r.identity, `${field}.identity`);
  if (!isSafeInt(r.expectedOperationRevision, 1, 999999)) fail(`${field}.expectedOperationRevision`);
  if (!isSafeInt(r.controlRevision, 1, Number.MAX_SAFE_INTEGER)) fail(`${field}.controlRevision`);

  if (phase === 'prepare') {
    const actions = dataArray(r.requiredActions, 2, 2, `${field}.requiredActions`);
    if (actions[0] !== 'file.read' || actions[1] !== 'file.delete') fail(`${field}.requiredActions`);
  } else if (phase === 'held') {
    if (!isUuid(r.holdId)) fail(`${field}.holdId`);
    if (!isSha256(r.holdSha256)) fail(`${field}.holdSha256`);
  } else if (phase === 'delete_committed') {
    const evidence = parseResourceDeleteCommittedEvidence(r.evidence, `${field}.evidence`);
    checkIdentityEquality(identity, evidence.identity, `${field}.evidence.identity`);
    if (r.expectedOperationRevision !== evidence.expectedOperationRevision) fail(`${field}.expectedOperationRevision`);
    if (r.controlRevision !== evidence.decisionControlRevision) fail(`${field}.controlRevision`);
  } else if (phase === 'abort_excluded') {
    const evidence = parseResourceDeleteAbortExclusionEvidence(r.evidence, `${field}.evidence`);
    checkIdentityEquality(identity, evidence.identity, `${field}.evidence.identity`);
    if (r.expectedOperationRevision !== evidence.expectedOperationRevision) fail(`${field}.expectedOperationRevision`);
    if (r.controlRevision !== evidence.decisionControlRevision) fail(`${field}.controlRevision`);
  } else if (phase === 'aborted') {
    const evidence = parseResourceDeleteAbortExclusionEvidence(r.evidence, `${field}.evidence`);
    if (!isUuid(r.acknowledgementId)) fail(`${field}.acknowledgementId`);
    checkIdentityEquality(identity, evidence.identity, `${field}.evidence.identity`);
    if (r.expectedOperationRevision !== evidence.expectedOperationRevision) fail(`${field}.expectedOperationRevision`);
    if (r.controlRevision <= evidence.decisionControlRevision) fail(`${field}.controlRevision`);
  } else if (phase === 'delete_settled') {
    const evidence = parseResourceDeleteCommittedEvidence(r.evidence, `${field}.evidence`);
    if (!isUuid(r.acknowledgementId)) fail(`${field}.acknowledgementId`);
    checkIdentityEquality(identity, evidence.identity, `${field}.evidence.identity`);
    if (r.expectedOperationRevision !== evidence.expectedOperationRevision) fail(`${field}.expectedOperationRevision`);
    if (r.controlRevision <= evidence.decisionControlRevision) fail(`${field}.controlRevision`);
  }

  return input as ResourceDeleteControlMessage;
}

function serializeIdentity(id: ResourceDeleteControlIdentity): string {
  return (
    '{' +
    `"version":1,` +
    `"organizationId":${JSON.stringify(id.organizationId)},` +
    `"workspaceId":${JSON.stringify(id.workspaceId)},` +
    `"resourceId":${JSON.stringify(id.resourceId)},` +
    `"parentId":${id.parentId === null ? 'null' : JSON.stringify(id.parentId)},` +
    `"actorId":${JSON.stringify(id.actorId)},` +
    `"ownerAppId":${JSON.stringify(id.ownerAppId)},` +
    `"installationId":${JSON.stringify(id.installationId)},` +
    `"authorityEpoch":${id.authorityEpoch},` +
    `"operationId":${JSON.stringify(id.operationId)},` +
    `"requestSha256":${JSON.stringify(id.requestSha256)},` +
    `"controlEnvelopeSha256":${JSON.stringify(id.controlEnvelopeSha256)},` +
    `"operationAttemptId":${JSON.stringify(id.operationAttemptId)},` +
    `"controlId":${JSON.stringify(id.controlId)},` +
    `"expectedMetadataVersion":${id.expectedMetadataVersion},` +
    `"productRevision":{"kind":${JSON.stringify(id.productRevision.kind)},"value":${JSON.stringify(id.productRevision.value)},"sha256":${JSON.stringify(id.productRevision.sha256)}}` +
    '}'
  );
}

function serializeCommittedEvidence(ev: ResourceDeleteCommittedEvidence): string {
  return (
    '{' +
    `"version":1,` +
    `"kind":"own_delete_committed",` +
    `"identity":${serializeIdentity(ev.identity)},` +
    `"expectedOperationRevision":${ev.expectedOperationRevision},` +
    `"heldControlRevision":${ev.heldControlRevision},` +
    `"decisionControlRevision":${ev.decisionControlRevision},` +
    `"holdId":${JSON.stringify(ev.holdId)},` +
    `"holdSha256":${JSON.stringify(ev.holdSha256)},` +
    `"deletionId":${JSON.stringify(ev.deletionId)},` +
    `"tombstoneMetadataVersion":${ev.tombstoneMetadataVersion}` +
    '}'
  );
}

function serializeAbortExclusionEvidence(ev: ResourceDeleteAbortExclusionEvidence): string {
  return (
    '{' +
    `"version":1,` +
    `"kind":"abort_excluded",` +
    `"identity":${serializeIdentity(ev.identity)},` +
    `"expectedOperationRevision":${ev.expectedOperationRevision},` +
    `"heldControlRevision":${ev.heldControlRevision},` +
    `"decisionControlRevision":${ev.decisionControlRevision},` +
    `"holdId":${JSON.stringify(ev.holdId)},` +
    `"holdSha256":${JSON.stringify(ev.holdSha256)},` +
    `"exclusionId":${JSON.stringify(ev.exclusionId)},` +
    `"primaryDeletionExcluded":true` +
    '}'
  );
}

function serializeControlMessage(message: ResourceDeleteControlMessage): string {
  const base =
    `"version":1,` +
    `"identity":${serializeIdentity(message.identity)},` +
    `"expectedOperationRevision":${message.expectedOperationRevision},` +
    `"controlRevision":${message.controlRevision},` +
    `"phase":${JSON.stringify(message.phase)}`;

  switch (message.phase) {
    case 'prepare':
      return `{${base},"requiredActions":["file.read","file.delete"]}`;
    case 'held':
      return `{${base},"holdId":${JSON.stringify(message.holdId)},"holdSha256":${JSON.stringify(message.holdSha256)}}`;
    case 'delete_committed':
      return `{${base},"evidence":${serializeCommittedEvidence(message.evidence)}}`;
    case 'abort_excluded':
      return `{${base},"evidence":${serializeAbortExclusionEvidence(message.evidence)}}`;
    case 'aborted':
      return `{${base},"evidence":${serializeAbortExclusionEvidence(message.evidence)},"acknowledgementId":${JSON.stringify(message.acknowledgementId)}}`;
    case 'delete_settled':
      return `{${base},"evidence":${serializeCommittedEvidence(message.evidence)},"acknowledgementId":${JSON.stringify(message.acknowledgementId)}}`;
  }
}

/**
 * Deterministic JSON serialization of a validated control message.
 * Emits explicitly ordered keys at every nested level with exact UTF-8 values.
 * Fails if encoded bytes exceed transport limit (16384 bytes).
 */
export function resourceDeleteControlMessageBytes(message: ResourceDeleteControlMessage): Uint8Array {
  parseResourceDeleteControlMessage(message);
  const json = serializeControlMessage(message);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > RESOURCE_DELETE_FENCE_LIMITS.messageMaxBytes) {
    fail('message');
  }
  return bytes;
}

export function parseResourceDeleteProofTransport(
  input: unknown,
  field = 'transport'
): ResourceDeleteProofTransport {
  const allowed = ['version', 'message', 'proof', 'issuedAt', 'expiresAt'];
  const r = ownData(input, allowed, allowed, field);
  if (r.version !== 1) fail(`${field}.version`);
  if (
    typeof r.proof !== 'string' ||
    r.proof.length === 0 ||
    r.proof.length > RESOURCE_DELETE_FENCE_LIMITS.proofMaxBytes ||
    !/^[\x21-\x7e]+$/.test(r.proof)
  ) {
    fail(`${field}.proof`);
  }
  if (!isSafeInt(r.issuedAt, 0, Number.MAX_SAFE_INTEGER)) fail(`${field}.issuedAt`);
  if (!isSafeInt(r.expiresAt, 0, Number.MAX_SAFE_INTEGER)) fail(`${field}.expiresAt`);
  if (r.expiresAt <= r.issuedAt) fail(`${field}.expiresAt`);
  if (r.expiresAt - r.issuedAt > RESOURCE_DELETE_FENCE_LIMITS.proofLifetimeMaxSeconds) {
    fail(`${field}.expiresAt`);
  }
  parseResourceDeleteControlMessage(r.message, `${field}.message`);
  resourceDeleteControlMessageBytes(r.message as ResourceDeleteControlMessage);
  return input as ResourceDeleteProofTransport;
}

export function parseResourceDeleteControlOutcome(
  input: unknown,
  field = 'outcome'
): ResourceDeleteControlOutcome {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail(field);
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return fail(field);
  if (Object.getOwnPropertySymbols(input).length > 0) return fail(field);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const stageDesc = descriptors['stage'];
  if (!stageDesc || !('value' in stageDesc) || !stageDesc.enumerable) return fail(`${field}.stage`);
  const stage = stageDesc.value;

  const base = ['version', 'operationId', 'controlId', 'stage'];
  let r: Record<string, unknown>;
  switch (stage) {
    case 'pending':
    case 'unknown':
    case 'blocked_held':
      r = ownData(input, base, base, field);
      break;
    case 'delete_settled':
      r = ownData(input, [...base, 'deletionId'], [...base, 'deletionId'], field);
      if (!isUuid(r.deletionId)) fail(`${field}.deletionId`);
      break;
    case 'aborted':
      r = ownData(input, [...base, 'exclusionId'], [...base, 'exclusionId'], field);
      if (!isUuid(r.exclusionId)) fail(`${field}.exclusionId`);
      break;
    default:
      return fail(`${field}.stage`);
  }

  if (r.version !== 1) fail(`${field}.version`);
  if (!isResourceOperationId(r.operationId)) fail(`${field}.operationId`);
  if (!isUuid(r.controlId)) fail(`${field}.controlId`);

  return input as ResourceDeleteControlOutcome;
}
