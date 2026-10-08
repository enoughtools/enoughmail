export interface RevisionProviderDescriptor {
  version: 1;
  mimeTypes: string[];
  handlerPath: '/internal/revisions';
}

export const REVISION_PROVIDER_VERSION = 1;
export const REVISION_PROVIDER_HANDLER_PATH = '/internal/revisions';

export interface RetainedRevision {
  snapshotId: string;
  sourceFileId: string;
  revisionId: string;
  /** Lowercase SHA-256 64-character hexadecimal digest of the retained content. */
  contentHash: string;
  capturedAt: string;
  content: string;
  mediaType: string;
}

export interface RetainedRevisionStatus {
  snapshotId: string;
  sourceFileId: string;
  revisionId: string;
  currentRevisionId: string | null;
  availability: 'available' | 'unavailable';
  changed: boolean | null;
}

export interface RevisionProviderRequest {
  operation: 'capture' | 'read' | 'status';
  sourceFileId: string;
  consumerResourceId: string;
  operationId?: string;
  snapshotId?: string;
  expectedRevisionId?: string;
}

export function isRevisionProviderDescriptor(value: unknown): value is RevisionProviderDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 3
    && Object.keys(item).every((key) => ['version', 'mimeTypes', 'handlerPath'].includes(key))
    && item.version === 1
    && item.handlerPath === '/internal/revisions'
    && Array.isArray(item.mimeTypes)
    && item.mimeTypes.length >= 1
    && item.mimeTypes.length <= 16
    && item.mimeTypes.every((mime) => typeof mime === 'string' && /^application\/vnd\.[a-z0-9][a-z0-9.+_-]*\+json$/.test(mime))
    && new Set(item.mimeTypes).size === item.mimeTypes.length;
}
