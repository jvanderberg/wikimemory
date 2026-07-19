import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import {
  approveLocalAuthorization,
  handleLocalAuthorization,
  localAuthorizationOptions
} from "./auth/local";
import {
  beginPasskeyAuthorization,
  passkeyAuthorizationOptions,
  productionWebOwner,
  registrationOptions,
  registrationVerify,
  setupOptions,
  setupVerify,
  verifyPasskeyAuthorization
} from "./auth/passkey";
import { handlePasskeyApi } from "./auth/passkey-api";
import { DomainError } from "./domain/errors";
import type { Env } from "./env";
import { validateEnvironment } from "./env";
import { mcpHandler } from "./mcp/server";
import { handleWebApi } from "./web/app";

const webHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    validateEnvironment(env);
    const url = new URL(request.url);
    if (url.pathname === "/authorize")
      return env.APP_ENV === "local"
        ? handleLocalAuthorization(request, env)
        : beginPasskeyAuthorization(request, env, "mcp");
    if (url.pathname === "/api/local-authorize/options" && request.method === "GET")
      return safeJson(() => localAuthorizationOptions(request, env));
    if (url.pathname === "/api/local-authorize/approve" && request.method === "POST")
      return safeJson(() => approveLocalAuthorization(request, env));
    if (url.pathname === "/api/auth/options" && request.method === "GET")
      return safeJson(() => passkeyAuthorizationOptions(request, env));
    if (url.pathname === "/auth/passkey/verify" && request.method === "POST")
      return safeJson(() => verifyPasskeyAuthorization(request, env));
    if (url.pathname === "/setup/options" && request.method === "POST")
      return safeJson(() => setupOptions(request, env));
    if (url.pathname === "/setup/verify" && request.method === "POST")
      return safeJson(() => setupVerify(request, env));
    if (url.pathname === "/passkeys/add/options" && request.method === "POST")
      return safeJson(() => registrationOptions(request, env));
    if (url.pathname === "/passkeys/add/verify" && request.method === "POST")
      return safeJson(() => registrationVerify(request, env));
    if (url.pathname === "/api/passkeys") return safeJson(() => handlePasskeyApi(request, env));
    if (env.APP_ENV === "production" && url.pathname === "/app/login")
      return beginPasskeyAuthorization(request, env, "web");
    if (env.APP_ENV === "local" && url.pathname === "/test/passkey/login")
      return beginPasskeyAuthorization(request, env, "web");
    if (env.APP_ENV === "local" && url.pathname === "/app/test-passkey-whoami") {
      return Response.json({ authenticated: (await productionWebOwner(request, env)) !== null });
    }
    if (url.pathname === "/api/app" || url.pathname.startsWith("/api/app/"))
      return handleWebApi(request, env);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "wikimemory" });
    }
    if (url.pathname === "/ready") {
      await env.DB.batch([
        env.DB.prepare("SELECT 1 FROM passkey_credentials LIMIT 1"),
        env.DB.prepare("SELECT 1 FROM passkey_bootstrap LIMIT 1"),
        env.DB.prepare("SELECT 1 FROM passkey_challenges LIMIT 1"),
        env.DB.prepare("SELECT 1 FROM passkey_registration_tokens LIMIT 1")
      ]);
      return Response.json({ status: "ready", service: "wikimemory" });
    }
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    if (headers.get("content-type")?.startsWith("text/html")) {
      headers.set(
        "content-security-policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      );
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-frame-options", "DENY");
      headers.set("x-content-type-options", "nosniff");
      headers.set("cache-control", "no-store");
    }
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers
    });
  }
} satisfies ExportedHandler<Env>;

async function safeJson(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof DomainError
    ) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    return Response.json({ error: "The authentication operation failed." }, { status: 500 });
  }
}

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: webHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["memory:read", "memory:write", "memory:admin"],
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  disallowPublicClientRegistration: false,
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  clientRegistrationTTL: 7_776_000,
  resourceMetadata: {
    scopes_supported: ["memory:read", "memory:write", "memory:admin"],
    bearer_methods_supported: ["header"],
    resource_name: "Wikimemory"
  }
});
