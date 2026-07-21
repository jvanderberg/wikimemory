import { requestHash } from "./crypto";
import { DomainError } from "./errors";
import type {
  ActorContext,
  AdminAppendRevisionRequest,
  AdminCreateDocumentRequest,
  DocumentIdentity,
  DocumentSnapshot,
  DocumentType,
  MetadataValue,
  StoredLink
} from "./types";
import { DOCUMENT_TYPES, LINK_KINDS } from "./types";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const METADATA_KEY = /^[a-z][a-z0-9_]{0,99}$/u;

function requireScope(actor: ActorContext, scope: "memory:read" | "memory:admin"): void {
  if (!actor.scopes.has(scope))
    throw new DomainError("forbidden", `Missing required scope ${scope}`);
}

function timestamp(value: string, label: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new DomainError("validation_failed", `${label} must be an ISO-8601 UTC timestamp`);
  return value;
}

function validateMetadata(values: MetadataValue[]): void {
  if (values.length > 100)
    throw new DomainError("limit_exceeded", "revision exceeds 100 metadata values");
  const seen = new Set<string>();
  const cardinalities = new Map<string, MetadataValue["cardinality"]>();
  for (const item of values) {
    if (!METADATA_KEY.test(item.key) || item.value.length > 4096)
      throw new DomainError("validation_failed", "invalid metadata value");
    const previous = cardinalities.get(item.key);
    if (previous !== undefined && previous !== item.cardinality)
      throw new DomainError("validation_failed", `metadata cardinality changes for ${item.key}`);
    cardinalities.set(item.key, item.cardinality);
    const key = `${item.key}\u0000${item.value}`;
    if (seen.has(key)) throw new DomainError("validation_failed", "duplicate metadata value");
    seen.add(key);
    if (
      item.cardinality === "singleton" &&
      [...seen].filter((value) => value.startsWith(`${item.key}\u0000`)).length > 1
    )
      throw new DomainError("validation_failed", `metadata key ${item.key} is singleton`);
  }
}

function validateLinks(values: StoredLink[]): void {
  if (values.length > 100) throw new DomainError("limit_exceeded", "revision exceeds 100 links");
  const seen = new Set<string>();
  for (const item of values) {
    if (
      !LINK_KINDS.includes(item.kind) ||
      !SLUG.test(item.targetSlug) ||
      !["explicit", "body"].includes(item.origin)
    )
      throw new DomainError("validation_failed", "invalid link");
    const key = `${item.kind}\u0000${item.targetSlug}\u0000${item.origin}`;
    if (seen.has(key)) throw new DomainError("validation_failed", "duplicate link");
    seen.add(key);
  }
}

export class AdminService {
  constructor(private readonly db: D1Database) {}

  async listDocuments(
    actor: ActorContext,
    afterSlug: string | null,
    limit: number
  ): Promise<DocumentIdentity[]> {
    requireScope(actor, "memory:read");
    const bounded = Math.max(1, Math.min(limit, 100));
    const rows = await this.db
      .prepare(
        `SELECT id, workspace_id, slug, type, created_at FROM documents
       WHERE workspace_id = ? AND (? IS NULL OR slug > ?) ORDER BY slug LIMIT ?`
      )
      .bind(actor.workspaceId, afterSlug, afterSlug, bounded)
      .all<{
        id: string;
        workspace_id: string;
        slug: string;
        type: DocumentType;
        created_at: string;
      }>();
    return rows.results.map((row) => ({
      documentId: row.id,
      workspaceId: row.workspace_id,
      slug: row.slug,
      type: row.type,
      createdAt: row.created_at
    }));
  }

  async getDocument(actor: ActorContext, slug: string): Promise<DocumentIdentity> {
    requireScope(actor, "memory:read");
    const row = await this.db
      .prepare(
        "SELECT id, workspace_id, slug, type, created_at FROM documents WHERE workspace_id = ? AND slug = ?"
      )
      .bind(actor.workspaceId, slug)
      .first<{
        id: string;
        workspace_id: string;
        slug: string;
        type: DocumentType;
        created_at: string;
      }>();
    if (row === null) throw new DomainError("not_found", `No document named ${slug}`);
    return {
      documentId: row.id,
      workspaceId: row.workspace_id,
      slug: row.slug,
      type: row.type,
      createdAt: row.created_at
    };
  }

  async listCurrentMetadata(actor: ActorContext): Promise<
    Array<{
      slug: string;
      revisionId: string;
      key: string;
      value: string;
      cardinality: MetadataValue["cardinality"];
    }>
  > {
    requireScope(actor, "memory:read");
    const rows = await this.db
      .prepare(
        `SELECT d.slug, r.id revision_id, m.key, m.value, m.cardinality
       FROM documents d JOIN current_revisions r ON r.doc_id = d.id
       JOIN revision_metadata m ON m.revision_id = r.id AND m.workspace_id = d.workspace_id
       WHERE d.workspace_id = ? ORDER BY d.slug, m.key, m.value LIMIT 10001`
      )
      .bind(actor.workspaceId)
      .all<{
        slug: string;
        revision_id: string;
        key: string;
        value: string;
        cardinality: MetadataValue["cardinality"];
      }>();
    if (rows.results.length > 10_000)
      throw new DomainError("limit_exceeded", "metadata listing exceeds 10,000 values");
    return rows.results.map((row) => ({
      slug: row.slug,
      revisionId: row.revision_id,
      key: row.key,
      value: row.value,
      cardinality: row.cardinality
    }));
  }

  async listCurrentLinks(
    actor: ActorContext
  ): Promise<Array<{ slug: string; revisionId: string } & StoredLink>> {
    requireScope(actor, "memory:read");
    const rows = await this.db
      .prepare(
        `SELECT d.slug, r.id revision_id, l.kind, l.target_slug, l.target_document_id, l.origin
       FROM documents d JOIN current_revisions r ON r.doc_id = d.id
       JOIN revision_links l ON l.revision_id = r.id AND l.workspace_id = d.workspace_id
       WHERE d.workspace_id = ? ORDER BY d.slug, l.kind, l.target_slug LIMIT 10001`
      )
      .bind(actor.workspaceId)
      .all<{
        slug: string;
        revision_id: string;
        kind: StoredLink["kind"];
        target_slug: string;
        target_document_id: string | null;
        origin: StoredLink["origin"];
      }>();
    if (rows.results.length > 10_000)
      throw new DomainError("limit_exceeded", "link listing exceeds 10,000 values");
    return rows.results.map((row) => ({
      slug: row.slug,
      revisionId: row.revision_id,
      kind: row.kind,
      targetSlug: row.target_slug,
      targetDocumentId: row.target_document_id,
      origin: row.origin
    }));
  }

  async createDocument(
    actor: ActorContext,
    request: AdminCreateDocumentRequest
  ): Promise<DocumentIdentity> {
    requireScope(actor, "memory:admin");
    if (!SLUG.test(request.slug) || !DOCUMENT_TYPES.includes(request.type))
      throw new DomainError("validation_failed", "invalid document identity");
    const createdAt = timestamp(request.createdAt ?? new Date().toISOString(), "createdAt");
    const documentId = request.documentId ?? crypto.randomUUID();
    try {
      await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO documents(id, workspace_id, type, slug, created_at) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(documentId, actor.workspaceId, request.type, request.slug, createdAt),
        this.db
          .prepare(
            `INSERT INTO audit_events(id, workspace_id, kind, created_at, principal_id, client_id,
                                    agent_label, document_id, request_id, detail_json)
           VALUES (?, ?, 'admin_create_document', ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            actor.workspaceId,
            new Date().toISOString(),
            actor.principalId,
            actor.clientId,
            actor.agentLabel ?? null,
            documentId,
            actor.requestId,
            JSON.stringify({ slug: request.slug, sourceCreatedAt: createdAt })
          )
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE constraint failed"))
        throw new DomainError("already_exists", `Document ${request.slug} already exists`);
      throw error;
    }
    return {
      documentId,
      workspaceId: actor.workspaceId,
      slug: request.slug,
      type: request.type,
      createdAt
    };
  }

  async appendRevision(
    actor: ActorContext,
    slug: string,
    request: AdminAppendRevisionRequest
  ): Promise<DocumentSnapshot> {
    requireScope(actor, "memory:admin");
    if (
      request.title.length === 0 ||
      request.title.length > 300 ||
      new TextEncoder().encode(request.body).byteLength > 262_144 ||
      request.reason.length === 0 ||
      request.reason.length > 500
    )
      throw new DomainError("validation_failed", "invalid revision content");
    if (request.summary !== undefined && request.summary !== null && request.summary.length > 1000)
      throw new DomainError("validation_failed", "invalid revision summary");
    if (
      request.sourceActor !== undefined &&
      request.sourceActor !== null &&
      request.sourceActor.length > 200
    )
      throw new DomainError("validation_failed", "invalid source actor");
    timestamp(request.createdAt, "createdAt");
    validateMetadata(request.metadata);
    validateLinks(request.links);
    const document = await this.getDocument({ ...actor, scopes: new Set(["memory:read"]) }, slug);
    const hash = await requestHash({ slug, ...request });
    const replay = await this.db
      .prepare(
        "SELECT result_revision_id, request_hash FROM operations WHERE workspace_id = ? AND operation_id = ?"
      )
      .bind(actor.workspaceId, request.operationId)
      .first<{ result_revision_id: string; request_hash: string }>();
    if (replay !== null) {
      if (replay.request_hash !== hash)
        throw new DomainError(
          "idempotency_mismatch",
          "Operation ID was already used with different input"
        );
      return await this.readRevision(actor, slug, replay.result_revision_id);
    }
    const current = await this.db
      .prepare(
        "SELECT id, revision_number FROM revisions WHERE workspace_id = ? AND doc_id = ? ORDER BY revision_number DESC LIMIT 1"
      )
      .bind(actor.workspaceId, document.documentId)
      .first<{ id: string; revision_number: number }>();
    const expectedNumber = (current?.revision_number ?? 0) + 1;
    const parent = current?.id ?? null;
    if (request.revisionNumber !== expectedNumber || (request.parentRevisionId ?? null) !== parent)
      throw new DomainError(
        "revision_conflict",
        "Historical revision does not extend the current chain",
        {
          expectedRevisionNumber: expectedNumber,
          expectedParentRevisionId: parent
        }
      );
    const revisionId = request.revisionId ?? crypto.randomUUID();
    if (request.restoredFromRevisionId !== undefined && request.restoredFromRevisionId !== null) {
      const restoredFrom = await this.db
        .prepare("SELECT doc_id FROM revisions WHERE workspace_id = ? AND id = ?")
        .bind(actor.workspaceId, request.restoredFromRevisionId)
        .first<{ doc_id: string }>();
      if (restoredFrom?.doc_id !== document.documentId)
        throw new DomainError(
          "validation_failed",
          "restoredFromRevisionId must identify an earlier revision of this document"
        );
    }
    const targetIds = new Map<string, string>();
    for (const targetSlug of new Set(request.links.map((link) => link.targetSlug))) {
      const target = await this.db
        .prepare("SELECT id FROM documents WHERE workspace_id = ? AND slug = ?")
        .bind(actor.workspaceId, targetSlug)
        .first<{ id: string }>();
      if (target !== null) targetIds.set(targetSlug, target.id);
    }
    for (const link of request.links) {
      if (
        link.targetDocumentId !== null &&
        targetIds.get(link.targetSlug) !== link.targetDocumentId
      )
        throw new DomainError(
          "validation_failed",
          `Link target identity does not match ${link.targetSlug}`
        );
    }
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO operations(workspace_id, operation_id, request_hash, principal_id, kind, status,
                                result_document_id, result_revision_id, created_at)
         VALUES (?, ?, ?, ?, 'ingest', 'completed', ?, ?, ?)`
        )
        .bind(
          actor.workspaceId,
          request.operationId,
          hash,
          actor.principalId,
          document.documentId,
          revisionId,
          new Date().toISOString()
        ),
      this.db
        .prepare(
          `INSERT INTO revisions(id, workspace_id, doc_id, revision_number, parent_revision_id,
          title, body, summary, created_at, principal_id, client_id, agent_label, reason,
          operation_id, request_hash, restored_from_revision_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          revisionId,
          actor.workspaceId,
          document.documentId,
          request.revisionNumber,
          parent,
          request.title,
          request.body,
          request.summary ?? null,
          request.createdAt,
          actor.principalId,
          actor.clientId,
          request.sourceActor ?? actor.agentLabel ?? null,
          request.reason,
          request.operationId,
          hash,
          request.restoredFromRevisionId ?? null
        )
    ];
    for (const item of request.metadata)
      statements.push(
        this.db
          .prepare(
            "INSERT INTO revision_metadata(workspace_id, revision_id, key, value, cardinality) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(actor.workspaceId, revisionId, item.key, item.value, item.cardinality)
      );
    for (const link of request.links)
      statements.push(
        this.db
          .prepare(
            "INSERT INTO revision_links(workspace_id, revision_id, kind, target_slug, target_document_id, origin) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(
            actor.workspaceId,
            revisionId,
            link.kind,
            link.targetSlug,
            targetIds.get(link.targetSlug) ?? null,
            link.origin
          )
      );
    statements.push(
      this.db
        .prepare(
          `INSERT INTO audit_events(id, workspace_id, kind, created_at, principal_id, client_id,
                                agent_label, document_id, revision_id, request_id, detail_json)
       VALUES (?, ?, 'admin_append_revision', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          actor.workspaceId,
          new Date().toISOString(),
          actor.principalId,
          actor.clientId,
          actor.agentLabel ?? null,
          document.documentId,
          revisionId,
          actor.requestId,
          JSON.stringify({
            revisionNumber: request.revisionNumber,
            sourceCreatedAt: request.createdAt,
            sourceActor: request.sourceActor ?? null
          })
        )
    );
    await this.db.batch(statements);
    return await this.readRevision(actor, slug, revisionId);
  }

  async listRevisions(
    actor: ActorContext,
    slug: string,
    after: number,
    limit: number
  ): Promise<DocumentSnapshot[]> {
    requireScope(actor, "memory:read");
    const bounded = Math.max(1, Math.min(limit, 100));
    const rows = await this.db
      .prepare(
        `SELECT r.id FROM documents d JOIN revisions r ON r.doc_id = d.id
       WHERE d.workspace_id = ? AND d.slug = ? AND r.revision_number > ?
       ORDER BY r.revision_number LIMIT ?`
      )
      .bind(actor.workspaceId, slug, after, bounded)
      .all<{ id: string }>();
    return await Promise.all(rows.results.map((row) => this.readRevision(actor, slug, row.id)));
  }

  async readRevision(
    actor: ActorContext,
    slug: string,
    revisionId: string
  ): Promise<DocumentSnapshot> {
    const { MemoryService } = await import("./memory-service");
    return await new MemoryService(this.db).get(
      { ...actor, scopes: new Set(["memory:read"]) },
      slug,
      revisionId
    );
  }
}
