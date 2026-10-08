/**
 * Browser-safe public generic immutable artifact custody contract.
 * Implements canonical payload serialization and strict validation for
 * artifact custody requests, reservations, receipts, and retention.
 */

import { isPolicyActionId, type PolicyAction } from './policy';

// --- Constants ---

export const ARTIFACT_CUSTODY_HEADER = 'X-Open-Cloud-Artifact-Custody';
export const ARTIFACT_MAX_SLOTS = 8;
export const ARTIFACT_MAX_SLOT_BYTES = 8 * 1024 * 1024; // 8 MiB
export const ARTIFACT_MAX_TOTAL_BYTES = 24 * 1024 * 1024; // 24 MiB

export const ARTIFACT_LIMITS = {
  maxSlots: ARTIFACT_MAX_SLOTS,
  maxSlotBytes: ARTIFACT_MAX_SLOT_BYTES,
  maxTotalBytes: ARTIFACT_MAX_TOTAL_BYTES,
} as const;

// --- Interfaces ---

export interface ArtifactSlot {
  slot: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
}

export interface ArtifactRetention {
  policyId: string;
  retainUntil: string;
  hold?: boolean;
}

export interface ArtifactBegin {
  operationId: string;
  expectedAuthorityEpoch: number;
  expectedMetadataVersion: number;
  requestHash: string;
  schemaId: string;
  schemaVersion: number;
  retention: ArtifactRetention;
  slots: ArtifactSlot[];
  requiredActions?: PolicyAction[];
}

export interface ArtifactReceipt {
  version: 1;
  organizationId: string;
  workspaceId: string;
  resourceId: string;
  ownerAppId: string;
  setId: string;
  operationId: string;
  requestHash: string;
  schemaId: string;
  schemaVersion: number;
  slots: ArtifactSlot[];
  retention: ArtifactRetention;
  confirmedAt: string;
}

export interface ArtifactStatus {
  setId: string;
  operationId: string;
  requestHash: string;
  status: 'pending' | 'confirmed';
  uploadedSlots: string[];
  receipt?: ArtifactReceipt;
  failureCode?: string;
}

export interface ArtifactReservation extends ArtifactStatus {
  custodyToken: string;
}

// --- Canonical Serialization ---

function canonical(value: unknown, depth: number): string {
  if (depth > 16) {
    throw new TypeError('Maximum depth exceeded in canonical serialization');
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Non-finite numbers are not allowed in canonical serialization');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonical(item, depth + 1)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const val = rec[key];
      if (val === undefined) {
        throw new TypeError(`Undefined value for key "${key}" is not allowed in canonical serialization`);
      }
      entries.push(`${JSON.stringify(key)}:${canonical(val, depth + 1)}`);
    }
    return '{' + entries.join(',') + '}';
  }
  throw new TypeError(`Unsupported type in canonical serialization: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return canonical(value, 0);
}

export function canonicalArtifactBegin(value: ArtifactBegin): string;
export function canonicalArtifactBegin(value: Omit<ArtifactBegin, 'requestHash'>): string;
export function canonicalArtifactBegin(value: ArtifactBegin | Omit<ArtifactBegin, 'requestHash'>): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ArtifactBegin value must be a non-null object');
  }

  const rec = value as unknown as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(rec)) {
    if (key !== 'requestHash') {
      copy[key] = rec[key];
    }
  }

  return canonicalJson(copy);
}

// --- Validation Helpers ---

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const SHA256_LOWER_HEX_REGEX = /^[0-9a-f]{64}$/;
const SCHEMA_ID_REGEX = /^[a-z][a-z0-9.-]{2,99}$/;
const MIME_TYPE_REGEX = /^[a-z0-9!#$%&'*+\-.^_`|~]+\/[a-z0-9!#$%&'*+\-.^_`|~]+$/;

const ALLOWED_BEGIN_KEYS = new Set([
  'operationId',
  'expectedAuthorityEpoch',
  'expectedMetadataVersion',
  'requestHash',
  'schemaId',
  'schemaVersion',
  'retention',
  'slots',
  'requiredActions',
]);

const ALLOWED_SLOT_KEYS = new Set([
  'slot',
  'mimeType',
  'byteLength',
  'sha256',
]);

function isValidIsoUtcDate(dateStr: unknown): boolean {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(dateStr)) {
    return false;
  }
  const d = new Date(dateStr);
  return Number.isFinite(d.getTime()) && d.toISOString() === dateStr;
}

// --- Validation Implementation ---

export function validateArtifactBegin(value: unknown): value is ArtifactBegin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const rootKeys = Object.keys(value);
  const expectedKeyCount = rootKeys.includes('requiredActions') ? 9 : 8;
  if (rootKeys.length !== expectedKeyCount) {
    return false;
  }
  for (const key of rootKeys) {
    if (!ALLOWED_BEGIN_KEYS.has(key)) {
      return false;
    }
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.operationId !== 'string' || !SAFE_ID_REGEX.test(obj.operationId)) {
    return false;
  }

  if (
    typeof obj.expectedAuthorityEpoch !== 'number' ||
    !Number.isSafeInteger(obj.expectedAuthorityEpoch) ||
    obj.expectedAuthorityEpoch <= 0
  ) {
    return false;
  }

  if (
    typeof obj.expectedMetadataVersion !== 'number' ||
    !Number.isSafeInteger(obj.expectedMetadataVersion) ||
    obj.expectedMetadataVersion <= 0
  ) {
    return false;
  }

  if (
    typeof obj.schemaVersion !== 'number' ||
    !Number.isSafeInteger(obj.schemaVersion) ||
    obj.schemaVersion <= 0
  ) {
    return false;
  }

  if (typeof obj.schemaId !== 'string' || !SCHEMA_ID_REGEX.test(obj.schemaId)) {
    return false;
  }

  if (
    typeof obj.requestHash !== 'string' ||
    !SHA256_LOWER_HEX_REGEX.test(obj.requestHash)
  ) {
    return false;
  }

  const retention = obj.retention;
  if (!retention || typeof retention !== 'object' || Array.isArray(retention)) {
    return false;
  }
  const retentionObj = retention as Record<string, unknown>;
  for (const key of Object.keys(retentionObj)) {
    if (key !== 'policyId' && key !== 'retainUntil' && key !== 'hold') {
      return false;
    }
  }
  if (
    typeof retentionObj.policyId !== 'string' ||
    !SAFE_ID_REGEX.test(retentionObj.policyId) ||
    !isValidIsoUtcDate(retentionObj.retainUntil)
  ) {
    return false;
  }
  if ('hold' in retentionObj && typeof retentionObj.hold !== 'boolean') {
    return false;
  }

  if (
    !Array.isArray(obj.slots) ||
    obj.slots.length < 1 ||
    obj.slots.length > ARTIFACT_MAX_SLOTS
  ) {
    return false;
  }

  const seenSlots = new Set<string>();
  let totalBytes = 0;

  for (const slotItem of obj.slots) {
    if (!slotItem || typeof slotItem !== 'object' || Array.isArray(slotItem)) {
      return false;
    }
    const slotObj = slotItem as Record<string, unknown>;
    const slotKeys = Object.keys(slotObj);
    if (slotKeys.length !== ALLOWED_SLOT_KEYS.size) {
      return false;
    }
    for (const key of slotKeys) {
      if (!ALLOWED_SLOT_KEYS.has(key)) {
        return false;
      }
    }

    if (
      typeof slotObj.slot !== 'string' ||
      !SAFE_ID_REGEX.test(slotObj.slot)
    ) {
      return false;
    }
    if (seenSlots.has(slotObj.slot)) {
      return false;
    }
    seenSlots.add(slotObj.slot);

    if (
      typeof slotObj.mimeType !== 'string' ||
      slotObj.mimeType.length > 128 ||
      !MIME_TYPE_REGEX.test(slotObj.mimeType)
    ) {
      return false;
    }

    if (
      typeof slotObj.byteLength !== 'number' ||
      !Number.isSafeInteger(slotObj.byteLength) ||
      slotObj.byteLength < 0 ||
      slotObj.byteLength > ARTIFACT_MAX_SLOT_BYTES
    ) {
      return false;
    }
    totalBytes += slotObj.byteLength;
    if (totalBytes > ARTIFACT_MAX_TOTAL_BYTES) {
      return false;
    }

    if (
      typeof slotObj.sha256 !== 'string' ||
      !SHA256_LOWER_HEX_REGEX.test(slotObj.sha256)
    ) {
      return false;
    }
  }

  if ('requiredActions' in obj) {
    const actions = obj.requiredActions;
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16) {
      return false;
    }
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (typeof action !== 'string' || !isPolicyActionId(action)) {
        return false;
      }
      if (i > 0 && !(actions[i - 1] < action)) {
        return false;
      }
    }
  }

  return true;
}
