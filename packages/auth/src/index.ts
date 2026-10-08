import type { Principal } from "@open-cloud/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AuthenticationEnv {
  AUTH_PROVIDER: "cloudflare-access" | "local";
  /** Bare team hostname, such as example.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
}

/** An adapter seam for a future identity provider without changing app contracts. */
export interface IdentityProvider {
  readonly id: string;
  authenticate(request: Request, env: AuthenticationEnv): Promise<Principal>;
}

export type AuthenticationErrorCode =
  | "authentication_not_configured"
  | "authentication_required"
  | "invalid_access_token"
  | "local_auth_not_allowed";

export class AuthenticationError extends Error {
  readonly status = 401;

  constructor(readonly code: AuthenticationErrorCode, message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function accessConfiguration(env: AuthenticationEnv): { issuer: string; audience: string } {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const audience = env.ACCESS_AUDIENCE?.trim();

  // Constrain the JWKS location to the configured Cloudflare team, rather than
  // allowing a URL supplied in the JWT or an arbitrary authentication endpoint.
  if (
    !domain ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(domain) ||
    !audience
  ) {
    throw new AuthenticationError(
      "authentication_not_configured",
      "Cloudflare Access requires a team hostname and application audience.",
    );
  }

  return { issuer: `https://${domain}`, audience };
}

function accessKeySet(issuer: string): JWTVerifyGetKey {
  let keySet = remoteKeySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteKeySets.set(issuer, keySet);
  }
  return keySet;
}

export interface CloudflareAccessProviderOptions {
  /** Supply a trusted resolver for offline verification or a controlled key source. */
  keyResolver?: JWTVerifyGetKey;
}

export function createCloudflareAccessProvider(
  options: CloudflareAccessProviderOptions = {},
): IdentityProvider {
  return {
    id: "cloudflare-access",
    async authenticate(request, env) {
      const { issuer, audience } = accessConfiguration(env);
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!token) {
        throw new AuthenticationError("authentication_required", "Sign in to continue.");
      }

      try {
        const { payload } = await jwtVerify(token, options.keyResolver ?? accessKeySet(issuer), {
          algorithms: ["RS256"],
          issuer,
          audience,
          requiredClaims: ["exp", "sub", "email"],
        });

        // Service tokens and unsigned identity headers do not identify a human.
        if (
          typeof payload.sub !== "string" ||
          !payload.sub.trim() ||
          typeof payload.email !== "string" ||
          !payload.email.trim()
        ) {
          throw new Error("The Access token does not contain a user identity.");
        }

        return {
          id: payload.sub,
          email: payload.email,
          displayName:
            typeof payload.name === "string" && payload.name.trim()
              ? payload.name
              : payload.email,
          provider: "cloudflare-access",
        };
      } catch {
        // Keep signature, configuration, key-fetch, and claim details private.
        throw new AuthenticationError("invalid_access_token", "The sign-in token is invalid or expired.");
      }
    },
  };
}

export const localIdentityProvider: IdentityProvider = {
  id: "local",
  async authenticate(request) {
    const hostname = new URL(request.url).hostname;
    if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(hostname)) {
      throw new AuthenticationError(
        "local_auth_not_allowed",
        "Local development identity is available only on localhost.",
      );
    }

    return {
      id: "local-developer",
      email: "dev@example.test",
      displayName: "Local developer",
      provider: "local",
    };
  },
};

export type Authenticator = (request: Request, env: AuthenticationEnv) => Promise<Principal>;

export function createAuthenticator(
  providers: readonly IdentityProvider[] = [createCloudflareAccessProvider(), localIdentityProvider],
): Authenticator {
  const adapters = new Map(providers.map((provider) => [provider.id, provider]));

  return async (request, env) => {
    const provider = adapters.get(env.AUTH_PROVIDER);
    if (!provider) {
      throw new AuthenticationError(
        "authentication_not_configured",
        "An identity provider must be configured before this application can be used.",
      );
    }
    return provider.authenticate(request, env);
  };
}

export const authenticate: Authenticator = createAuthenticator();

export function authenticationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthenticationError)) {
    throw error;
  }

  return Response.json(
    { error: error.code, message: error.message },
    {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "same-origin",
      },
    },
  );
}
