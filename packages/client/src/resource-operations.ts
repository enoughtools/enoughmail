/**
 * Public client helpers for resource operations.
 * Pure browser-safe helpers avoiding circular imports.
 */
import {
  canonicalJson,
  isResourceOperationId,
  parseResourceOperationOutcome,
  parseResourceOperationRequest,
  RESOURCE_OPERATION_LIMITS,
  type ResourceOperationOutcome,
  type ResourceOperationRequest,
} from '@open-cloud/contracts';

export const RESOURCE_OPERATION_HEADER = 'X-Open-Cloud-Resource-Operation';

type ErrorFactory = (status: number, code: string) => Error;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(str: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw new Error('invalid_base64url');
  let base64 = str.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeOperationSegment(operationId: string): string {
  if (!isResourceOperationId(operationId)) throw new Error('invalid_operation_id');
  const bytes = new TextEncoder().encode(operationId);
  if (bytes.length > 128) throw new Error('invalid_operation_id');
  return `op_${toBase64Url(bytes)}`;
}

export function decodeOperationSegment(segment: string): string {
  if (!segment.startsWith('op_')) throw new Error('invalid_segment');
  const rawB64 = segment.slice(3);
  if (!/^[A-Za-z0-9_-]{2,171}$/.test(rawB64)) throw new Error('invalid_segment');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(rawB64);
  } catch {
    throw new Error('invalid_segment');
  }
  // Fatal re-encode check
  const reencoded = toBase64Url(bytes);
  if (reencoded !== rawB64) throw new Error('invalid_segment');
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('invalid_segment');
  }
  if (!isResourceOperationId(decoded) || bytes.length > 128) throw new Error('invalid_segment');
  return decoded;
}

export function encodeUploadMetadataHeader(proposal: Extract<ResourceOperationRequest, { kind: 'upload' }>): string {
  const jsonStr = canonicalJson(proposal);
  const bytes = new TextEncoder().encode(jsonStr);
  if (bytes.length > 4096) throw new Error('metadata_too_large');
  const encoded = toBase64Url(bytes);
  if (encoded.length > 8192) throw new Error('metadata_too_large');
  return encoded;
}

/** Non-authoritative decoding utility for retained SDK metadata; the Core route independently applies strict JSON parsing. */
export function decodeUploadMetadataHeader(headerValue: string): Extract<ResourceOperationRequest, { kind: 'upload' }> {
  if (headerValue.length > 8192) throw new Error('invalid_metadata_header');
  if (!/^[A-Za-z0-9_-]+$/.test(headerValue)) throw new Error('invalid_metadata_header');
  const bytes = fromBase64Url(headerValue);
  if (bytes.length > 4096) throw new Error('invalid_metadata_header');
  if (toBase64Url(bytes) !== headerValue) throw new Error('invalid_metadata_header');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text);
  const validated = parseResourceOperationRequest(parsed);
  if (validated.kind !== 'upload') throw new Error('invalid_metadata_header');
  return validated;
}

function cloneProposal<T extends ResourceOperationRequest>(input: T, errorFactory: ErrorFactory): T {
  let validated: T;
  try { validated = parseResourceOperationRequest(input) as T; }
  catch { throw errorFactory(400, 'invalid_resource_operation'); }
  const detached: Record<string, unknown> = Object.create(null);
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(validated))) {
    detached[key] = desc.value;
  }
  return Object.freeze(JSON.parse(canonicalJson(detached))) as T;
}

function validateAndBindOutcome(
  outcome: ResourceOperationOutcome,
  proposal: ResourceOperationRequest,
  errorFactory: ErrorFactory,
): ResourceOperationOutcome {
  if (outcome.operationId !== proposal.operationId || outcome.kind !== proposal.kind) {
    throw errorFactory(502, 'outcome_mismatch');
  }
  if (outcome.stage === 'committed') {
    if (outcome.resourceId !== proposal.resourceId.toLowerCase()) {
      throw errorFactory(502, 'outcome_mismatch');
    }
  }
  return outcome;
}

export async function prepareResourceOperationHelper(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  readJson: <T>(response: Response) => Promise<T>,
  errorFactory: ErrorFactory,
  originalProposal: ResourceOperationRequest,
): Promise<ResourceOperationOutcome> {
  const proposal = cloneProposal(originalProposal, errorFactory);
  const body = canonicalJson(proposal);
  const response = await fetcher('/api/resource-operations/prepare', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body,
  });
  const data = await readJson<unknown>(response);
  let outcome: ResourceOperationOutcome;
  try {
    outcome = parseResourceOperationOutcome(data);
  } catch {
    throw errorFactory(502, 'invalid_resource_operation_outcome');
  }
  return validateAndBindOutcome(outcome, proposal, errorFactory);
}

export async function executeResourceUploadHelper(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  readJson: <T>(response: Response) => Promise<T>,
  errorFactory: ErrorFactory,
  originalUploadProposal: Extract<ResourceOperationRequest, { kind: 'upload' }>,
  body: Blob | ArrayBuffer,
): Promise<ResourceOperationOutcome> {
  const proposal = cloneProposal(originalUploadProposal, errorFactory);
  if (proposal.kind !== 'upload') throw errorFactory(400, 'invalid_resource_operation');

  let bytes: ArrayBuffer;
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > RESOURCE_OPERATION_LIMITS.uploadMaxBytes) throw errorFactory(413, 'upload_too_large');
    bytes = body.slice(0);
  } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > RESOURCE_OPERATION_LIMITS.uploadMaxBytes) throw errorFactory(413, 'upload_too_large');
    if (body.size !== proposal.byteLength) throw errorFactory(400, 'invalid_upload');
    bytes = await body.arrayBuffer();
  } else {
    throw errorFactory(400, 'invalid_upload');
  }

  if (bytes.byteLength > RESOURCE_OPERATION_LIMITS.uploadMaxBytes) {
    throw errorFactory(413, 'upload_too_large');
  }
  if (bytes.byteLength !== proposal.byteLength) {
    throw errorFactory(400, 'invalid_upload');
  }

  const segment = encodeOperationSegment(proposal.operationId);
  const metadataHeader = encodeUploadMetadataHeader(proposal);

  const response = await fetcher(`/api/resource-operations/${segment}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      [RESOURCE_OPERATION_HEADER]: metadataHeader,
    },
    body: bytes,
  });

  const data = await readJson<unknown>(response);
  let outcome: ResourceOperationOutcome;
  try {
    outcome = parseResourceOperationOutcome(data);
  } catch {
    throw errorFactory(502, 'invalid_resource_operation_outcome');
  }
  return validateAndBindOutcome(outcome, proposal, errorFactory);
}

export async function getResourceOperationHelper(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  readJson: <T>(response: Response) => Promise<T>,
  errorFactory: ErrorFactory,
  originalOperationId: string,
): Promise<ResourceOperationOutcome> {
  if (!isResourceOperationId(originalOperationId)) throw errorFactory(400, 'invalid_operation_id');
  const segment = encodeOperationSegment(originalOperationId);
  const response = await fetcher(`/api/resource-operations/${segment}`, {
    method: 'GET',
  });
  const data = await readJson<unknown>(response);
  let outcome: ResourceOperationOutcome;
  try {
    outcome = parseResourceOperationOutcome(data);
  } catch {
    throw errorFactory(502, 'invalid_resource_operation_outcome');
  }
  if (outcome.operationId !== originalOperationId) {
    throw errorFactory(502, 'outcome_mismatch');
  }
  return outcome;
}

/** Exact retained native proposal; caller decides whether to repeat an unknown outcome. */
export async function executeResourceNativeHelper(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  readJson: <T>(response: Response) => Promise<T>,
  errorFactory: ErrorFactory,
  originalNativeProposal: Extract<ResourceOperationRequest, {kind:'create-native'}>,
): Promise<ResourceOperationOutcome> {
  const proposal = cloneProposal(originalNativeProposal,errorFactory);
  if (proposal.kind !== 'create-native') throw errorFactory(400,'invalid_resource_operation');
  const body = canonicalJson(proposal);
  const response = await fetcher(`/api/resource-operations/${encodeOperationSegment(proposal.operationId)}/execute`,{
    method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body,
  });
  const data = await readJson<unknown>(response);
  let outcome: ResourceOperationOutcome;
  try { outcome = parseResourceOperationOutcome(data); }
  catch { throw errorFactory(502,'invalid_resource_operation_outcome'); }
  return validateAndBindOutcome(outcome,proposal,errorFactory);
}

/** Exact retained delete proposal; caller decides whether to repeat an unknown outcome. */
export async function executeResourceDeleteHelper(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  readJson: <T>(response: Response) => Promise<T>,
  errorFactory: ErrorFactory,
  originalDeleteProposal: Extract<ResourceOperationRequest, {kind:'delete'}>,
): Promise<ResourceOperationOutcome> {
  const proposal = cloneProposal(originalDeleteProposal,errorFactory);
  if (proposal.kind !== 'delete') throw errorFactory(400,'invalid_resource_operation');
  const body = canonicalJson(proposal);
  const response = await fetcher(`/api/resource-operations/${encodeOperationSegment(proposal.operationId)}/execute`,{
    method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body,
  });
  const data = await readJson<unknown>(response);
  let outcome: ResourceOperationOutcome;
  try { outcome = parseResourceOperationOutcome(data); }
  catch { throw errorFactory(502,'invalid_resource_operation_outcome'); }
  return validateAndBindOutcome(outcome,proposal,errorFactory);
}
