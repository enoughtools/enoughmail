import type { WorkspaceResource, Principal } from './index';
import type { ContentVerifiedActorBootstrap, ContentAuthority } from './content-authority';

export interface ResourceAuthorityObservation {
  version: 1;
  organizationId: string;
  workspaceId: string;
  incarnation: string;
  revision: number;
}

export type ResourceResolutionCandidatePurpose = 'required-add' | 'optional-read';

export interface ResourceResolutionCandidate {
  resourceId: string;
  purpose: ResourceResolutionCandidatePurpose;
}

export interface ResourceResolutionSourceInput {
  kind: 'file' | 'folder' | 'workspace';
  resourceId?: string;
  epoch?: number;
  sequence?: number;
}

export interface ResourceResolutionRequest {
  delegation: string;
  delegatedBody: string;
  source?: ResourceResolutionSourceInput;
  candidates: ResourceResolutionCandidate[];
  continuation?: string;
  expectedAuthorityObservation?: ResourceAuthorityObservation;
}

export type ResourceResolutionStatus = 'readable' | 'unavailable';

export interface ResourceResolutionReadableResult {
  resourceId: string;
  status: 'readable';
  metadata: WorkspaceResource;
  policyVersion: number;
  contentProof?: string;
}

export interface ResourceResolutionUnavailableResult {
  resourceId: string;
  status: 'unavailable';
}

export type ResourceResolutionResult =
  | ResourceResolutionReadableResult
  | ResourceResolutionUnavailableResult;

export type ResourceResolutionResponse = {
  allowed: true;
  source: {kind: 'file' | 'folder' | 'workspace'; resourceId?: string; policyVersion: number};
  results: ResourceResolutionResult[];
  authorityObservation: ResourceAuthorityObservation;
} | {allowed: false};

export type ResourceReadMode = 'metadata' | 'bytes' | 'native';

export interface ResourceReadRequest {
  contentProof: string;
  mode: ResourceReadMode;
}

/** Service-bound owner transport. This bootstrap is never returned to the consuming product. */
export interface CanonicalCurrentReadRequest {
  resourceId: string;
  providerProof: string;
  contentBootstrap: ContentVerifiedActorBootstrap;
}

export interface CanonicalCurrentReadResult {
  resourceId: string;
  ownerAppId: string;
  schemaId: string;
  schemaVersion: number;
  epoch: number;
  sequence: number;
  content: string;
}

export const TARGET_PROOF_DOMAIN = 'open-cloud:mcp:target-proof:v1';
export const PROVIDER_PROOF_DOMAIN = 'open-cloud:mcp:provider-proof:v1';
export const MAX_RESOURCE_RESOLUTION_CANDIDATES = 100;
export const MAX_RESOURCE_RESOLUTION_INVOCATION_TARGETS = 100;
export const MAX_CONTENT_PROOF_BYTES = 32768; // 32 KiB
export const CANONICAL_CURRENT_READ_PATH = '/internal/content/read';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seedHashPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const nativeMimePattern = /^application\/vnd\.[a-z0-9][a-z0-9.+_-]*\+json$/;

const scopeIdPattern = /^[A-Za-z0-9_-]{1,100}$/;
const incarnationPattern = /^[0-9a-f]{32}$/;

export function isResourceAuthorityObservation(value: unknown): value is ResourceAuthorityObservation {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Reflect.ownKeys(value);
    const expected = ['version', 'organizationId', 'workspaceId', 'incarnation', 'revision'];
    if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
    }
    const version:unknown=descriptors.version.value;
    const organizationId:unknown=descriptors.organizationId.value;
    const workspaceId:unknown=descriptors.workspaceId.value;
    const incarnation:unknown=descriptors.incarnation.value;
    const revision:unknown=descriptors.revision.value;
    return version===1 && typeof organizationId==='string' && scopeIdPattern.test(organizationId)
      && typeof workspaceId==='string' && scopeIdPattern.test(workspaceId)
      && typeof incarnation==='string' && incarnationPattern.test(incarnation)
      && typeof revision==='number' && Number.isSafeInteger(revision) && revision>=1;
  } catch { return false; }
}

export function isResourceResolutionCandidate(value: unknown): value is ResourceResolutionCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== 2 || !keys.includes('resourceId') || !keys.includes('purpose')) return false;
  if (typeof item.resourceId !== 'string' || !uuidPattern.test(item.resourceId)) return false;
  return item.purpose === 'required-add' || item.purpose === 'optional-read';
}

export function isResourceResolutionRequest(value: unknown): value is ResourceResolutionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(item).length !== 0) return false;
  const observation = Object.getOwnPropertyDescriptor(item, 'expectedAuthorityObservation');
  if (observation ? !observation.enumerable || !('value' in observation)
    || !isResourceAuthorityObservation(observation.value) : 'expectedAuthorityObservation' in item) return false;
  if (Object.keys(item).some(key => !['delegation','delegatedBody','source','candidates','continuation','expectedAuthorityObservation'].includes(key))) return false;
  if (typeof item.delegation !== 'string' || typeof item.delegatedBody !== 'string') return false;
  if (!Array.isArray(item.candidates) || item.candidates.length > MAX_RESOURCE_RESOLUTION_CANDIDATES) return false;
  if (!item.candidates.every(isResourceResolutionCandidate)) return false;
  if (item.source !== undefined) {
    if (!item.source || typeof item.source !== 'object' || Array.isArray(item.source)) return false;
    const source = item.source as Record<string, unknown>;
    if (Object.keys(source).some(key => !['kind','resourceId','epoch','sequence'].includes(key))) return false;
    if (!['file', 'folder', 'workspace'].includes(source.kind as string)) return false;
    if (source.resourceId !== undefined && (typeof source.resourceId !== 'string' || !uuidPattern.test(source.resourceId))) return false;
    if (source.epoch !== undefined && (!Number.isSafeInteger(source.epoch) || (source.epoch as number) < 0)) return false;
    if (source.sequence !== undefined && (!Number.isSafeInteger(source.sequence) || (source.sequence as number) < 0)) return false;
  }
  if (item.continuation !== undefined && (typeof item.continuation !== 'string' || item.continuation.length > 4096)) return false;
  return true;
}

export function isCanonicalCurrentReadResult(value: unknown): value is CanonicalCurrentReadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.resourceId !== 'string' || !uuidPattern.test(item.resourceId)) return false;
  if (Object.keys(item).sort().join(',') !== 'content,epoch,ownerAppId,resourceId,schemaId,schemaVersion,sequence') return false;
  if (typeof item.ownerAppId !== 'string' || !item.ownerAppId) return false;
  if (typeof item.schemaId !== 'string' || !item.schemaId) return false;
  if (!Number.isSafeInteger(item.schemaVersion) || (item.schemaVersion as number) < 1) return false;
  if (!Number.isSafeInteger(item.epoch) || (item.epoch as number) < 0) return false;
  if (!Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0) return false;
  if (typeof item.content !== 'string') return false;
  return true;
}

export function isResourceReadRequest(value: unknown): value is ResourceReadRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'contentProof,mode') return false;
  if (typeof item.contentProof !== 'string' || item.contentProof.length === 0 || item.contentProof.length > MAX_CONTENT_PROOF_BYTES) return false;
  return item.mode === 'metadata' || item.mode === 'bytes' || item.mode === 'native';
}

/** Pure transport validation; a DTO is never a resource permission. */
export function isResourceResolutionResponse(value: unknown): value is ResourceResolutionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(item).length !== 0) return false;
  const observation = Object.getOwnPropertyDescriptor(item, 'authorityObservation');
  if (observation ? !observation.enumerable || !('value' in observation)
    || !isResourceAuthorityObservation(observation.value) : 'authorityObservation' in item) return false;
  if (item.allowed === false) return Object.keys(item).join(',') === 'allowed';
  if (item.allowed !== true || Object.keys(item).sort().join(',') !== 'allowed,authorityObservation,results,source') return false;
  if (!observation) return false;
  if (!item.source || typeof item.source !== 'object' || Array.isArray(item.source)) return false;
  const source = item.source as Record<string, unknown>;
  if (Object.keys(source).some(key => !['kind','resourceId','policyVersion'].includes(key))
    || !['file','folder','workspace'].includes(String(source.kind)) || !Number.isSafeInteger(source.policyVersion) || Number(source.policyVersion)<0) return false;
  if (source.kind === 'workspace' ? Object.hasOwn(source,'resourceId') : typeof source.resourceId !== 'string' || !uuidPattern.test(source.resourceId)) return false;
  return Array.isArray(item.results) && item.results.length <= 100 && item.results.every(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Record<string, unknown>;
    if (typeof result.resourceId !== 'string' || !uuidPattern.test(result.resourceId)) return false;
    if (result.status === 'unavailable') return Object.keys(result).sort().join(',') === 'resourceId,status';
    if (result.status !== 'readable' || Object.keys(result).some(key => !['resourceId','status','metadata','policyVersion','contentProof'].includes(key))) return false;
    if (!Number.isSafeInteger(result.policyVersion) || Number(result.policyVersion)<0 || !result.metadata || typeof result.metadata !== 'object') return false;
    const metadata = result.metadata as Record<string, unknown>;
    return metadata.id === result.resourceId && ['file','folder'].includes(String(metadata.kind)) && typeof metadata.name === 'string'
      && Number.isSafeInteger(metadata.metadataVersion) && Number(metadata.metadataVersion)>=1
      && (result.contentProof === undefined || typeof result.contentProof === 'string' && result.contentProof.length <= MAX_CONTENT_PROOF_BYTES);
  });
}

export interface ResourceByteReadResult {resourceId: string; encoding: 'base64url'; content: string;}
export interface ResourceMetadataReadResult {resourceId: string; metadata: WorkspaceResource;}
export type ResourceReadResponse = ResourceByteReadResult | ResourceMetadataReadResult | CanonicalCurrentReadResult | ResourceResolutionUnavailableResult;
/** Provider obtains this current actor from Core's provider-proof callback before accessing its room. */
export interface CanonicalCurrentReadAuthorization {
  allowed: true;
  resourceId: string;
  ownerAppId: string;
  schemaId: string;
  schemaVersion: number;
  mimeType: string;
  epoch: number;
  authority: ContentAuthority;
  actor: {organizationId: string; workspaceId: string; actorId: string; principal: Principal; actions: ['file.read']};
}

export function isCanonicalCurrentReadAuthorization(value: unknown): value is CanonicalCurrentReadAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'actor,allowed,authority,epoch,mimeType,ownerAppId,resourceId,schemaId,schemaVersion') return false;
  if (item.allowed !== true) return false;
  if (typeof item.resourceId !== 'string' || !uuidPattern.test(item.resourceId)) return false;
  if (typeof item.ownerAppId !== 'string' || !item.ownerAppId) return false;
  if (typeof item.schemaId !== 'string' || !item.schemaId) return false;
  if (!Number.isSafeInteger(item.schemaVersion) || (item.schemaVersion as number) < 1) return false;
  if (typeof item.mimeType !== 'string' || !nativeMimePattern.test(item.mimeType)) return false;
  if (!Number.isSafeInteger(item.epoch) || (item.epoch as number) < 1) return false;

  if (!item.actor || typeof item.actor !== 'object' || Array.isArray(item.actor)) return false;
  const actor = item.actor as Record<string, unknown>;
  if (Object.keys(actor).sort().join(',') !== 'actions,actorId,organizationId,principal,workspaceId') return false;
  if (typeof actor.actorId !== 'string' || !actor.actorId) return false;
  if (typeof actor.organizationId !== 'string' || !actor.organizationId) return false;
  if (typeof actor.workspaceId !== 'string' || !actor.workspaceId) return false;
  if (!Array.isArray(actor.actions) || actor.actions.length !== 1 || actor.actions[0] !== 'file.read') return false;

  if (!actor.principal || typeof actor.principal !== 'object' || Array.isArray(actor.principal)) return false;
  const principal = actor.principal as Record<string, unknown>;
  if (Object.keys(principal).sort().join(',') !== 'displayName,email,id,provider') return false;
  if (typeof principal.id !== 'string' || !principal.id) return false;
  if (typeof principal.email !== 'string') return false;
  if (typeof principal.displayName !== 'string') return false;
  if (typeof principal.provider !== 'string' || !principal.provider) return false;

  if (!item.authority || typeof item.authority !== 'object' || Array.isArray(item.authority)) return false;
  const auth = item.authority as Record<string, unknown>;
  const authKeys = Object.keys(auth).sort();
  const hasLifecycle = authKeys.includes('lifecycleGeneration');
  const expectedAuthKeys = hasLifecycle
    ? 'epoch,initialized,lifecycleGeneration,metadata,organizationId,ownerAppId,projectedSequence,resourceId,schemaId,schemaVersion,seedHash,version,workspaceId'
    : 'epoch,initialized,metadata,organizationId,ownerAppId,projectedSequence,resourceId,schemaId,schemaVersion,seedHash,version,workspaceId';
  if (authKeys.join(',') !== expectedAuthKeys) return false;

  if (auth.version !== 1) return false;
  if (auth.resourceId !== item.resourceId) return false;
  if (auth.ownerAppId !== item.ownerAppId) return false;
  if (auth.schemaId !== item.schemaId) return false;
  if (auth.schemaVersion !== item.schemaVersion) return false;
  if (auth.epoch !== item.epoch) return false;
  if (auth.organizationId !== actor.organizationId) return false;
  if (auth.workspaceId !== actor.workspaceId) return false;
  if (typeof auth.seedHash !== 'string' || !seedHashPattern.test(auth.seedHash)) return false;
  if (typeof auth.initialized !== 'boolean') return false;
  if (!Number.isSafeInteger(auth.projectedSequence) || (auth.projectedSequence as number) < -1) return false;
  if (hasLifecycle && (!Number.isSafeInteger(auth.lifecycleGeneration) || (auth.lifecycleGeneration as number) < 1)) return false;

  if (!auth.metadata || typeof auth.metadata !== 'object' || Array.isArray(auth.metadata)) return false;
  const meta = auth.metadata as Record<string, unknown>;
  if (Object.keys(meta).sort().join(',') !== 'name,updatedAt,version') return false;
  if (typeof meta.name !== 'string' || !meta.name) return false;
  if (!Number.isSafeInteger(meta.version) || (meta.version as number) < 1) return false;
  if (typeof meta.updatedAt !== 'string' || !meta.updatedAt) return false;

  return true;
}

export interface ResourceListRequest {
  delegation: string;
  delegatedBody: string;
  afterId?: string; // canonical lowercase UUID; equality/progress input, never authority
  limit: number; // safe integer 1..100
  expectedAuthorityObservation?: ResourceAuthorityObservation;
}

export type ResourceListResponse = {
  allowed: true;
  source: { kind: 'folder'; resourceId: string; policyVersion: number }
    | { kind: 'workspace'; policyVersion: number };
  authorityObservation: ResourceAuthorityObservation;
  results: Array<{resourceId: string; metadata: WorkspaceResource; policyVersion: number}>;
  nextAfterId: string | null;
  exhausted: boolean;
} | {allowed: false};

export const RESOURCE_LIST_PATH = '/internal/resources/list';
export const MAX_RESOURCE_LIST_LIMIT = 100;
export const MAX_RESOURCE_LIST_REQUEST_BYTES = 65536; // 64 KiB
export const MAX_RESOURCE_LIST_RESPONSE_BYTES = 2097152; // 2 MiB

const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Inspect only own data properties; accessors and exotic containers are never DTOs.
function listRecord(value:unknown):Record<string,unknown>|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)return null;
  if(Object.getOwnPropertySymbols(value).length)return null;
  const descriptors=Object.getOwnPropertyDescriptors(value),record:Record<string,unknown>=Object.create(null);
  for(const [key,descriptor] of Object.entries(descriptors)) {
    if(!descriptor.enumerable||!('value' in descriptor))return null;
    record[key]=descriptor.value;
  }
  return record;
}
function listKeys(record:Record<string,unknown>,required:string[],optional:string[]=[]):boolean {
  return required.every(key=>Object.hasOwn(record,key))&&Object.keys(record).every(key=>required.includes(key)||optional.includes(key));
}
function listVersion(value:unknown,minimum=0):boolean {return typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum;}
function listUuid(value:unknown):value is string {return typeof value==='string'&&canonicalUuidPattern.test(value);}
export function isResourceListRequest(value:unknown):value is ResourceListRequest {
  try {
    const item=listRecord(value);
    return !!item&&listKeys(item,['delegation','delegatedBody','limit'],['afterId','expectedAuthorityObservation'])
      &&typeof item.delegation==='string'&&typeof item.delegatedBody==='string'
      &&listVersion(item.limit,1)&&Number(item.limit)<=MAX_RESOURCE_LIST_LIMIT
      &&(!Object.hasOwn(item,'afterId')||listUuid(item.afterId))
      &&(!Object.hasOwn(item,'expectedAuthorityObservation')||isResourceAuthorityObservation(item.expectedAuthorityObservation));
  }catch{return false;}
}
export function isResourceListResponse(value:unknown):value is ResourceListResponse {
  try {
    const item=listRecord(value);if(!item)return false;
    if(item.allowed===false)return listKeys(item,['allowed']);
    if(item.allowed!==true||!listKeys(item,['allowed','source','authorityObservation','results','nextAfterId','exhausted'])
      ||!isResourceAuthorityObservation(item.authorityObservation))return false;
    const source=listRecord(item.source);if(!source||!listVersion(source.policyVersion))return false;
    if(source.kind==='folder'){if(!listKeys(source,['kind','resourceId','policyVersion'])||!listUuid(source.resourceId))return false;}
    else if(source.kind==='workspace'){if(!listKeys(source,['kind','policyVersion']))return false;}else return false;
    if(typeof item.exhausted!=='boolean'||(item.nextAfterId!==null&&!listUuid(item.nextAfterId)))return false;
    if(!Array.isArray(item.results)||Object.getPrototypeOf(item.results)!==Array.prototype||item.results.length>MAX_RESOURCE_LIST_LIMIT
      ||Object.getOwnPropertySymbols(item.results).length)return false;
    const descriptors=Object.getOwnPropertyDescriptors(item.results);
    if(Object.keys(descriptors).length!==item.results.length+1)return false;
    let previous='';
    for(let index=0;index<item.results.length;index++) {
      const descriptor=descriptors[String(index)];if(!descriptor||!descriptor.enumerable||!('value' in descriptor))return false;
      const result=listRecord(descriptor.value);
      if(!result||!listKeys(result,['resourceId','metadata','policyVersion'])||!listUuid(result.resourceId)
        ||result.resourceId<=previous||!listVersion(result.policyVersion))return false;
      previous=result.resourceId;
      const metadata=listRecord(result.metadata);
      if(!metadata||!listKeys(metadata,['id','kind','name','parentId','mimeType','size','createdAt','updatedAt','createdBy','metadataVersion'],['organizationId','workspaceId'])
        ||metadata.id!==result.resourceId||(metadata.kind!=='file'&&metadata.kind!=='folder')||typeof metadata.name!=='string'
        ||(metadata.parentId!==null&&!listUuid(metadata.parentId))||(metadata.mimeType!==null&&typeof metadata.mimeType!=='string')
        ||!listVersion(metadata.size)||!listVersion(metadata.metadataVersion,1)
        ||typeof metadata.createdAt!=='string'||typeof metadata.updatedAt!=='string'||typeof metadata.createdBy!=='string'
        ||['organizationId','workspaceId'].some(key=>Object.hasOwn(metadata,key)&&(typeof metadata[key]!=='string'||!metadata[key])))return false;
    }
    return item.exhausted?item.nextAfterId===null:item.results.length>0&&item.nextAfterId===previous;
  }catch{return false;}
}
