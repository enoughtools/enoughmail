/** Public wire contract for ordinary resource operations. Pure validation; no authority, storage or domain interpretation. */
import { isPolicyActionId } from './policy';
import { parseResourceDeleteProductRevision, type ResourceDeleteProductRevision } from './resource-delete-fence';
import type { PermissionGrant } from './policy';

export type ResourceOperationId = string;
export type ResourceOperationKind = 'create-native' | 'upload' | 'delete';

export type ResourceOperationRequest =
  | { kind: 'create-native'; operationId: ResourceOperationId; resourceId: string;
      parentId: string | null; name: string; mimeType: string;
      content: string; initialPolicy?: { inherit: false; grants: PermissionGrant[] } }
  | { kind: 'upload'; operationId: ResourceOperationId; resourceId: string;
      parentId: string | null; name: string; mimeType: string;
      byteLength: number; contentSha256: string }
  | { kind: 'delete'; operationId: ResourceOperationId; resourceId: string;
      expectedMetadataVersion: number; productRevision?: ResourceDeleteProductRevision };

export type ResourceOperationOutcome =
  | { operationId: ResourceOperationId; kind: ResourceOperationKind; stage: 'prepared' | 'pending' | 'unknown' }
  | { operationId: ResourceOperationId; kind: ResourceOperationKind; stage: 'committed'; resourceId: string }
  | { operationId: ResourceOperationId; kind: ResourceOperationKind; stage: 'failed'; code: string }
  | { operationId: ResourceOperationId; kind: ResourceOperationKind; stage: 'expired' };

export const RESOURCE_OPERATION_LIMITS = {
  operationIdMax: 128,
  nameMax: 255,
  mimeMax: 255,
  nativeContentMaxBytes: 16 * 1024,
  uploadMaxBytes: 20 * 1024 * 1024,
  maxGrants: 100,
  maxGrantActions: 64,
  subjectIdMax: 256,
  grantIdMax: 128,
  codeMax: 96,
} as const;

export const RESOURCE_OPERATION_DELEGATED_LIMITS = {
  proofAsciiMaxBytes: 32 * 1024,
  delegatedBodyUtf8MaxBytes: 64 * 1024,
  proposalUtf8MaxBytes: 64 * 1024,
  routePayloadMaxBytes: 481 * 1024, // 6 * 64KiB escaped body + 64KiB encoded proposal + 32KiB ASCII proof + 1KiB framing
  providerEnvelopeMaxBytes: 2 * 1024 * 1024,
  sdkWireMaxBytes: 2 * 1024 * 1024,
} as const;

export type ResourceOperationDelegatedPhase = 'prepare' | 'execute' | 'lookup';
export type ResourceOperationDelegatedProposal = Extract<ResourceOperationRequest,{kind:'create-native'|'delete'}>;

export interface ResourceOperationDelegatedRequest<TProposal extends ResourceOperationDelegatedProposal = ResourceOperationDelegatedProposal> {
  readonly delegation: string;
  readonly delegatedBody: string;
  readonly phase?: ResourceOperationDelegatedPhase;
  readonly proposal: TProposal;
}

export interface ResourceOperationCentralEnvelope<TProposal extends ResourceOperationDelegatedProposal = ResourceOperationDelegatedProposal, TProductResult = unknown> {
  readonly originalProposal: TProposal;
  readonly reportedOutcome: ResourceOperationOutcome;
  readonly productResult: TProductResult;
}

export class ResourceOperationContractError extends Error {
  readonly code = 'invalid_resource_operation' as const;
  constructor(readonly field: string, message = `Invalid resource operation field: ${field}`) {
    super(message);
    this.name = 'ResourceOperationContractError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[\x21-\x7e]{1,128}$/;
const NATIVE_MIME = /^application\/vnd\.open-cloud\.[a-z0-9][a-z0-9.+_-]*\+json$/;
const MIME = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;
const PROTOTYPE_NAMES = new Set(['__proto__', 'prototype', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']);
const CONTROL = /[\p{Cc}]/u;
const SUBJECT_TYPES = ['actor', 'group', 'role'];
const CODE = /^[a-z][a-z0-9_.-]*$/;

const fail: (field:string)=>never = (field: string): never => { throw new ResourceOperationContractError(field); };

/** Own data properties of a plain object, read via descriptors so accessors are never invoked. */
function ownData(value: unknown, allowed: readonly string[], required: readonly string[], field: string): Record<string, unknown> {
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
  for (const key of required) if (!(key in out)) return fail(`${field}.${key}`);
  return out;
}

function dataArray(value: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail(field);
  const length = value.length;
  if (length > max) return fail(field);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) return fail(field);
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const d = descriptors[String(i)];
    if (!d || !('value' in d)) return fail(`${field}[${i}]`);
    out.push(d.value);
  }
  if (Object.keys(descriptors).length !== length + 1) return fail(field);
  return out;
}

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

export function isResourceOperationId(value: unknown): value is ResourceOperationId {
  return typeof value === 'string' && OPERATION_ID.test(value) && !PROTOTYPE_NAMES.has(value);
}
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
/** Original name is identity: no trimming, only rejection. */
const isName = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= RESOURCE_OPERATION_LIMITS.nameMax && v.trim().length > 0 && [...v.trim()].length <= RESOURCE_OPERATION_LIMITS.nameMax
  && v.trim() !== '.' && v.trim() !== '..' && !/[\/\\]/u.test(v) && !CONTROL.test(v) && !hasLoneSurrogate(v);
const isMime = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= RESOURCE_OPERATION_LIMITS.mimeMax && MIME.test(v);
const isSafeInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

function parseGrants(value: unknown, field: string): void {
  const grants = dataArray(value, RESOURCE_OPERATION_LIMITS.maxGrants, field);
  grants.forEach((raw, i) => {
    const f = `${field}[${i}]`;
    const g = ownData(raw, ['id', 'subjectType', 'subjectId', 'actions'], ['subjectType', 'subjectId', 'actions'], f);
    if ('id' in g && !(typeof g.id === 'string' && g.id.length > 0 && g.id.length <= RESOURCE_OPERATION_LIMITS.grantIdMax && !CONTROL.test(g.id))) fail(`${f}.id`);
    if (typeof g.subjectType !== 'string' || !SUBJECT_TYPES.includes(g.subjectType)) fail(`${f}.subjectType`);
    if (typeof g.subjectId !== 'string' || g.subjectId.length === 0 || g.subjectId.length > RESOURCE_OPERATION_LIMITS.subjectIdMax || CONTROL.test(g.subjectId)) fail(`${f}.subjectId`);
    const actions = dataArray(g.actions, RESOURCE_OPERATION_LIMITS.maxGrantActions, `${f}.actions`);
    if (actions.length === 0 || !actions.every(isPolicyActionId) || new Set(actions).size !== actions.length) fail(`${f}.actions`);
  });
}

/** Validates and returns the same input object; never copies, trims or reserializes. */
export function parseResourceOperationRequest(input: unknown): ResourceOperationRequest {
  if (input === null || typeof input !== 'object') return fail('request');
  const kindDescriptor = Object.getOwnPropertyDescriptor(input, 'kind');
  const kind = kindDescriptor && 'value' in kindDescriptor ? kindDescriptor.value : undefined;
  const common = ['kind', 'operationId', 'resourceId'];
  if (kind === 'create-native') {
    const r = ownData(input, [...common, 'parentId', 'name', 'mimeType', 'content', 'initialPolicy'],
      [...common, 'parentId', 'name', 'mimeType', 'content'], 'request');
    checkCommon(r);
    checkDestination(r);
    if (typeof r.mimeType !== 'string' || !NATIVE_MIME.test(r.mimeType)) fail('request.mimeType');
    if (typeof r.content !== 'string' || hasLoneSurrogate(r.content)
      || new TextEncoder().encode(r.content).byteLength > RESOURCE_OPERATION_LIMITS.nativeContentMaxBytes) fail('request.content');
    if ('initialPolicy' in r) {
      const p = ownData(r.initialPolicy, ['inherit', 'grants'], ['inherit', 'grants'], 'request.initialPolicy');
      if (p.inherit !== false) fail('request.initialPolicy.inherit');
      parseGrants(p.grants, 'request.initialPolicy.grants');
    }
  } else if (kind === 'upload') {
    const r = ownData(input, [...common, 'parentId', 'name', 'mimeType', 'byteLength', 'contentSha256'],
      [...common, 'parentId', 'name', 'mimeType', 'byteLength', 'contentSha256'], 'request');
    checkCommon(r);
    checkDestination(r);
    if (!isSafeInt(r.byteLength, 0, RESOURCE_OPERATION_LIMITS.uploadMaxBytes)) fail('request.byteLength');
    if (typeof r.contentSha256 !== 'string' || !SHA256.test(r.contentSha256)) fail('request.contentSha256');
  } else if (kind === 'delete') {
    const r = ownData(input, [...common, 'expectedMetadataVersion', 'productRevision'], [...common, 'expectedMetadataVersion'], 'request');
    checkCommon(r);
    if (!isSafeInt(r.expectedMetadataVersion, 1, Number.MAX_SAFE_INTEGER)) fail('request.expectedMetadataVersion');
    if ('productRevision' in r) {
      try { parseResourceDeleteProductRevision(r.productRevision, 'request.productRevision'); }
      catch { fail('request.productRevision'); }
    }
  } else return fail('request.kind');
  return input as ResourceOperationRequest;
}

function checkCommon(r: Record<string, unknown>): void {
  if (!isResourceOperationId(r.operationId)) fail('request.operationId');
  if (!isUuid(r.resourceId)) fail('request.resourceId');
}
function checkDestination(r: Record<string, unknown>): void {
  if (r.parentId !== null && !isUuid(r.parentId)) fail('request.parentId');
  if (!isName(r.name)) fail('request.name');
  if (!isMime(r.mimeType)) fail('request.mimeType');
}

/** Validates and returns the same outcome object; variants are strict and disjoint. */
export function parseResourceOperationOutcome(input: unknown): ResourceOperationOutcome {
  const base = ['operationId', 'kind', 'stage'];
  const probe = ownData(input, [...base, 'resourceId', 'code'], base, 'outcome');
  if (!isResourceOperationId(probe.operationId)) fail('outcome.operationId');
  if (probe.kind !== 'create-native' && probe.kind !== 'upload' && probe.kind !== 'delete') fail('outcome.kind');
  const extra = Object.keys(probe).filter((k) => !base.includes(k));
  switch (probe.stage) {
    case 'prepared': case 'pending': case 'unknown': case 'expired':
      if (extra.length) fail('outcome.' + extra[0]);
      break;
    case 'committed':
      if (extra.length !== 1 || extra[0] !== 'resourceId' || !isUuid(probe.resourceId)) fail('outcome.resourceId');
      break;
    case 'failed':
      if (extra.length !== 1 || extra[0] !== 'code' || typeof probe.code !== 'string'
        || probe.code.length > RESOURCE_OPERATION_LIMITS.codeMax || !CODE.test(probe.code)) fail('outcome.code');
      break;
    default: fail('outcome.stage');
  }
  return input as ResourceOperationOutcome;
}

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Pure validator for public browser-safe delegated resource operation DTO.
 * Strict own-data, validates create-native / delete ONLY. */
export function parseResourceOperationDelegatedRequest<TProposal extends ResourceOperationDelegatedProposal = ResourceOperationDelegatedProposal>(
  input: unknown,
): ResourceOperationDelegatedRequest<TProposal> {
  const allowed = ['delegation', 'delegatedBody', 'phase', 'proposal'];
  const required = ['delegation', 'delegatedBody', 'proposal'];
  const r = ownData(input, allowed, required, 'delegatedRequest');

  // delegation: safe ASCII, exactly 2 base64url segments separated by '.', <= 32 KiB
  if (typeof r.delegation !== 'string') fail('delegatedRequest.delegation');
  const delegation = r.delegation;
  const delegationBytes = new TextEncoder().encode(delegation).byteLength;
  if (delegationBytes > RESOURCE_OPERATION_DELEGATED_LIMITS.proofAsciiMaxBytes) fail('delegatedRequest.delegation');
  if (/[\x80-\uffff]/.test(delegation) || CONTROL.test(delegation)) fail('delegatedRequest.delegation');
  const parts = delegation.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !BASE64URL_SEGMENT.test(parts[0]) || !BASE64URL_SEGMENT.test(parts[1])) {
    fail('delegatedRequest.delegation');
  }

  // delegatedBody: UTF-8 <= 64 KiB, no lone surrogates
  if (typeof r.delegatedBody !== 'string') fail('delegatedRequest.delegatedBody');
  if (hasLoneSurrogate(r.delegatedBody)) fail('delegatedRequest.delegatedBody');
  const bodyBytes = new TextEncoder().encode(r.delegatedBody).byteLength;
  if (bodyBytes > RESOURCE_OPERATION_DELEGATED_LIMITS.delegatedBodyUtf8MaxBytes) fail('delegatedRequest.delegatedBody');

  // phase (optional): 'prepare' | 'execute' | 'lookup'
  if ('phase' in r) {
    if (r.phase !== 'prepare' && r.phase !== 'execute' && r.phase !== 'lookup') {
      fail('delegatedRequest.phase');
    }
  }

  // proposal: exact original validated ResourceOperationRequest, UTF-8 <= 64 KiB, create-native/delete ONLY
  if (r.proposal === null || typeof r.proposal !== 'object') fail('delegatedRequest.proposal');
  const proposal = parseResourceOperationRequest(r.proposal);
  if (proposal.kind !== 'create-native' && proposal.kind !== 'delete') {
    fail('delegatedRequest.proposal.kind');
  }

  if (new TextEncoder().encode(JSON.stringify(proposal)).byteLength > RESOURCE_OPERATION_DELEGATED_LIMITS.proposalUtf8MaxBytes) fail('delegatedRequest.proposal');
  return input as ResourceOperationDelegatedRequest<TProposal>;
}

/** Pure validator for central product response envelope. Strict own-data. */
export function parseResourceOperationCentralEnvelope<TProposal extends ResourceOperationDelegatedProposal = ResourceOperationDelegatedProposal, TProductResult = unknown>(
  input: unknown,
): ResourceOperationCentralEnvelope<TProposal, TProductResult> {
  const allowed = ['originalProposal', 'reportedOutcome', 'productResult'];
  const required = ['originalProposal', 'reportedOutcome', 'productResult'];
  const r = ownData(input, allowed, required, 'centralEnvelope');

  const proposal = parseResourceOperationRequest(r.originalProposal);
  if (proposal.kind !== 'create-native' && proposal.kind !== 'delete') fail('centralEnvelope.originalProposal');
  if (new TextEncoder().encode(JSON.stringify(proposal)).byteLength > RESOURCE_OPERATION_DELEGATED_LIMITS.proposalUtf8MaxBytes) fail('centralEnvelope.originalProposal');
  const outcome = parseResourceOperationOutcome(r.reportedOutcome);
  if (outcome.kind !== proposal.kind || outcome.operationId !== proposal.operationId
    || outcome.stage === 'committed' && outcome.resourceId !== proposal.resourceId.toLowerCase()) fail('centralEnvelope.reportedOutcome');

  return input as ResourceOperationCentralEnvelope<TProposal, TProductResult>;
}

