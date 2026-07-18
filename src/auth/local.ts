import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { OAuthError } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { MemoryService } from "../domain/memory-service";
import { isMemoryScope } from "../domain/guards";
import type { ActorContext, MemoryScope, OwnerContext } from "../domain/types";
import { bindAuthorizationResource } from "./resource";

const PRINCIPAL_ID = "local-owner";
const WORKSPACE_ID = "local-workspace";
function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function ensureLocalOwner(env: Env): Promise<void> {
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO principals
           (id, provider, provider_subject, email, email_verified, display_name, created_at)
         VALUES (?, 'local', ?, 'owner@example.test', 1, 'Local Owner', ?)`
      )
      .bind(PRINCIPAL_ID, PRINCIPAL_ID, createdAt),
    env.DB
      .prepare("INSERT OR IGNORE INTO workspaces(id, name, created_at) VALUES (?, 'Local Wikimemory', ?)")
      .bind(WORKSPACE_ID, createdAt),
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO memberships(workspace_id, principal_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`
      )
      .bind(WORKSPACE_ID, PRINCIPAL_ID, createdAt)
  ]);
  const actor: ActorContext = {
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    clientId: "wikimemory-local-seed",
    agentLabel: "init",
    scopes: new Set(["memory:read", "memory:write", "memory:admin"]),
    requestId: crypto.randomUUID()
  };
  const service = new MemoryService(env.DB);
  await service.ingest(actor, {
    operationId: "seed-home-v1",
    reason: "seed local orientation",
    slug: "home",
    type: "system",
    title: "Wikimemory home",
    summary: "Standard orientation page.",
    body: "# Wikimemory\n\nThe database is authoritative. See [[now]] for current focus."
  });
  await service.ingest(actor, {
    operationId: "seed-now-v1",
    reason: "seed local current focus",
    slug: "now",
    type: "system",
    title: "Now",
    summary: "Current focus and active threads.",
    body: "# Now\n\n_(No active work has been recorded yet.)_"
  });
}

export function localOwnerActor(clientId = "wikimemory-web"): ActorContext {
  return {
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    clientId,
    scopes: new Set(["memory:read", "memory:write", "memory:admin"]),
    requestId: crypto.randomUUID()
  };
}

export function localOwnerContext(clientId = "wikimemory-web"): OwnerContext {
  return { ...localOwnerActor(clientId), role: "owner", reauthenticatedAt: new Date().toISOString() };
}

function validateScopes(request: AuthRequest): MemoryScope[] {
  const requested = request.scope.length === 0 ? ["memory:read", "memory:write"] : request.scope;
  if (!requested.every((scope): scope is MemoryScope => isMemoryScope(scope))) {
    throw new OAuthError("invalid_scope", { description: "Unsupported Wikimemory scope" });
  }
  return requested;
}

function consentPage(request: Request, auth: AuthRequest, client: ClientInfo | null): Response {
  const csrf = crypto.randomUUID();
  const action = new URL(request.url);
  const callbackOrigin = new URL(auth.redirectUri).origin;
  const name = client?.clientName ?? client?.clientId ?? auth.clientId;
  const scopes = validateScopes(auth);
  const markup = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize Wikimemory</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.65rem 1rem}</style></head>
<body><main><h1>Authorize Wikimemory</h1><p><strong>${html(name)}</strong> is requesting access to your local test memory.</p>
<ul>${scopes.map((scope) => `<li>${html(scope)}</li>`).join("")}</ul>
<form method="post" action="${html(action.pathname + action.search)}"><input type="hidden" name="csrf" value="${html(csrf)}">
<button type="submit">Continue as owner@example.test</button></form></main></body></html>`;
  return new Response(markup, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `wm_local_csrf=${csrf}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`,
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function handleLocalAuthorization(request: Request, env: Env): Promise<Response> {
  if (env.APP_ENV !== "local") return new Response("Local identity is disabled in production.", { status: 501 });
  const parsedAuth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const auth = bindAuthorizationResource(parsedAuth, new URL("/mcp", request.url).toString());
  const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
  if (request.method === "GET") return consentPage(request, auth, client);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  const submitted = form.get("csrf");
  const expected = cookie(request, "wm_local_csrf");
  if (typeof submitted !== "string" || expected === null || submitted !== expected) {
    throw new OAuthError("invalid_request", { description: "CSRF validation failed" });
  }
  const scopes = validateScopes(auth);
  await ensureLocalOwner(env);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: auth,
    userId: PRINCIPAL_ID,
    metadata: { environment: "local", clientName: client?.clientName ?? auth.clientId },
    scope: scopes,
    props: {
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      clientId: auth.clientId,
      scopes
    }
  });
  return Response.redirect(redirectTo, 302);
}
