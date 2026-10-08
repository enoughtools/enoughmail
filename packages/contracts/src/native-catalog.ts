import type { WorkspaceResource } from "./index";

/**
 * Current actor-scoped generic metadata. Opaque observations never grant access.
 */
export interface NativeCatalogResponse {
  resources: WorkspaceResource[];
  /** Opaque observation shared with workspace changes; no raw counter is exposed. */
  catalogRevision: string;
  nextCursor?: string;
}
