/// <reference path="./cloudflare-workers.d.ts" />
export type { DurableObjectState } from "@cloudflare/workers-types/index.ts";

import {
  authenticate,
  authenticationErrorResponse,
  type AuthenticationEnv,
  type Authenticator,
} from "@open-cloud/auth";
import type { AppManifest, SessionResponse, StatusResponse } from "@open-cloud/contracts";

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface AppWorkerEnv extends AuthenticationEnv {
  ASSETS: AssetFetcher;
}

export interface SecurityOptions {
  api?: boolean;
  htmlBlobFrames?: boolean;
}

/** Harden private app responses while allowing Vue/Enough UI runtime styles. */
export function protectResponse(
  _request: Request,
  response: Response,
  options: SecurityOptions = {},
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const mediaType = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isAttachment = (headers.get("content-disposition") || "").toLowerCase().includes("attachment");
  const method = _request.method.toUpperCase();
  const allowBlobFrames =
    options.htmlBlobFrames === true &&
    (method === "GET" || method === "HEAD") &&
    response.status >= 200 &&
    response.status < 300 &&
    mediaType === "text/html" &&
    !options.api &&
    !headers.has("location") &&
    !isAttachment;
  headers.set(
    "Content-Security-Policy",
    allowBlobFrames
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  if (options.api) {
    headers.set("Cache-Control", "no-store");
  }

  // Cloudflare carries the upgrade handle outside standard DOM Response fields.
  // Forward the same handle when rebuilding headers; losing it breaks the upgrade.
  const upgrade = response as Response & { readonly webSocket?: WebSocket | null };
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(response.status === 101 ? { webSocket: upgrade.webSocket } : {}),
  } as ResponseInit & { webSocket?: WebSocket | null });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export interface AppWorkerOptions {
  /** An adapter seam for tests and future application identity providers. */
  authenticate?: Authenticator;
}

export function createAppWorker(manifest: AppManifest, options: AppWorkerOptions = {}) {
  const identify = options.authenticate ?? authenticate;

  return {
    async fetch(request: Request, env: AppWorkerEnv): Promise<Response> {
      try {
        const user = await identify(request, env);
        const { pathname } = new URL(request.url);
        const isApi = pathname === "/api" || pathname.startsWith("/api/");

        if (request.method !== "GET" && request.method !== "HEAD") {
          const response = jsonResponse(
            { error: "method_not_allowed", message: "This scaffold does not support writes." },
            405,
          );
          response.headers.set("Allow", "GET, HEAD");
          return protectResponse(request, response, { api: true });
        }

        let response: Response;
        if (pathname === "/api/manifest") {
          response = jsonResponse(manifest);
        } else if (pathname === "/api/session") {
          response = jsonResponse({ user } satisfies SessionResponse);
        } else if (pathname === "/api/status") {
          const workspaceFiles = Boolean(manifest.fileHandlers?.length);
          response = jsonResponse({
            appId: manifest.id,
            status: "scaffold",
            features: { editing: false, persistence: workspaceFiles },
            message: `${manifest.name} is connected. Editing is not implemented yet. ${workspaceFiles ? "Files are stored by the workspace." : "App-specific storage is not implemented yet."}`,
          } satisfies StatusResponse);
        } else if (pathname === "/health") {
          response = jsonResponse({ ok: true, appId: manifest.id });
        } else if (isApi) {
          response = jsonResponse({ error: "not_found", message: "API route not found." }, 404);
        } else {
          response = await env.ASSETS.fetch(request);
        }

        if (request.method === "HEAD") {
          response = new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        return protectResponse(request, response, { api: isApi || pathname === "/health" });
      } catch (error) {
        const response = authenticationErrorResponse(error);
        return request.method === "HEAD"
          ? new Response(null, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
          : response;
      }
    },
  };
}
