export * from './collaboration';

export * from './policy';

import { appMcpActions, isAppMcpTool, isAppMcpToolV2, type AppMcpTool, type AppMcpToolV2 } from './mcp';
import { isProductPolicyAction, type ProductPolicyAction } from './policy';
import { isContentAuthorityDescriptor, type ContentAuthorityDescriptor } from './content-authority';
import { isRevisionProviderDescriptor, type RevisionProviderDescriptor } from './revisions';
export * from './content-authority';
export * from './revisions';
export * from './artifacts';
export * from './native-catalog';
export * from './native-resource';
export * from './provider-lifecycle';
import { isNativeResourceDescriptor, type NativeResourceDescriptor } from './native-resource';
export * from './mcp';

/** The public, deploy-time description of an optional Enough Tools application. */
export interface AppManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  icon?: string;
  capabilities: string[];
  embeds: AppEmbed[];
  /** Files this installed app can open and, optionally, create in the workspace. */
  fileHandlers?: FileHandler[];
  /** Product-defined entities independent of file content and folder inheritance. */
  nativeResources?: NativeResourceDescriptor[];
  /** Product-owned actions automatically registered with the installed manifest. */
  permissions?: ProductPolicyAction[];
  /** App-owned native content authority, automatically selected when installed. */
  contentAuthority?: ContentAuthorityDescriptor;
  /** App-owned native revision provider for snapshots and retention. */
  revisionProvider?: RevisionProviderDescriptor;
  /** Allow trusted HTML preview frames to load blob: resources when served by Core. */
  htmlBlobFrames?: true;
  /** Tools exposed only through the central, actor-scoped MCP gateway. */
  mcp?: { version: 1; tools: AppMcpTool[] } | { version: 2; tools: AppMcpToolV2[] };
}

export interface FileHandler {
  id: string;
  name: string;
  /** Exact MIME types or a type wildcard such as text/*. */
  mimeTypes: string[];
  /** App-relative route. The workspace adds fileId as a query parameter. */
  openPath: string;
  embedPath?: string;
  create?: {
    mimeType: string;
    name: string;
    /** Initial file contents; at most 16 KiB of UTF-8. */
    initialContent: string;
  };
}

/** Shared workspace metadata. App Workers consume these files through Core. */
export interface WorkspaceResource {
  id: string;
  kind: "file" | "folder";
  name: string;
  parentId: string | null;
  mimeType: string | null;
  size: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  organizationId?: string;
  workspaceId?: string;
  metadataVersion?: number;
}

export interface WorkspaceFilesResponse {
  files: WorkspaceResource[];
  nextCursor: string | null;
  folder: WorkspaceResource | null;
}

export interface WorkspaceFileResponse {
  file: WorkspaceResource;
}

export interface AppEmbed {
  kind: string;
  name: string;
  /** A path inside the application's mount point. */
  path: string;
}

/** A manifest selected for this deployment and connected by a service binding. */
export interface RegisteredApp extends AppManifest {
  binding: string;
}

/** Identity providers must produce this provider-neutral principal. */
export interface Principal {
  id: string;
  email: string;
  displayName: string;
  provider: string;
}

export interface SessionResponse {
  user: Principal;
}

export interface StatusResponse {
  appId: string;
  status: "scaffold";
  features: {
    editing: false;
    persistence: boolean;
  };
  message: string;
}

const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mimeTypePattern = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;
const mimePattern = /^[a-z0-9!#$&^_.+-]{1,127}\/(?:[a-z0-9!#$&^_.+-]{1,127}|\*)$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function isWorkspaceResourceId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function isWorkspaceResourceName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim();
  const validUnicode = new TextDecoder().decode(new TextEncoder().encode(name)) === name;
  return name.length > 0 && [...name].length <= 255 && validUnicode && name !== "." && name !== ".." && !/[\/\\\p{Cc}]/u.test(name);
}

/** Declared routes use literal segments, without query strings or templates. */
export function isAppRelativePath(value: unknown): value is string {
  return typeof value === "string" && /^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?)?$/.test(value);
}

export function mimeTypeMatches(pattern: string, mimeType: string): boolean {
  return mimePattern.test(pattern) && mimeTypePattern.test(mimeType)
    && (pattern === mimeType || (pattern.endsWith("/*") && pattern.split("/", 1)[0] === mimeType.split("/", 1)[0]));
}

export function isFileHandler(value: unknown): value is FileHandler {
  if (!isRecord(value) || !isNonemptyString(value.id) || !identifierPattern.test(value.id) || value.id.length > 40
    || !isNonemptyString(value.name) || !Array.isArray(value.mimeTypes) || !value.mimeTypes.length
    || !value.mimeTypes.every((mime) => typeof mime === "string" && mimePattern.test(mime))
    || new Set(value.mimeTypes).size !== value.mimeTypes.length || !isAppRelativePath(value.openPath)
    || (value.embedPath !== undefined && (!isAppRelativePath(value.embedPath) || !value.embedPath.startsWith("/embed/")))) {
    return false;
  }
  if (value.create !== undefined) {
    const create = value.create;
    if (!isRecord(create) || typeof create.mimeType !== "string" || !mimeTypePattern.test(create.mimeType)
      || !isWorkspaceResourceName(create.name) || typeof create.initialContent !== "string"
      || new TextEncoder().encode(create.initialContent).byteLength > 16_384
      || !value.mimeTypes.some((mime: string) => mimeTypeMatches(mime, create.mimeType as string))) return false;
  }
  return true;
}

/** Guards discovery and the deploy-time registry at their trust boundaries. */
export function isAppManifest(value: unknown): value is AppManifest {
  return isRecord(value) && typeof value.id === "string" && identifierPattern.test(value.id) && value.id.length <= 40
    && value.id !== "core" && isNonemptyString(value.name) && isNonemptyString(value.description) && isNonemptyString(value.version)
    && (value.icon === undefined || isNonemptyString(value.icon))
    && Array.isArray(value.capabilities) && value.capabilities.every(isNonemptyString)
    && new Set(value.capabilities).size === value.capabilities.length
    && Array.isArray(value.embeds) && value.embeds.every((embed: unknown) =>
      isRecord(embed) && isNonemptyString(embed.kind) && isNonemptyString(embed.name)
      && isAppRelativePath(embed.path) && embed.path.startsWith("/embed/"))
    && new Set(value.embeds.map((embed) => embed.kind)).size === value.embeds.length
    && (value.fileHandlers === undefined || (Array.isArray(value.fileHandlers) && value.fileHandlers.every(isFileHandler)
      && new Set(value.fileHandlers.map((handler) => handler.id)).size === value.fileHandlers.length))
    && (value.htmlBlobFrames === undefined || value.htmlBlobFrames === true)
    && (value.nativeResources === undefined || (Array.isArray(value.nativeResources) && value.nativeResources.length <= 16
      && value.nativeResources.every(item => isNativeResourceDescriptor(item, value.id as string))
      && new Set(value.nativeResources.map(item => item.resourceType)).size === value.nativeResources.length))
    && (value.permissions === undefined || (Array.isArray(value.permissions) && value.permissions.length <= 32
      && value.permissions.every((action) => isProductPolicyAction(action, value.id as string))
      && new Set(value.permissions.map((action) => action.id)).size === value.permissions.length))
    && (value.contentAuthority === undefined || (isContentAuthorityDescriptor(value.contentAuthority)
      && value.capabilities.includes('workspace:collaboration')
      && value.contentAuthority.mimeTypes.every(mime => (value.fileHandlers as FileHandler[] | undefined)?.some(handler => handler.mimeTypes.includes(mime)))))
    && (value.revisionProvider === undefined || (isRevisionProviderDescriptor(value.revisionProvider)
      && value.capabilities.includes('workspace:revisions')
      && value.contentAuthority !== undefined && isContentAuthorityDescriptor(value.contentAuthority)
      && value.revisionProvider.mimeTypes.every(mime =>
        (value.contentAuthority as ContentAuthorityDescriptor).mimeTypes.includes(mime)
        && (value.fileHandlers as FileHandler[] | undefined)?.some(handler => handler.mimeTypes.includes(mime)))))
    && (value.mcp === undefined || (isRecord(value.mcp) && Array.isArray(value.mcp.tools)
      && value.capabilities.includes('workspace:mcp') && value.mcp.tools.length <= 32
      && ((value.mcp.version === 1
        && value.mcp.tools.every((tool) => isAppMcpTool(tool, value.id as string, appMcpActions({ permissions: value.permissions as ProductPolicyAction[] | undefined, nativeResources: value.nativeResources as NativeResourceDescriptor[] | undefined })))
        && value.mcp.tools.every(tool => tool.resourceArgument !== 'resourceId' ||
          (value.nativeResources as NativeResourceDescriptor[] | undefined)?.some(descriptor =>
            descriptor.resourceType === tool.resourceType && tool.actions.every(action => descriptor.actions.includes(action)))))
        || (value.mcp.version === 2 && Object.keys(value.mcp).every(key => ['version', 'tools'].includes(key))
          && value.mcp.tools.every(tool => isAppMcpToolV2(tool, value.id as string,
            (value.permissions as ProductPolicyAction[] | undefined)?.map(permission => permission.id) ?? []))))
      && new Set(value.mcp.tools.map((tool) => tool.name)).size === value.mcp.tools.length));
}

export function isWorkspaceResource(value: unknown): value is WorkspaceResource {
  if (!isRecord(value) || !isWorkspaceResourceId(value.id) || (value.kind !== "file" && value.kind !== "folder")
    || !isNonemptyString(value.name) || !(value.parentId === null || isWorkspaceResourceId(value.parentId))
    || !Number.isSafeInteger(value.size) || (value.size as number) < 0
    || !isNonemptyString(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))
    || !isNonemptyString(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))
    || !isNonemptyString(value.createdBy)
    || (value.organizationId !== undefined && !isNonemptyString(value.organizationId))
    || (value.workspaceId !== undefined && !isNonemptyString(value.workspaceId))
    || (value.metadataVersion !== undefined && (!Number.isSafeInteger(value.metadataVersion) || Number(value.metadataVersion) < 1))) return false;
  return value.kind === "folder" ? value.mimeType === null && value.size === 0
    : typeof value.mimeType === "string" && mimeTypePattern.test(value.mimeType);
}

/** Decode deployment-owned registry transport before consumers validate its manifests. */
export function decodeRegistryBindings(env: { OPEN_CLOUD_REGISTRY?: string; [binding: string]: unknown }): string | undefined {
  const encoder = new TextEncoder();
  const count = env.OPEN_CLOUD_REGISTRY_PART_COUNT;
  const hasCount = Object.hasOwn(env, 'OPEN_CLOUD_REGISTRY_PART_COUNT');
  const keys = Object.keys(env).filter((key) => key.startsWith('OPEN_CLOUD_REGISTRY_PART_') && key !== 'OPEN_CLOUD_REGISTRY_PART_COUNT');
  let text = env.OPEN_CLOUD_REGISTRY;
  if (text === undefined && !hasCount && !keys.length) return undefined;
  if (typeof text !== 'string') throw new Error('Invalid deployment registry');
  if (!hasCount) {
    if (keys.length || encoder.encode(text).length > 32 * 4096) throw new Error('Invalid deployment registry');
  } else {
    if (typeof count !== 'string' || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(count) || text !== '') throw new Error('Invalid deployment registry');
    const length = Number(count);
    if (keys.length !== length) throw new Error('Invalid deployment registry');
    const parts: string[] = [];
    for (let index = 0; index < length; index++) {
      const key = `OPEN_CLOUD_REGISTRY_PART_${index}`;
      const part = env[key];
      if (!Object.hasOwn(env, key) || typeof part !== 'string' || !part || encoder.encode(part).length > 4096) throw new Error('Invalid deployment registry');
      // Reject a surrogate split at a chunk boundary, including malformed pairs.
      for (let offset = 0; offset < part.length; offset++) {
        const unit = part.charCodeAt(offset);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = part.charCodeAt(++offset);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid deployment registry');
        } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('Invalid deployment registry');
      }
      parts.push(part);
    }
    text = parts.join('');
    if (encoder.encode(text).length > 32 * 4096) throw new Error('Invalid deployment registry');
  }
  return text;
}
export * from './resource-operations';
export * from './resource-delete-fence';
export * from './resource-resolution';
