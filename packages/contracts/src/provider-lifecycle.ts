import { validateArtifactBegin, type ArtifactBegin } from './artifacts';
export const PROVIDER_LIFECYCLE_PROOF_HEADER = 'X-Open-Cloud-Provider-Lifecycle-Proof';
export const PROVIDER_LIFECYCLE_MAX_PAGE_BYTES = 256 * 1024;
export type ProviderLifecyclePhase = 'prepare' | 'drain-check' | 'complete-check' | 'abort' | 'restore-prepare' | 'restore-check' | 'restore-release';
export type ProviderLifecycleOperationKind = 'remove' | 'restore';
export type ProviderLifecycleSubstep = 'plan' | 'reserve' | 'inventory' | 'check' | 'release';
export interface ProviderLifecycleDescriptor { version: 1; handlerPath: '/internal/provider-lifecycle' }
export interface ProviderLifecycleAdminClaims {
 version: 1; kind: 'provider-lifecycle-admin'; issuer: 'open-cloud-core'; audience: string;
 organizationId: string; workspaceId: string; actorId: string; actions: ['workspace.manage'];
 operationId: string; operationKind: ProviderLifecycleOperationKind; phase: ProviderLifecyclePhase; callbackId: string; substep: ProviderLifecycleSubstep;
 requestHash: string; expectedLifecycleGeneration: number; policyVersion: number; membershipVersion: number;
 issuedAt: number; expiresAt: number;
}
export interface ProviderLifecycleEnvelope {
 version: 1; ownerAppId: string; organizationId: string; workspaceId: string; operationId: string;
 operationKind: ProviderLifecycleOperationKind; phase: ProviderLifecyclePhase; callbackId: string; substep: ProviderLifecycleSubstep;
 expectedLifecycleGeneration: number; requestHash: string; payload: Record<string, unknown>;
}
export interface ProviderLifecycleAuthorization {
 allowed: true; actorId: string; ownerAppId: string; organizationId: string; workspaceId: string;
 operationId: string; operationKind: ProviderLifecycleOperationKind; phase: ProviderLifecyclePhase; callbackId: string; substep: ProviderLifecycleSubstep;
 requestHash: string; lifecycleGeneration: number; policyVersion: number;
}
export interface ProviderLifecyclePlanReservation { operationId: string; manifestHash: string; manifest: ArtifactBegin }
export interface ProviderLifecycleInventoryReservation { setId: string; operationId: string; requestHash: string; manifestHash: string }
export interface ProviderLifecycleResource<R> { resourceId: string; historyWatermark: string; acceptedInventoryHash: string; reservations: R[] }
export interface ProviderLifecycleUnusedAnchor {resourceId:string;expectedAuthorityEpoch:number;expectedMetadataVersion:number;seedHash:string}
export interface ProviderLifecycleReport<R> {
 version: 1; ownerAppId: string; organizationId: string; workspaceId: string; operationId: string;
 requestHash: string; productFenceGeneration: number; productFenceReceiptHash: string;
 resources: ProviderLifecycleResource<R>[]; unusedAnchors?: ProviderLifecycleUnusedAnchor[]; unusedUnenrolledAnchors?: ProviderLifecycleUnusedUnenrolledAnchor[];deletedAnchors?:ProviderLifecycleDeletedAnchor[]; anchorScanHash?: string; nextCursor?: string;
}
export type ProviderLifecyclePlanPage = ProviderLifecycleReport<ProviderLifecyclePlanReservation>;
export type ProviderLifecycleInventoryPage = ProviderLifecycleReport<ProviderLifecycleInventoryReservation>;
export interface ProviderLifecycleAcknowledgement {
 version: 1; ownerAppId: string; organizationId: string; workspaceId: string; operationId: string;
 requestHash: string; productFenceGeneration: number; productFenceReceiptHash: string;
 ready: true; planHash?: string; inventoryHash?: string; nextCursor?: string;
}
export interface ProviderLifecycleStatus {
 operationId: string; state: 'active' | 'draining' | 'removed'; generation: number; expectedLifecycleGeneration: number; phase: string;
 readyToDrain: boolean; inventoryHash?: string; expectedReservationGeneration?: number; failureCode?: string;
}
export const lifecycleUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const lifecycleHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const lifecycleSeedHash = (v:unknown):v is string => typeof v==='string'&&/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v);
export const lifecycleScope = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
export const lifecycleOwner = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v) && v.length <= 64;
export const lifecycleInteger = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export function lifecycleRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
export function lifecycleKeys(v: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
 return required.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
}
const phase = (v: unknown) => typeof v === 'string' && ['prepare','drain-check','complete-check','abort','restore-prepare','restore-check','restore-release'].includes(v);
const substep = (v: unknown) => typeof v === 'string' && ['plan','reserve','inventory','check','release'].includes(v);
function phaseMatrix(kind:unknown,p:unknown,s:unknown):boolean {
 return kind==='remove' ? p==='prepare' && ['plan','reserve','inventory'].includes(s as string) || ['drain-check','complete-check'].includes(p as string)&&s==='check' || p==='abort'&&s==='release'
 : kind==='restore' && (p==='restore-prepare'&&s==='check' || p==='restore-check'&&['inventory','check'].includes(s as string) || p==='restore-release'&&s==='release' || p==='abort'&&s==='release');
}
export function isProviderLifecycleDescriptor(v: unknown): v is ProviderLifecycleDescriptor {
 return lifecycleRecord(v) && lifecycleKeys(v,['version','handlerPath']) && v.version === 1 && v.handlerPath === '/internal/provider-lifecycle';
}
export function isProviderLifecycleAdminClaims(v: unknown): v is ProviderLifecycleAdminClaims {
 return lifecycleRecord(v) && lifecycleKeys(v,['version','kind','issuer','audience','organizationId','workspaceId','actorId','actions','operationId','operationKind','phase','callbackId','substep','requestHash','expectedLifecycleGeneration','policyVersion','membershipVersion','issuedAt','expiresAt'])
 && v.version === 1 && v.kind === 'provider-lifecycle-admin' && v.issuer === 'open-cloud-core' && lifecycleOwner(v.audience)
 && lifecycleScope(v.organizationId) && lifecycleScope(v.workspaceId) && lifecycleScope(v.actorId)
 && Array.isArray(v.actions) && v.actions.length === 1 && v.actions[0] === 'workspace.manage'
 && lifecycleUuid(v.operationId) && lifecycleUuid(v.callbackId) && phase(v.phase) && substep(v.substep) && phaseMatrix(v.operationKind,v.phase,v.substep) && lifecycleHash(v.requestHash)
 && lifecycleInteger(v.expectedLifecycleGeneration) && lifecycleInteger(v.policyVersion) && lifecycleInteger(v.membershipVersion)
 && Number.isSafeInteger(v.issuedAt) && Number(v.issuedAt) >= 0 && Number.isSafeInteger(v.expiresAt)
 && Number(v.expiresAt) > Number(v.issuedAt) && Number(v.expiresAt) - Number(v.issuedAt) <= 300;
}
export function isProviderLifecycleEnvelope(v: unknown): v is ProviderLifecycleEnvelope {
 return lifecycleRecord(v) && lifecycleKeys(v,['version','ownerAppId','organizationId','workspaceId','operationId','operationKind','phase','callbackId','substep','expectedLifecycleGeneration','requestHash','payload'])
 && v.version === 1 && lifecycleOwner(v.ownerAppId) && lifecycleScope(v.organizationId) && lifecycleScope(v.workspaceId)
 && lifecycleUuid(v.operationId) && lifecycleUuid(v.callbackId) && phase(v.phase) && substep(v.substep) && phaseMatrix(v.operationKind,v.phase,v.substep)
 && lifecycleInteger(v.expectedLifecycleGeneration) && lifecycleHash(v.requestHash) && lifecycleRecord(v.payload);
}
function report(v: unknown, reservation: (v: unknown) => boolean): boolean {
 if (!lifecycleRecord(v) || !lifecycleKeys(v,['version','ownerAppId','organizationId','workspaceId','operationId','requestHash','productFenceGeneration','productFenceReceiptHash','resources'],['nextCursor','unusedAnchors','unusedUnenrolledAnchors','anchorScanHash','deletedAnchors'])
 || v.version !== 1 || !lifecycleOwner(v.ownerAppId) || !lifecycleScope(v.organizationId) || !lifecycleScope(v.workspaceId) || !lifecycleUuid(v.operationId)
 || !lifecycleHash(v.requestHash) || !lifecycleInteger(v.productFenceGeneration) || !lifecycleHash(v.productFenceReceiptHash)
 || ('nextCursor' in v && (typeof v.nextCursor !== 'string' || !v.nextCursor.length || v.nextCursor.length > 256))
 || ('anchorScanHash'in v&&!lifecycleHash(v.anchorScanHash)) || (!('nextCursor'in v)&&!lifecycleHash(v.anchorScanHash))
 || !Array.isArray(v.resources) || v.resources.length > 100) return false;
 const unused=v.unusedAnchors??[];if(!Array.isArray(unused)||unused.length+v.resources.length>100)return false;
 const unusedIds=new Set<string>();for(const anchor of unused){if(!lifecycleRecord(anchor)||!lifecycleKeys(anchor,['resourceId','expectedAuthorityEpoch','expectedMetadataVersion','seedHash'])||!lifecycleUuid(anchor.resourceId)||unusedIds.has(anchor.resourceId)||!lifecycleInteger(anchor.expectedAuthorityEpoch)||!lifecycleInteger(anchor.expectedMetadataVersion)||!lifecycleSeedHash(anchor.seedHash))return false;unusedIds.add(anchor.resourceId);}
 const unenrolled=v.unusedUnenrolledAnchors??[];if(!Array.isArray(unenrolled)||unenrolled.length+unused.length+v.resources.length>100)return false;
 for(const anchor of unenrolled){if(!lifecycleRecord(anchor)||!lifecycleKeys(anchor,['resourceId','expectedMetadataVersion','objectIdentityHash','byteLength'])||!lifecycleUuid(anchor.resourceId)||unusedIds.has(anchor.resourceId)||!lifecycleInteger(anchor.expectedMetadataVersion)||!lifecycleHash(anchor.objectIdentityHash)||!Number.isSafeInteger(anchor.byteLength)||Number(anchor.byteLength)<0)return false;unusedIds.add(anchor.resourceId);}
 const deleted=v.deletedAnchors??[];if(!Array.isArray(deleted)||deleted.length+unenrolled.length+unused.length+v.resources.length>100)return false;
 for(const a of deleted){if(!lifecycleRecord(a)||!lifecycleKeys(a,['resourceId','expectedAuthorityEpoch','expectedMetadataVersion','seedHash','discardedStateHash','historyWatermark','retainedAcceptedHistoryAbsent','checkpointContentAbsent','escrowAbsent','outboxAbsent','pendingDerivedAbsent'],['discardReceipt'])||!lifecycleUuid(a.resourceId)||unusedIds.has(a.resourceId)||!lifecycleInteger(a.expectedAuthorityEpoch)||!lifecycleInteger(a.expectedMetadataVersion)||!lifecycleSeedHash(a.seedHash)||!lifecycleHash(a.discardedStateHash)||typeof a.historyWatermark!=='string'||!a.historyWatermark.length||a.historyWatermark.length>256||a.retainedAcceptedHistoryAbsent!==true||a.checkpointContentAbsent!==true||a.escrowAbsent!==true||a.outboxAbsent!==true||a.pendingDerivedAbsent!==true)return false;
 if('discardReceipt'in a){const r=a.discardReceipt;if(!lifecycleRecord(r)||!lifecycleKeys(r,['operationId','requestHash','revision','preDeleteMetadataVersion'])||typeof r.operationId!=='string'||!r.operationId.length||r.operationId.length>128||!lifecycleHash(r.requestHash)||!Number.isSafeInteger(r.revision)||Number(r.revision)<0||!lifecycleInteger(r.preDeleteMetadataVersion)||a.expectedMetadataVersion<r.preDeleteMetadataVersion+1)return false;}
 unusedIds.add(a.resourceId);}
 let count = 0; const ids = new Set<string>();
 for (const r of v.resources) {
  if (!lifecycleRecord(r) || !lifecycleKeys(r,['resourceId','historyWatermark','acceptedInventoryHash','reservations']) || !lifecycleUuid(r.resourceId)
  || ids.has(r.resourceId) || unusedIds.has(r.resourceId) || typeof r.historyWatermark !== 'string' || !r.historyWatermark.length || r.historyWatermark.length > 256
  || !lifecycleHash(r.acceptedInventoryHash) || !Array.isArray(r.reservations) || r.reservations.length > 800 || !r.reservations.every(reservation)) return false;
  ids.add(r.resourceId); count += r.reservations.length;
 }
 return count <= 800;
}
export function isProviderLifecyclePlanPage(v: unknown): v is ProviderLifecyclePlanPage {
 return report(v, r => lifecycleRecord(r) && lifecycleKeys(r,['operationId','manifestHash','manifest']) && lifecycleUuid(r.operationId)
 && lifecycleHash(r.manifestHash) && validateArtifactBegin(r.manifest) && lifecycleInteger(r.manifest.expectedMetadataVersion) && r.manifest.operationId === r.operationId);
}
export function isProviderLifecycleInventoryPage(v: unknown): v is ProviderLifecycleInventoryPage {
 return report(v, r => lifecycleRecord(r) && lifecycleKeys(r,['setId','operationId','requestHash','manifestHash'])
 && lifecycleUuid(r.setId) && lifecycleUuid(r.operationId) && lifecycleHash(r.requestHash) && lifecycleHash(r.manifestHash));
}
export function isProviderLifecycleAcknowledgement(v: unknown): v is ProviderLifecycleAcknowledgement {
 return lifecycleRecord(v) && lifecycleKeys(v,['version','ownerAppId','organizationId','workspaceId','operationId','requestHash','productFenceGeneration','productFenceReceiptHash','ready'],['planHash','inventoryHash','nextCursor'])
 && v.version === 1 && lifecycleOwner(v.ownerAppId) && lifecycleScope(v.organizationId) && lifecycleScope(v.workspaceId) && lifecycleUuid(v.operationId)
 && lifecycleHash(v.requestHash) && lifecycleInteger(v.productFenceGeneration) && lifecycleHash(v.productFenceReceiptHash) && v.ready === true
 && (!('planHash' in v) || lifecycleHash(v.planHash)) && (!('inventoryHash' in v) || lifecycleHash(v.inventoryHash))
 && (!('nextCursor' in v) || typeof v.nextCursor === 'string' && v.nextCursor.length > 0 && v.nextCursor.length <= 256);
}

/** Operational catalog metadata; this DTO grants no financial read authority. */
export type ProviderLifecycleNativeAnchor = {
 kind:'live';resourceId:string;mimeType:string;metadataVersion:number;
 authority?:{epoch:number;initialized:boolean;projectedSequence:number;seedHash:string};unenrolled?:{objectIdentityHash:string;byteLength:number};
}|{kind:'deleted-authority';resourceId:string;metadataVersion:number;authority:{epoch:number;initialized:boolean;projectedSequence:number;seedHash:string}};
export interface ProviderLifecycleDeletedAnchor {
 resourceId:string;expectedAuthorityEpoch:number;expectedMetadataVersion:number;seedHash:string;discardedStateHash:string;historyWatermark:string;
 retainedAcceptedHistoryAbsent:true;checkpointContentAbsent:true;escrowAbsent:true;outboxAbsent:true;pendingDerivedAbsent:true;
 discardReceipt?:{operationId:string;requestHash:string;revision:number;preDeleteMetadataVersion:number};
}
export interface ProviderLifecycleAnchorRequest {envelope:ProviderLifecycleEnvelope;cursor?:string;limit?:number}
export interface ProviderLifecycleAnchorPage {
 version:1;ownerAppId:string;organizationId:string;workspaceId:string;operationId:string;
 callbackId:string;requestHash:string;catalogSequence:number;anchors:ProviderLifecycleNativeAnchor[];
 nextCursor?:string;scanHash?:string;
}
export interface ProviderLifecycleUnusedUnenrolledAnchor {
 resourceId:string;expectedMetadataVersion:number;objectIdentityHash:string;byteLength:number;
}
// ProviderLifecycleReport additionally REQUIRES anchorScanHash:string;
// optional unusedUnenrolledAnchors share the existing aggregate 100-anchor report page bound.

export interface ProviderLifecycleRestoreReportPage {
 version:1;ownerAppId:string;organizationId:string;workspaceId:string;operationId:string;requestHash:string;
 inventoryHash:string;reportHash:string;productFenceGeneration:number;productFenceReceiptHash:string;
 restoredRootCount:number;restoredResourceCount:number;pendingAcceptedWorkCount:number;
 resources:{resourceId:string;checkpointId:string;rootOperationId:string;rootRequestHash:string;rootSha256:string;historyWatermark:string;restoredDomainVersion:number;restorationDigest:string}[];
 requiredResources:{resourceId:string}[];unusedAnchors?:{resourceId:string;sourceIdentityHash:string;restorationDigest:string}[];deletedAnchors?:{resourceId:string;discardedStateHash:string;historyWatermark:string;restorationDigest:string}[];preservedDeletedCount?:number;nextCursor?:string;
}
export function isProviderLifecycleRestoreReportPage(v:unknown):v is ProviderLifecycleRestoreReportPage {
 if(!lifecycleRecord(v)||!lifecycleKeys(v,['version','ownerAppId','organizationId','workspaceId','operationId','requestHash','inventoryHash','reportHash','productFenceGeneration','productFenceReceiptHash','restoredRootCount','restoredResourceCount','pendingAcceptedWorkCount','resources','requiredResources'],['nextCursor','unusedAnchors','deletedAnchors','preservedDeletedCount'])||!lifecycleOwner(v.ownerAppId)||!lifecycleScope(v.organizationId)||!lifecycleScope(v.workspaceId)||!lifecycleUuid(v.operationId)||!lifecycleHash(v.requestHash)||v.version!==1||!lifecycleHash(v.inventoryHash)||!lifecycleHash(v.reportHash)||!lifecycleInteger(v.productFenceGeneration)||!lifecycleHash(v.productFenceReceiptHash)||!Array.isArray(v.resources)||v.resources.length>100||!Array.isArray(v.requiredResources)||v.requiredResources.length>200||v.pendingAcceptedWorkCount!==0)return false;
 if(![v.restoredRootCount,v.restoredResourceCount].every(x=>Number.isSafeInteger(x)&&Number(x)>=0)||('nextCursor'in v&&(typeof v.nextCursor!=='string'||!v.nextCursor.length||v.nextCursor.length>256)))return false;
 const ids=new Set<string>();for(const r of v.resources){if(!lifecycleRecord(r)||!lifecycleKeys(r,['resourceId','checkpointId','rootOperationId','rootRequestHash','rootSha256','historyWatermark','restoredDomainVersion','restorationDigest'])||!lifecycleUuid(r.resourceId)||ids.has(r.resourceId)||!lifecycleUuid(r.checkpointId)||!lifecycleUuid(r.rootOperationId)||!lifecycleHash(r.rootRequestHash)||!lifecycleHash(r.rootSha256)||!lifecycleHash(r.restorationDigest)||typeof r.historyWatermark!=='string'||!r.historyWatermark.length||r.historyWatermark.length>256||!Number.isSafeInteger(r.restoredDomainVersion)||Number(r.restoredDomainVersion)<0)return false;ids.add(r.resourceId);}
 const unused=v.unusedAnchors??[];if(!Array.isArray(unused)||unused.length+v.resources.length>100||!unused.every(r=>lifecycleRecord(r)&&lifecycleKeys(r,['resourceId','sourceIdentityHash','restorationDigest'])&&lifecycleUuid(r.resourceId)&&(lifecycleHash(r.sourceIdentityHash)||lifecycleSeedHash(r.sourceIdentityHash))&&lifecycleHash(r.restorationDigest)))return false;
 for(const r of unused){if(ids.has(r.resourceId))return false;ids.add(r.resourceId);}
 const deleted=v.deletedAnchors??[];if(!Array.isArray(deleted)||deleted.length+unused.length+v.resources.length>100||!Number.isSafeInteger(v.preservedDeletedCount??0)||Number(v.preservedDeletedCount??0)<0)return false;for(const r of deleted){if(!lifecycleRecord(r)||!lifecycleKeys(r,['resourceId','discardedStateHash','historyWatermark','restorationDigest'])||!lifecycleUuid(r.resourceId)||ids.has(r.resourceId)||!lifecycleHash(r.discardedStateHash)||!lifecycleHash(r.restorationDigest)||typeof r.historyWatermark!=='string'||!r.historyWatermark.length||r.historyWatermark.length>256)return false;ids.add(r.resourceId);}
 return v.requiredResources.every(r=>lifecycleRecord(r)&&lifecycleKeys(r,['resourceId'])&&lifecycleUuid(r.resourceId));
}

/** Operational provenance only: no object locators, byte credentials or read authority. */
export interface ProviderLifecycleRestoreSourcesRequest {envelope:ProviderLifecycleEnvelope;cursor?:string;limit?:number}
export type ProviderLifecycleRestoreSourceRecord =
 | {kind:'plan-anchor'|'inventory-anchor';anchor:ProviderLifecycleNativeAnchor}
 | {kind:'checkpoint';resourceId:string;setId:string;reservationOperationId:string;requestHash:string;manifestHash:string;historyWatermark:string;acceptedInventoryHash:string;manifest:ArtifactBegin;receipt:import('./artifacts').ArtifactReceipt}
 | {kind:'deleted-marker';resourceId:string;discardedStateHash:string;historyWatermark:string;authorityEpoch:number;metadataVersion:number;seedHash:string;checkpointContentAbsent:true};
export interface ProviderLifecycleRestoreSourcesPage {
 version:1;ownerAppId:string;organizationId:string;workspaceId:string;operationId:string;callbackId:string;requestHash:string;
 sourceLifecycleOperationId:string;inventoryHash:string;receiptHash:string;removedGeneration:number;sourceProductFenceGeneration:number;sourceProductFenceReceiptHash:string;anchorScanHash:string;
 checkpointPrivacyScope:{scanId:string;scanHash:string;catalogSequence:number;ownerAppId:string;operationId:string};
 records:ProviderLifecycleRestoreSourceRecord[];nextCursor?:string;
}
