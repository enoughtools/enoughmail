import {
  isAppManifest, isAppRelativePath, isFileHandler, isWorkspaceResource, isWorkspaceResourceId, mimeTypeMatches,
  parseResourceOperationDelegatedRequest, parseResourceOperationOutcome,
  type AppManifest, type FileHandler, type Principal, type SessionResponse, type WorkspaceResource, type WorkspaceFilesResponse,
  type ResourceOperationDelegatedRequest, type ResourceOperationDelegatedProposal, type ResourceOperationOutcome,
} from "@open-cloud/contracts";
import { prepareResourceOperationHelper, executeResourceDeleteHelper, executeResourceNativeHelper, executeResourceUploadHelper, getResourceOperationHelper } from './resource-operations';
export { subscribeWorkspaceChanges } from './live-files';

export class APIClientError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
    this.name = "APIClientError";
  }
}

const appIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

function validId(id: string): void {
  if (!isString(id) || !appIdPattern.test(id)) throw new APIClientError(400, "invalid_app_id");
}

function validPath(path: string): void {
  if (!isString(path)) throw new APIClientError(400, "invalid_app_path");
  const pathname = path.split("?", 1)[0] ?? "";
  if (!path.startsWith("/") || pathname.includes("//") || /[\\#\u0000-\u0020]/.test(path)
    || /%(?:2e|2f|5c|25)/i.test(pathname)) {
    throw new APIClientError(400, "invalid_app_path");
  }
  try {
    if (decodeURIComponent(pathname).split("/").some((part) => part === "." || part === "..")) {
      throw new Error("Path traversal");
    }
  } catch {
    throw new APIClientError(400, "invalid_app_path");
  }
}

function isPrincipal(value: unknown): value is Principal {
  return isRecord(value) && [value.id, value.email, value.displayName, value.provider].every(isString);
}

function validResourceId(id: string): void {
  if (!isWorkspaceResourceId(id)) throw new APIClientError(400, "invalid_file_id");
}

function validParentId(parentId: string | null | undefined): void {
  if (parentId !== undefined && parentId !== null) validResourceId(parentId);
}

/** Find handlers declared by the supplied deployment discovery result. */
export function fileHandlersFor(apps: AppManifest[], mimeType: string): { app: AppManifest; handler: FileHandler }[] {
  return apps.flatMap((app) => (app.fileHandlers ?? [])
    .filter((handler) => isFileHandler(handler) && handler.mimeTypes.some((pattern) => mimeTypeMatches(pattern, mimeType)))
    .map((handler) => ({ app, handler })));
}

/** Open one workspace file with a route declared by an installed application. */
export function resourceAppUrl(app: AppManifest, handlerId: string, fileId: string, mode: "open" | "embed" = "open"): string {
  validId(app.id);
  validResourceId(fileId);
  const handler = app.fileHandlers?.find((entry) => entry.id === handlerId);
  if (!handler) throw new APIClientError(404, "file_handler_not_found");
  if (mode !== "open" && mode !== "embed") throw new APIClientError(400, "invalid_file_handler_mode");
  const path = mode === "embed" ? handler.embedPath : handler.openPath;
  if (path === undefined) throw new APIClientError(404, "file_embed_not_found");
  if (!isAppRelativePath(path)) throw new APIClientError(400, "invalid_app_path");
  if (mode === "embed" && !path.startsWith("/embed/")) throw new APIClientError(400, "invalid_embed_path");
  return `/apps/${app.id}${path}?${new URLSearchParams({ fileId })}`;
}

/** Resolve a declared embed route; callers obtain manifests from app discovery. */
export function embedUrl(app: AppManifest, kind: string): string {
  validId(app.id);
  const embed = app.embeds.find((entry) => entry.kind === kind);
  if (!embed) throw new APIClientError(404, "embed_not_found");
  validPath(embed.path);
  if (!embed.path.startsWith("/embed/") || embed.path.includes("?")) {
    throw new APIClientError(400, "invalid_embed_path");
  }
  return `/apps/${app.id}${embed.path}`;
}

export interface OpenCloudClientOptions {
  fetch?: typeof globalThis.fetch;
}

/** A browser SDK whose app requests always remain on the gateway's origin. */
export function createOpenCloudClient(options: OpenCloudClientOptions = {}) {
  const fetcher: typeof globalThis.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let installed: AppManifest[] = [];

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetcher(path, { ...init, credentials: "same-origin" });
    if (!response.ok) {
      let code = "request_failed";
      try {
        const error: unknown = await response.json();
        if (isRecord(error) && isString(error.error) && /^[a-z][a-z0-9_]*$/.test(error.error)) code = error.error;
      } catch { /* An HTTP error does not have to include JSON. */ }
      throw new APIClientError(response.status, code);
    }
    return response;
  }

  async function readJson(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(path, init);
    try { return await response.json() as unknown; }
    catch { throw new APIClientError(502, "invalid_response"); }
  }

  async function readFile(path: string, init?: RequestInit): Promise<WorkspaceResource> {
    const value = await readJson(path, init);
    if (!isRecord(value) || !isWorkspaceResource(value.file)) throw new APIClientError(502, "invalid_response");
    return value.file;
  }

  function jsonRequest(body: object, method: "POST" | "PATCH" = "POST"): RequestInit {
    return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  async function listApps(): Promise<AppManifest[]> {
    const value = await readJson("/api/apps");
    if (!isRecord(value) || !Array.isArray(value.apps) || !value.apps.every(isAppManifest)
      || new Set(value.apps.map((app) => app.id)).size !== value.apps.length) {
      throw new APIClientError(502, "invalid_response");
    }
    installed = value.apps;
    return structuredClone(installed);
  }

  function appUrl(id: string, path = "/"): string {
    validId(id);
    validPath(path);
    if (!installed.some((app) => app.id === id)) throw new APIClientError(404, "app_not_installed");
    return `/apps/${id}${path}`;
  }

  return {
    listApps,
    appUrl,
    async listFiles(parentId?: string | null, cursor?: string): Promise<WorkspaceFilesResponse> {
      validParentId(parentId);
      const query = new URLSearchParams();
      if (parentId) query.set("parentId", parentId);
      if (cursor !== undefined) {
        if (!isString(cursor) || !cursor.length) throw new APIClientError(400, "invalid_cursor");
        query.set("cursor", cursor);
      }
      const value = await readJson(`/api/files${query.size ? `?${query}` : ""}`);
      if (!isRecord(value) || !Array.isArray(value.files) || !value.files.every(isWorkspaceResource)
        || new Set(value.files.map((file) => file.id)).size !== value.files.length
        || !(value.nextCursor === null || (isString(value.nextCursor) && value.nextCursor.length > 0))
        || !(value.folder === null || (isWorkspaceResource(value.folder) && value.folder.kind === "folder"))) {
        throw new APIClientError(502, "invalid_response");
      }
      return { files: value.files, nextCursor: value.nextCursor, folder: value.folder };
    },
    async getFile(id: string): Promise<WorkspaceResource> {
      validResourceId(id);
      return readFile(`/api/files/${id}`);
    },
    async createFolder(input: { name: string; parentId?: string | null }): Promise<WorkspaceResource> {
      validParentId(input.parentId);
      return readFile("/api/folders", jsonRequest(input));
    },
    async createFile(input: { id?: string; name: string; parentId?: string | null; mimeType: string; content?: string }): Promise<WorkspaceResource> {
      validParentId(input.parentId);
      if (input.id !== undefined) validResourceId(input.id);
      return readFile("/api/files", jsonRequest(input));
    },
    async updateFile(id: string, input: { name?: string; content?: string; expectedUpdatedAt?: string; expectedMetadataVersion?: number }): Promise<WorkspaceResource> {
      validResourceId(id);
      return readFile(`/api/files/${id}`, jsonRequest(input, "PATCH"));
    },
    async deleteFile(id: string): Promise<void> {
      validResourceId(id);
      const value = await readJson(`/api/files/${id}`, { method: "DELETE" });
      if (!isRecord(value) || value.success !== true) throw new APIClientError(502, "invalid_response");
    },
    async uploadFile(file: File, parentId?: string | null): Promise<WorkspaceResource> {
      validParentId(parentId);
      const mimeType = file.type || "application/octet-stream";
      const query = new URLSearchParams({ name: file.name, mimeType });
      if (parentId) query.set("parentId", parentId);
      return readFile(`/api/files/upload?${query}`, { method: "POST", headers: { "Content-Type": mimeType }, body: file });
    },
    async getFileContent(id: string): Promise<Response> {
      validResourceId(id);
      return request(`/api/files/${id}/content`);
    },
    async getSession(): Promise<SessionResponse> {
      const value = await readJson("/api/session");
      if (!isRecord(value) || !isPrincipal(value.user)) throw new APIClientError(502, "invalid_response");
      return { user: value.user };
    },
    async findApps(capability: string): Promise<AppManifest[]> {
      return (await listApps()).filter((app) => app.capabilities.includes(capability));
    },
    async requestApp(id: string, path: string, init: RequestInit = {}): Promise<Response> {
      validId(id);
      validPath(path);
      await listApps();
      return fetcher(appUrl(id, path), { ...init, credentials: "same-origin", redirect: "manual" });
    },
    async prepareResourceOperation(originalProposal: Parameters<typeof prepareResourceOperationHelper>[3]) {
      return prepareResourceOperationHelper(
        (p, init) => request(p, init),
        async (res) => { try { return await res.json(); } catch { throw new APIClientError(502, "invalid_response"); } },
        (status, code) => new APIClientError(status, code),
        originalProposal,
      );
    },
    async executeResourceUpload(
      originalUploadProposal: Parameters<typeof executeResourceUploadHelper>[3],
      body: Parameters<typeof executeResourceUploadHelper>[4],
    ) {
      return executeResourceUploadHelper(
        (p, init) => request(p, init),
        async (res) => { try { return await res.json(); } catch { throw new APIClientError(502, "invalid_response"); } },
        (status, code) => new APIClientError(status, code),
        originalUploadProposal,
        body,
      );
    },
    async executeResourceNative(originalNativeProposal: Parameters<typeof executeResourceNativeHelper>[3]) {
      return executeResourceNativeHelper(
        (p, init) => request(p, init),
        async (res) => { try { return await res.json(); } catch { throw new APIClientError(502, "invalid_response"); } },
        (status, code) => new APIClientError(status, code),
        originalNativeProposal,
      );
    },
    async executeResourceDelete(originalDeleteProposal: Parameters<typeof executeResourceDeleteHelper>[3]) {
      return executeResourceDeleteHelper(
        (p, init) => request(p, init),
        async (res) => { try { return await res.json(); } catch { throw new APIClientError(502, "invalid_response"); } },
        (status, code) => new APIClientError(status, code),
        originalDeleteProposal,
      );
    },
    async getResourceOperation(originalOperationId: string) {
      return getResourceOperationHelper(
        (p, init) => request(p, init),
        async (res) => { try { return await res.json(); } catch { throw new APIClientError(502, "invalid_response"); } },
        (status, code) => new APIClientError(status, code),
        originalOperationId,
      );
    },
    async executeDelegatedResourceOperation<TProposal extends ResourceOperationDelegatedProposal>(
      input: ResourceOperationDelegatedRequest<TProposal>,
    ): Promise<ResourceOperationOutcome> {
      let parsed: ResourceOperationDelegatedRequest<TProposal>;
      try {
        parsed = JSON.parse(JSON.stringify(parseResourceOperationDelegatedRequest(input))) as ResourceOperationDelegatedRequest<TProposal>;
      } catch {
        throw new APIClientError(400, "invalid_resource_operation");
      }
      const response = await request("/internal/resource-operations/delegated", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(parsed),
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new APIClientError(502, "invalid_response");
      }
      if (!response.ok) {
        const code = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "resource_operation_unavailable";
        throw new APIClientError(response.status, code);
      }
      let outcome: ResourceOperationOutcome;
      try {
        outcome = parseResourceOperationOutcome(data);
      } catch {
        throw new APIClientError(502, "invalid_resource_operation_outcome");
      }
      if (outcome.operationId !== parsed.proposal.operationId || outcome.kind !== parsed.proposal.kind) {
        throw new APIClientError(502, "outcome_mismatch");
      }
      if (outcome.stage === "committed" && outcome.resourceId !== parsed.proposal.resourceId.toLowerCase()) {
        throw new APIClientError(502, "outcome_mismatch");
      }
      return outcome;
    },
  };
}

