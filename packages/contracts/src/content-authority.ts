import type { PolicyAction } from './policy';
import { isProviderLifecycleDescriptor, type ProviderLifecycleDescriptor } from './provider-lifecycle';

/** Installed validation capability declaration only; not activation or permission. */
export interface NativeSeedAdmissionDescriptor {
  version: 1;
  revision: number;
  handlerPath: '/internal/native-seed-admission';
  maxBytes: 16384;
}

/** Installed deletion capability declaration only; durable controls remain authoritative. */
export interface ResourceDeletionDescriptor {
  version: 1;
  handlerPath: '/internal/resource-delete';
}

/** Platform ownership metadata; the owning product interprets its content schema. */
export interface ContentAuthorityDescriptor {
  schemaId: string;
  schemaVersion: number;
  /** Exact native MIME types only: no product can claim every workspace file. */
  mimeTypes: string[];
  lifecycle?: ProviderLifecycleDescriptor;
  seedAdmission?: NativeSeedAdmissionDescriptor;
  resourceDeletion?: ResourceDeletionDescriptor;
  currentReadPath?: '/internal/content/read';
}
export const CONTENT_AUTHORITY_VERSION = 1;
export const CONTENT_ACTOR_LEASE_SECONDS = 300;
/** Maximum UTF-8 bytes in a product's complete portable native content. */
export const CONTENT_MAX_PROJECTION_BYTES = 10 * 1024 * 1024;
export const CONTENT_ACTOR_LEASE_HEADER = 'X-Open-Cloud-Content-Actor-Lease';
export const CONTENT_PROVIDER_TOKEN_HEADER = 'X-Open-Cloud-Content-Provider-Token';

export const NATIVE_SEED_ADMISSION_MAX_SEED_BYTES = 16384;
export const NATIVE_SEED_ADMISSION_MAX_RAW_BODY_BYTES = 114688; // 112 KiB
export const NATIVE_SEED_ADMISSION_MAX_REPLY_BYTES = 4096;
export const NATIVE_SEED_ADMISSION_MAX_CONTEXT_BYTES = 4096;
export const NATIVE_SEED_ADMISSION_CALLBACK_DEADLINE_MS = 5000;

export type NativeSeedAdmissionMode = 'create-native' | 'native-upload' | 'replace-unenrolled';
export type NativeSeedAdmissionAction = 'file.create' | 'file.edit';

export interface NativeSeedAdmissionOperation {
  operationId: string;
  attemptId: string;
  requestHash: string;
}

/**
 * Pure public browser-safe DTO for native seed admission request validation transport.
 * This DTO represents validation transport only; it is never a grant or one-write control.
 * Actual AUTH server codec owns strict raw bytes, ordered context, and cryptographic verification.
 */
export interface NativeSeedAdmissionRequest {
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

export type NativeSeedAdmissionDenyReason = 'invalid_seed' | 'seed_too_large' | 'unsupported_schema';

/**
 * Pure public browser-safe DTO for native seed admission reply transport.
 * This DTO is transport only, never an authorization latch or capability proof.
 */
export interface NativeSeedAdmissionReply {
  version: 1;
  invocationId: string;
  contextHash: string;
  contentHash: string;
  admissionRevision: number;
  decision: 'allow' | 'deny';
  reason?: NativeSeedAdmissionDenyReason;
}

export function isNativeSeedAdmissionDescriptor(value: unknown): value is NativeSeedAdmissionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Object.keys(descriptors);
  if (ownKeys.length !== 4) return false;
  const expectedKeys = ['version', 'revision', 'handlerPath', 'maxBytes'];
  if (!expectedKeys.every((key) => ownKeys.includes(key))) return false;

  for (const key of expectedKeys) {
    const desc = descriptors[key];
    if (!desc || !desc.enumerable || !('value' in desc)) return false;
  }

  return descriptors.version!.value === 1
    && Number.isSafeInteger(descriptors.revision!.value) && descriptors.revision!.value >= 1
    && descriptors.handlerPath!.value === '/internal/native-seed-admission'
    && descriptors.maxBytes!.value === 16384;
}

export function isResourceDeletionDescriptor(value: unknown): value is ResourceDeletionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Object.keys(descriptors);
  if (ownKeys.length !== 2) return false;
  const expectedKeys = ['version', 'handlerPath'];
  if (!expectedKeys.every((key) => ownKeys.includes(key))) return false;

  for (const key of expectedKeys) {
    const desc = descriptors[key];
    if (!desc || !desc.enumerable || !('value' in desc)) return false;
  }

  return descriptors.version!.value === 1
    && descriptors.handlerPath!.value === '/internal/resource-delete';
}

export interface ContentAuthority {
  version: 1;
  organizationId: string;
  workspaceId: string;
  resourceId: string;
  ownerAppId: string;
  epoch: number;
  schemaId: string;
  schemaVersion: number;
  seedHash: string;
  initialized: boolean;
  projectedSequence: number;
  /** Current opt-in provider write admission generation; never a product permit. */
  lifecycleGeneration?: number;
  metadata: { name: string; version: number; updatedAt: string };
}

/** Issued from an authenticated browser principal, never from caller actor fields. */
export interface ContentActorLease {
  version: 1;
  kind: 'content-browser-actor';
  issuer: 'open-cloud-core';
  audience: string;
  organizationId: string;
  workspaceId: string;
  resourceId: string;
  epoch: number;
  actorId: string;
  displayName: string;
  actions: PolicyAction[];
  policyVersion: number;
  issuedAt: number;
  expiresAt: number;
}

/** A room's projection authority is separate from its editor's short-lived lease.
 * Core still checks installation, scope, owner, schema and epoch on every use.
 * Only service-bound provider bootstrap receives this credential.
 */
export interface ContentProviderToken {
  version: 1;
  kind: 'content-provider';
  issuer: 'open-cloud-core';
  audience: string;
  organizationId: string;
  workspaceId: string;
  resourceId: string;
  epoch: number;
  schemaId: string;
  schemaVersion: number;
  /** Optional opt-in provider lifecycle generation */
  lifecycleGeneration?: number;
}
export interface ContentActorEnrollment {
  authority: ContentAuthority;
  /** An immutable seed, never a substitute for an initialized room's latest state. */
  seedContent: string;
  actorLease: string;
}
export interface ContentProviderBootstrap {
  authority: ContentAuthority;
  seedContent: string;
  projectionToken: string;
  actor: ContentActorLease;
}
export interface ContentProjection {
  epoch: number;
  schemaId: string;
  schemaVersion: number;
  sequence: number;
  /** App-owned native serialization. Core stores bounded private bytes only. */
  content: string;
}
export interface ContentProjectionResult {
  projectedSequence: number;
  superseded: boolean;
}

export function isContentAuthorityDescriptor(value: unknown): value is ContentAuthorityDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowedKeys = ['schemaId', 'schemaVersion', 'mimeTypes', 'lifecycle', 'seedAdmission', 'resourceDeletion', 'currentReadPath'];
  if (!Object.keys(item).every((key) => allowedKeys.includes(key))) return false;
  if (typeof item.schemaId !== 'string' || !/^[a-z][a-z0-9.-]{2,99}$/.test(item.schemaId)) return false;
  if (!Number.isSafeInteger(item.schemaVersion) || Number(item.schemaVersion) < 1) return false;
  if (!Array.isArray(item.mimeTypes) || item.mimeTypes.length === 0 || item.mimeTypes.length > 16) return false;
  if (!item.mimeTypes.every((mime) => typeof mime === 'string' && /^application\/vnd\.[a-z0-9][a-z0-9.+_-]*\+json$/.test(mime))) return false;
  if (new Set(item.mimeTypes).size !== item.mimeTypes.length) return false;

  if (Object.hasOwn(item, 'lifecycle') && !isProviderLifecycleDescriptor(item.lifecycle)) return false;

  for (const key of ['seedAdmission', 'resourceDeletion', 'currentReadPath']) {
    if (key in item && !Object.hasOwn(item, key)) return false;
  }
  if (Object.hasOwn(item, 'currentReadPath')) {
    const desc = Object.getOwnPropertyDescriptor(item, 'currentReadPath');
    if (!desc || !desc.enumerable || !('value' in desc) || desc.value !== '/internal/content/read') return false;
  }
  if (Object.hasOwn(item, 'seedAdmission')) {
    const desc = Object.getOwnPropertyDescriptor(item, 'seedAdmission');
    if (!desc || !desc.enumerable || !('value' in desc)) return false;
    if (!isNativeSeedAdmissionDescriptor(desc.value)) return false;
  }

  if (Object.hasOwn(item, 'resourceDeletion')) {
    const desc = Object.getOwnPropertyDescriptor(item, 'resourceDeletion');
    if (!desc || !desc.enumerable || !('value' in desc)) return false;
    if (!isResourceDeletionDescriptor(desc.value)) return false;
  }

  return true;
}

/** Only central MCP may construct this after delegated grant verification.
 * It is never a browser lease and cannot be replayed at browser endpoints.
 */
export interface ContentVerifiedActorBootstrap {
  authority: ContentAuthority;
  seedContent: string;
  projectionToken: string;
  actor: {
    kind: 'content-mcp-actor';
    organizationId: string;
    workspaceId: string;
    resourceId: string;
    actorId: string;
    displayName: string;
    actions: ('file.read' | 'file.edit')[];
  };
}
