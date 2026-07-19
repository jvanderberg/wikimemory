import { ensureLocalOwner, localOwnerContext } from "../auth/local";
import {
  endProductionWebSession,
  listProductionWebSessions,
  productionWebOwner,
  revokeProductionSessionsForCredentialBestEffort,
  revokeProductionWebSession
} from "../auth/passkey";
import {
  createRegistrationToken,
  listPasskeys,
  PASSKEY_OWNER_ID,
  requireRecentPasskeyAuthentication,
  revokePasskey
} from "../auth/passkey-management";
import { DomainError } from "../domain/errors";
import { ExportService } from "../domain/export-service";
import { MemoryService } from "../domain/memory-service";
import type { OwnerContext } from "../domain/types";
import type { Env } from "../env";

function cookieValue(request: Request, name: string): string | null {
  const part = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return part === undefined ? null : part.slice(name.length + 1);
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin)
    throw new DomainError("forbidden", "Cross-origin mutation denied");
}

async function owner(request: Request, env: Env): Promise<OwnerContext | null> {
  if (env.APP_ENV === "local") {
    if (cookieValue(request, "wm_local_web") !== "owner") return null;
    await ensureLocalOwner(env);
    return localOwnerContext();
  }
  return await productionWebOwner(request, env);
}

function jsonError(error: unknown): Response {
  if (!(error instanceof DomainError)) throw error;
  const status =
    error.code === "not_found"
      ? 404
      : error.code === "forbidden"
        ? 403
        : error.code === "revision_conflict" ||
            error.code === "already_exists" ||
            error.code === "idempotency_mismatch"
          ? 409
          : error.code === "reauthentication_required"
            ? 401
            : error.code === "limit_exceeded"
              ? 413
              : error.code === "internal_error"
                ? 500
                : 400;
  return Response.json({ error: error.code, message: error.message }, { status });
}

async function manage(request: Request, env: Env, context: OwnerContext): Promise<Response> {
  const grants = await env.OAUTH_PROVIDER.listUserGrants(context.principalId, { limit: 100 });
  const clients = await Promise.all(
    grants.items.map(async (grant) => {
      const client = await env.OAUTH_PROVIDER.lookupClient(grant.clientId);
      return {
        id: grant.id,
        clientId: grant.clientId,
        clientName: client?.clientName ?? grant.clientId,
        scope: grant.scope,
        createdAt: new Date(grant.createdAt * 1000).toISOString()
      };
    })
  );
  return Response.json({
    passkeys: env.APP_ENV === "production" ? await listPasskeys(env.DB) : [],
    clients,
    sessions:
      env.APP_ENV === "production"
        ? await listProductionWebSessions(request, env, context.principalId)
        : []
  });
}

async function exportResponse(
  env: Env,
  context: OwnerContext,
  format: "jsonl" | "md"
): Promise<Response> {
  const service = new ExportService(env.DB);
  const content =
    format === "jsonl" ? await service.jsonl(context) : await service.markdown(context);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(content, {
    headers: {
      "content-type":
        format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="wikimemory-${date}.${format}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function handleWebApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/app/login" && request.method === "POST" && env.APP_ENV === "local") {
      requireSameOrigin(request);
      await ensureLocalOwner(env);
      return Response.json(
        { ok: true },
        {
          headers: {
            "set-cookie": "wm_local_web=owner; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400"
          }
        }
      );
    }
    const context = await owner(request, env);
    if (url.pathname === "/api/app/session" && request.method === "GET")
      return Response.json({
        authenticated: context !== null,
        environment: env.APP_ENV,
        ...(context === null ? { loginUrl: "/app/login" } : {})
      });
    if (context === null)
      return Response.json({ error: "unauthenticated", loginUrl: "/app/login" }, { status: 401 });
    const service = new MemoryService(env.DB);
    if (url.pathname === "/api/app/documents" && request.method === "GET")
      return Response.json({ items: await service.index(context, { limit: 100 }) });
    if (url.pathname === "/api/app/search" && request.method === "GET")
      return Response.json({
        hits: await service.recall(context, (url.searchParams.get("q") ?? "").trim(), 20)
      });
    if (url.pathname === "/api/app/recent" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT d.slug, r.id revision_id, r.revision_number, r.created_at, r.reason FROM revisions r JOIN documents d ON d.id = r.doc_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 100`
      )
        .bind(context.workspaceId)
        .all<{
          slug: string;
          revision_id: string;
          revision_number: number;
          created_at: string;
          reason: string;
        }>();
      return Response.json({ revisions: rows.results });
    }
    if (url.pathname === "/api/app/manage" && request.method === "GET")
      return await manage(request, env, context);
    if (url.pathname === "/api/app/export.jsonl" && request.method === "GET")
      return await exportResponse(env, context, "jsonl");
    if (url.pathname === "/api/app/export.md" && request.method === "GET")
      return await exportResponse(env, context, "md");
    if (url.pathname === "/api/app/logout" && request.method === "POST") {
      requireSameOrigin(request);
      if (env.APP_ENV === "production") await endProductionWebSession(request, env);
      return Response.json(
        { ok: true },
        {
          headers: {
            "set-cookie": `${env.APP_ENV === "production" ? "wm_web_session" : "wm_local_web"}=; HttpOnly; ${env.APP_ENV === "production" ? "Secure; " : ""}Path=/; SameSite=Lax; Max-Age=0`
          }
        }
      );
    }
    if (request.method === "POST" || request.method === "DELETE") requireSameOrigin(request);
    if (
      url.pathname === "/api/app/passkeys" &&
      request.method === "POST" &&
      env.APP_ENV === "production"
    ) {
      requireRecentPasskeyAuthentication(context.reauthenticatedAt);
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("label" in body) ||
        typeof body.label !== "string"
      )
        throw new DomainError("validation_failed", "Passkey name is missing");
      if (context.credentialId === undefined)
        throw new DomainError("forbidden", "The authorizing passkey is no longer valid");
      const token = await createRegistrationToken(env.DB, body.label, context.credentialId);
      return Response.json({
        registrationUrl: `${new URL("/passkeys/add", request.url).toString()}#${encodeURIComponent(token.rawToken)}`,
        expiresAt: token.expiresAt
      });
    }
    if (
      url.pathname === "/api/app/passkeys" &&
      request.method === "DELETE" &&
      env.APP_ENV === "production"
    ) {
      requireRecentPasskeyAuthentication(context.reauthenticatedAt);
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("credentialRef" in body) ||
        typeof body.credentialRef !== "string"
      )
        throw new DomainError("validation_failed", "Passkey reference is missing");
      const credentialId = await revokePasskey(env.DB, body.credentialRef);
      const sessionCleanupComplete = await revokeProductionSessionsForCredentialBestEffort(
        env,
        PASSKEY_OWNER_ID,
        credentialId
      );
      return Response.json({ revoked: body.credentialRef, sessionCleanupComplete });
    }
    if (url.pathname === "/api/app/grants" && request.method === "DELETE") {
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("grantId" in body) ||
        typeof body.grantId !== "string"
      )
        throw new DomainError("validation_failed", "Grant ID is missing");
      await env.OAUTH_PROVIDER.revokeGrant(body.grantId, context.principalId);
      return Response.json({ revoked: body.grantId });
    }
    if (
      url.pathname === "/api/app/sessions" &&
      request.method === "DELETE" &&
      env.APP_ENV === "production"
    ) {
      const body: unknown = await request.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("sessionRef" in body) ||
        typeof body.sessionRef !== "string"
      )
        throw new DomainError("validation_failed", "Session reference is missing");
      await revokeProductionWebSession(env, context.principalId, body.sessionRef);
      return Response.json({ revoked: body.sessionRef });
    }
    if (url.pathname.startsWith("/api/app/docs/")) {
      const path = url.pathname.slice(14).split("/");
      const slug = decodeURIComponent(path[0] ?? "");
      const action = path[1];
      if (request.method === "GET" && action === undefined) {
        const revisionId = url.searchParams.get("revision") ?? undefined;
        const [document, current, history] = await Promise.all([
          service.get(context, slug, revisionId),
          revisionId === undefined ? null : service.get(context, slug),
          service.history(context, slug, 25)
        ]);
        return Response.json({ document, current, history });
      }
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null)
        throw new DomainError("validation_failed", "Request body is missing");
      if (
        request.method === "POST" &&
        action === "restore" &&
        "targetRevisionId" in body &&
        "expectedRevisionId" in body &&
        typeof body.targetRevisionId === "string" &&
        typeof body.expectedRevisionId === "string"
      ) {
        return Response.json(
          await service.restore(context, {
            operationId: crypto.randomUUID(),
            reason: "owner web restore",
            slug,
            targetRevisionId: body.targetRevisionId,
            expectedRevisionId: body.expectedRevisionId
          })
        );
      }
      if (
        request.method === "POST" &&
        action === "purge-authorize" &&
        "confirmation" in body &&
        typeof body.confirmation === "string"
      )
        return Response.json(await service.authorizePurge(context, slug, body.confirmation));
      if (
        request.method === "POST" &&
        action === "purge-apply" &&
        "authorizationId" in body &&
        typeof body.authorizationId === "string"
      )
        return Response.json(await service.purge(context, body.authorizationId, slug));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}
