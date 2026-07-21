import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { type AuthProps, actorFromAuthorization } from "../auth/props";
import { AdminService } from "../domain/admin-service";
import { DomainError } from "../domain/errors";
import { MemoryService } from "../domain/memory-service";
import type { AdminAppendRevisionRequest, OwnerContext } from "../domain/types";
import type { Env } from "../env";

const documentInput = z
  .object({
    documentId: z.string().min(1).max(200).optional(),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    type: z.enum(["system", "project", "topic", "source", "note"]),
    createdAt: z.iso.datetime({ offset: false }).optional()
  })
  .strict();

const metadata = z
  .object({
    key: z.string().min(1).max(100),
    value: z.string().max(4096),
    cardinality: z.enum(["singleton", "multi"])
  })
  .strict();

const link = z
  .object({
    kind: z.enum(["related", "part_of", "supersedes", "cites", "contradicts"]),
    targetSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    origin: z.enum(["explicit", "body"]),
    targetDocumentId: z.string().nullable().optional()
  })
  .strict()
  .transform((value) => ({ ...value, targetDocumentId: value.targetDocumentId ?? null }));

const revisionInput = z
  .object({
    operationId: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200).optional(),
    revisionNumber: z.number().int().positive(),
    parentRevisionId: z.string().min(1).max(200).nullable().optional(),
    title: z.string().min(1).max(300),
    body: z.string().max(262_144),
    summary: z.string().max(1000).nullable().optional(),
    createdAt: z.iso.datetime({ offset: false }),
    sourceActor: z.string().max(200).nullable().optional(),
    reason: z.string().min(1).max(500),
    restoredFromRevisionId: z.string().min(1).max(200).nullable().optional(),
    metadata: z.array(metadata).max(100),
    links: z.array(link).max(100)
  })
  .strict();

function adminRevision(input: z.infer<typeof revisionInput>): AdminAppendRevisionRequest {
  return {
    operationId: input.operationId,
    revisionNumber: input.revisionNumber,
    title: input.title,
    body: input.body,
    createdAt: input.createdAt,
    reason: input.reason,
    metadata: input.metadata,
    links: input.links,
    ...(input.revisionId === undefined ? {} : { revisionId: input.revisionId }),
    ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.sourceActor === undefined ? {} : { sourceActor: input.sourceActor }),
    ...(input.restoredFromRevisionId === undefined
      ? {}
      : { restoredFromRevisionId: input.restoredFromRevisionId })
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof z.ZodError)
    return Response.json(
      {
        error: "validation_failed",
        message: "Request does not match the API schema",
        issues: error.issues
      },
      { status: 400 }
    );
  if (!(error instanceof DomainError)) throw error;
  const status =
    error.code === "not_found"
      ? 404
      : error.code === "forbidden"
        ? 403
        : ["already_exists", "revision_conflict", "idempotency_mismatch"].includes(error.code)
          ? 409
          : error.code === "reauthentication_required"
            ? 401
            : error.code === "limit_exceeded"
              ? 413
              : 400;
  return Response.json({ error: error.code, message: error.message, ...error.details }, { status });
}

async function json(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new DomainError("validation_failed", "Content-Type must be application/json");
  return await request.json();
}

function pathParts(url: URL): string[] {
  try {
    return url.pathname
      .slice("/api/v1/".length)
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new DomainError("validation_failed", "Request path is not valid URL encoding");
  }
}

export async function handleCrudApi(
  request: Request,
  env: Env,
  props: Record<string, unknown> | undefined
): Promise<Response> {
  try {
    const actor = await actorFromAuthorization(props, env);
    const admin = new AdminService(env.DB);
    const memory = new MemoryService(env.DB);
    const url = new URL(request.url);
    const parts = pathParts(url);
    if (parts.length === 1 && parts[0] === "metadata" && request.method === "GET")
      return Response.json({ items: await admin.listCurrentMetadata(actor) });
    if (parts.length === 1 && parts[0] === "links" && request.method === "GET")
      return Response.json({ items: await admin.listCurrentLinks(actor) });
    if (parts.length === 1 && parts[0] === "documents") {
      if (request.method === "GET") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        if (!Number.isInteger(limit))
          throw new DomainError("validation_failed", "limit must be an integer");
        const items = await admin.listDocuments(actor, url.searchParams.get("after"), limit);
        return Response.json({
          items,
          next:
            items.length === Math.min(Math.max(limit, 1), 100) ? (items.at(-1)?.slug ?? null) : null
        });
      }
      if (request.method === "POST") {
        const input = documentInput.parse(await json(request));
        return Response.json(
          await admin.createDocument(actor, {
            slug: input.slug,
            type: input.type,
            ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
            ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
          }),
          { status: 201 }
        );
      }
    }
    if (parts[0] === "documents" && parts[1] !== undefined) {
      const slug = parts[1];
      if (parts.length === 2 && request.method === "GET") {
        const identity = await admin.getDocument(actor, slug);
        let current = null;
        try {
          current = await memory.get(actor, slug);
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "not_found") throw error;
        }
        return Response.json({ identity, current });
      }
      if (parts.length === 2 && request.method === "PUT") {
        const input = revisionInput.parse(await json(request));
        return Response.json(await admin.appendRevision(actor, slug, adminRevision(input)), {
          status: 201
        });
      }
      if (parts.length === 2 && request.method === "DELETE") {
        if (!actor.scopes.has("memory:admin"))
          throw new DomainError("forbidden", "Missing required scope memory:admin");
        const confirmation = url.searchParams.get("confirm") ?? "";
        const authenticatedAt =
          typeof props?.["authenticatedAt"] === "string"
            ? props["authenticatedAt"]
            : env.APP_ENV === "local"
              ? new Date().toISOString()
              : "";
        const owner: OwnerContext = {
          ...actor,
          role: "owner",
          reauthenticatedAt: authenticatedAt,
          ...(typeof props?.["credentialId"] === "string"
            ? { credentialId: props["credentialId"] }
            : {})
        };
        const authorization = await memory.authorizePurge(owner, slug, confirmation);
        return Response.json(await memory.purge(owner, authorization.id, slug));
      }
      if (parts.length === 3 && parts[2] === "revisions") {
        if (request.method === "GET") {
          const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
          const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
          if (!Number.isInteger(after) || !Number.isInteger(limit))
            throw new DomainError("validation_failed", "pagination values must be integers");
          const items = await admin.listRevisions(actor, slug, after, limit);
          return Response.json({
            items,
            next:
              items.length === Math.min(Math.max(limit, 1), 100)
                ? (items.at(-1)?.revisionNumber ?? null)
                : null
          });
        }
        if (request.method === "POST" || request.method === "PUT") {
          const input = revisionInput.parse(await json(request));
          return Response.json(await admin.appendRevision(actor, slug, adminRevision(input)), {
            status: 201
          });
        }
      }
      const revisionId = parts[3];
      if (
        parts.length === 4 &&
        parts[2] === "revisions" &&
        request.method === "GET" &&
        revisionId !== undefined
      )
        return Response.json(await admin.readRevision(actor, slug, revisionId));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

export class CrudApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  override async fetch(request: Request): Promise<Response> {
    return await handleCrudApi(request, this.env, this.ctx.props);
  }
}
