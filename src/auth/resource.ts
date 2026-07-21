import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAuthError } from "@cloudflare/workers-oauth-provider";

export function canonicalMcpResource(appBaseUrl: string | undefined): string {
  if (appBaseUrl === undefined) throw new Error("APP_BASE_URL is required");
  return new URL("/mcp", appBaseUrl).toString();
}

export function canonicalAdminApiResource(appBaseUrl: string | undefined): string {
  if (appBaseUrl === undefined) throw new Error("APP_BASE_URL is required");
  return new URL("/api/v1", appBaseUrl).toString();
}

export function bindWikimemoryAuthorizationResource(
  auth: AuthRequest,
  appBaseUrl: string | undefined
): AuthRequest {
  const mcp = canonicalMcpResource(appBaseUrl);
  const adminApi = canonicalAdminApiResource(appBaseUrl);
  const requested = auth.resource;
  if (requested === undefined) return bindAuthorizationResource(auth, mcp);
  const selected =
    typeof requested === "string" ? requested : requested.length === 1 ? requested[0] : undefined;
  if (selected !== mcp && selected !== adminApi)
    throw new OAuthError("invalid_request", {
      description: "The requested OAuth resource is not a Wikimemory endpoint"
    });
  return bindAuthorizationResource(auth, selected);
}

export function bindAuthorizationResource(
  auth: AuthRequest,
  canonicalResource: string
): AuthRequest {
  const requested = auth.resource;
  if (requested !== undefined) {
    const valid =
      typeof requested === "string"
        ? requested === canonicalResource
        : requested.length === 1 && requested[0] === canonicalResource;
    if (!valid)
      throw new OAuthError("invalid_request", {
        description: "The requested OAuth resource is not this Wikimemory endpoint"
      });
  }
  return {
    responseType: auth.responseType,
    clientId: auth.clientId,
    redirectUri: auth.redirectUri,
    scope: auth.scope,
    state: auth.state,
    ...(auth.codeChallenge === undefined ? {} : { codeChallenge: auth.codeChallenge }),
    ...(auth.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: auth.codeChallengeMethod }),
    resource: canonicalResource
  };
}
