import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAuthError } from "@cloudflare/workers-oauth-provider";
import { isMemoryScope } from "../domain/guards";
import { MemoryService } from "../domain/memory-service";
import type { ActorContext, MemoryScope, OwnerContext } from "../domain/types";
import type { Env } from "../env";
import { bindWikimemoryAuthorizationResource } from "./resource";

const PRINCIPAL_ID = "local-owner";
const WORKSPACE_ID = "local-workspace";
export async function ensureLocalOwner(env: Env): Promise<void> {
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO principals
           (id, provider, provider_subject, email, email_verified, display_name, created_at)
         VALUES (?, 'local', ?, 'owner@example.test', 1, 'Local Owner', ?)`
    ).bind(PRINCIPAL_ID, PRINCIPAL_ID, createdAt),
    env.DB.prepare(
      "INSERT OR IGNORE INTO workspaces(id, name, created_at) VALUES (?, 'Local Wikimemory', ?)"
    ).bind(WORKSPACE_ID, createdAt),
    env.DB.prepare(
      `INSERT OR IGNORE INTO memberships(workspace_id, principal_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`
    ).bind(WORKSPACE_ID, PRINCIPAL_ID, createdAt)
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
  return {
    ...localOwnerActor(clientId),
    role: "owner",
    reauthenticatedAt: new Date().toISOString()
  };
}

function validateScopes(request: AuthRequest): MemoryScope[] {
  const requested = request.scope.length === 0 ? ["memory:read", "memory:write"] : request.scope;
  if (!requested.every((scope): scope is MemoryScope => isMemoryScope(scope))) {
    throw new OAuthError("invalid_scope", { description: "Unsupported Wikimemory scope" });
  }
  return requested;
}

async function authorizationRequest(request: Request, env: Env): Promise<AuthRequest> {
  const incoming = new URL(request.url);
  const authorize = new URL("/authorize", incoming.origin);
  authorize.search = incoming.search;
  const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(authorize));
  return bindWikimemoryAuthorizationResource(parsed, new URL("/", request.url).toString());
}

export function handleLocalAuthorization(request: Request, env: Env): Response {
  if (env.APP_ENV !== "local")
    return new Response("Local identity is disabled in production.", { status: 501 });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const destination = new URL("/local-authorize", request.url);
  destination.search = new URL(request.url).search;
  return Response.redirect(destination.toString(), 302);
}

export async function localAuthorizationOptions(request: Request, env: Env): Promise<Response> {
  if (env.APP_ENV !== "local") return Response.json({ error: "not_found" }, { status: 404 });
  const auth = await authorizationRequest(request, env);
  const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
  return Response.json({
    clientName: client?.clientName ?? auth.clientId,
    requestedScopes: validateScopes(auth)
  });
}

export async function approveLocalAuthorization(request: Request, env: Env): Promise<Response> {
  if (env.APP_ENV !== "local") return Response.json({ error: "not_found" }, { status: 404 });
  if (request.method !== "POST" || request.headers.get("origin") !== new URL(request.url).origin) {
    throw new OAuthError("invalid_request", { description: "Same-origin approval required" });
  }
  const auth = await authorizationRequest(request, env);
  const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
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
  return Response.json({ redirectTo });
}
