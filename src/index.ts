import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { handleLocalAuthorization } from "./auth/local";
import { beginPasskeyAuthorization, productionWebOwner, setupOptions, setupPage, setupVerify, verifyPasskeyAuthorization } from "./auth/passkey";
import { DomainError } from "./domain/errors";
import type { Env } from "./env";
import { validateEnvironment } from "./env";
import { mcpHandler } from "./mcp/server";
import { handleWebApp } from "./web/app";

const webHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    validateEnvironment(env);
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return env.APP_ENV === "local" ? handleLocalAuthorization(request, env) : beginPasskeyAuthorization(request, env, "mcp");
    if (url.pathname === "/auth/passkey/verify" && request.method === "POST") return safeJson(() => verifyPasskeyAuthorization(request, env));
    if (url.pathname === "/setup" && request.method === "GET") return setupPage();
    if (url.pathname === "/setup/options" && request.method === "POST") return safeJson(() => setupOptions(request, env));
    if (url.pathname === "/setup/verify" && request.method === "POST") return safeJson(() => setupVerify(request, env));
    if (env.APP_ENV === "local" && url.pathname === "/test/passkey/login") return beginPasskeyAuthorization(request, env, "web");
    if (env.APP_ENV === "local" && url.pathname === "/app/test-passkey-whoami") {
      return Response.json({ authenticated: await productionWebOwner(request, env) !== null });
    }
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) return handleWebApp(request, env);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "wikimemory" });
    }
    if (url.pathname === "/ready") {
      await env.DB.batch([
        env.DB.prepare("SELECT 1 FROM passkey_credentials LIMIT 1"),
        env.DB.prepare("SELECT 1 FROM passkey_bootstrap LIMIT 1"),
        env.DB.prepare("SELECT 1 FROM passkey_challenges LIMIT 1")
      ]);
      return Response.json({ status: "ready", service: "wikimemory" });
    }
    return Response.redirect(new URL("/app", request.url).toString(), 302);
  }
} satisfies ExportedHandler<Env>;

async function safeJson(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof DomainError) {
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
