/** Server-verified scope. Never accept this identity from a browser message. */
export interface EntityRoomContext {
  organizationId: string;
  workspaceId: string;
  resourceId: string;
  actorId: string;
  displayName: string;
  policyVersion: number;
  expiresAt: number;
}

export interface EntityMetadata { name: string; version: number; updatedAt?: string }
/** These versions are independent of a document migration epoch or app release. */
export const FORMS_SCHEMA_ID = 'enough.forms.draft';
export const FORMS_SCHEMA_VERSION = 1;
export const ENTITY_PROTOCOL_VERSION = 1;
export interface EntitySchemaIdentity { schemaId: string; schemaVersion: number }
export interface EntityWireIdentity extends EntitySchemaIdentity { protocolVersion: number }
/** Missing fields exist only in the original v1 transport and persisted records. */
export interface EntityLegacyWireIdentity { schemaId?: string; schemaVersion?: number; protocolVersion?: number }
export interface EntitySnapshot {
  organizationId?: string;
  workspaceId?: string;
  resourceId: string;
  epoch: number;
  schemaId?: string;
  schemaVersion: number;
  sequence: number;
  document: Record<string, unknown>;
  /** Canonical CRDT state for initial hydration; publication pins need only JSON. */
  update?: string;
  metadata?: EntityMetadata;
}
export interface EntityPin extends EntitySnapshot { pinId: string; createdAt: string }
export interface EntityPresence {
  connectionId?: string;
  actorId: string;
  displayName: string;
  questionId?: string;
  field?: string;
  cursor?: { anchor: number; head: number };
}
export interface EntitySeed {
  resourceId: string;
  epoch: number;
  schemaId?: string;
  schemaVersion: number;
  document: Record<string, unknown>;
  metadata?: EntityMetadata;
}
export type EntityClientMessage =
  | ({ type: 'sync'; epoch: number; stateVector: string } & EntityLegacyWireIdentity)
  | ({ type: 'update'; epoch: number; operationId: string; update: string } & EntityLegacyWireIdentity)
  | ({ type: 'presence' } & Omit<EntityPresence, 'actorId' | 'displayName'>);

export type EntityServerMessage =
  | ({ type: 'hello'; epoch: number; sequence: number; update: string; connectionId?: string; actor: { id: string; displayName: string }; metadata?: EntityMetadata } & EntityLegacyWireIdentity)
  | ({ type: 'sync'; epoch: number; sequence: number; update: string } & EntityLegacyWireIdentity)
  | ({ type: 'ack'; operationId: string; sequence: number } & EntityLegacyWireIdentity)
  | { type: 'presence'; actors: EntityPresence[] }
  | { type: 'metadata'; metadata: EntityMetadata }
  | { type: 'invalidate' }
  | { type: 'error'; code: string; message: string };
