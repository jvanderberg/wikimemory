import { requestHash } from "./crypto";
import { DomainError } from "./errors";
import { scanSecrets } from "./secret-scanner";
import {
  DOCUMENT_TYPES,
  LINK_KINDS,
  type ActorContext,
  type DocumentSnapshot,
  type DocumentIndexEntry,
  type DocumentType,
  type IngestRequest,
  type IngestResult,
  type LinkRequest,
  type LintFinding,
  type LinkValue,
  type MemoryScope,
  type MetadataValue,
  type OwnerContext,
  type PurgeAuthorization,
  type RecallHit,
  type RevisionHeader,
  type RestoreRequest,
  type StoredLink
} from "./types";

interface CurrentRow {
  document_id: string;
  workspace_id: string;
  slug: string;
  type: DocumentType;
  revision_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  title: string;
  body: string;
  summary: string | null;
  created_at: string;
  principal_id: string;
  client_id: string;
  agent_label: string | null;
  reason: string;
  restored_from_revision_id: string | null;
}

interface OperationRow {
  request_hash: string;
  principal_id: string;
  kind: string;
  status: "completed" | "purged";
  result_document_id: string | null;
  result_revision_id: string | null;
}

const SINGLETON_KEYS = new Set([
  "status",
  "last_active",
  "project",
  "priority",
  "confidence",
  "source_url",
  "source_type",
  "trust"
]);
const MULTI_KEYS = new Set(["tag"]);
const METADATA_KEY = /^[a-z][a-z0-9_]{0,63}$/;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireScope(actor: ActorContext, scope: "memory:read" | "memory:write" | "memory:admin"): void {
  if (!actor.scopes.has(scope)) throw new DomainError("forbidden", `Missing required scope ${scope}`);
}

function validateRequest(request: IngestRequest): void {
  if (!request.operationId || request.operationId.length > 200) {
    throw new DomainError("validation_failed", "operationId is required and must be at most 200 characters");
  }
  if (!SLUG.test(request.slug)) throw new DomainError("validation_failed", "slug must be lowercase kebab-case");
  if (!request.reason || request.reason.length > 500) {
    throw new DomainError("validation_failed", "reason is required and must be at most 500 characters");
  }
  if (request.type !== undefined && !DOCUMENT_TYPES.includes(request.type)) {
    throw new DomainError("validation_failed", "unsupported document type");
  }
  if (request.title !== undefined && request.title.length > 300) {
    throw new DomainError("limit_exceeded", "title exceeds 300 characters");
  }
  if (request.summary !== undefined && request.summary !== null && request.summary.length > 1000) {
    throw new DomainError("limit_exceeded", "summary exceeds 1000 characters");
  }
  if (request.body !== undefined && new TextEncoder().encode(request.body).byteLength > 262_144) {
    throw new DomainError("limit_exceeded", "body exceeds 256 KiB");
  }
}

function metadataMap(values: MetadataValue[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const item of values) {
    const bucket = result.get(item.key) ?? new Set<string>();
    bucket.add(item.value);
    result.set(item.key, bucket);
  }
  return result;
}

function applyMetadataPatch(current: MetadataValue[], request: IngestRequest): MetadataValue[] {
  const map = metadataMap(current);
  const cardinalities = new Map(current.map((item) => [item.key, item.cardinality]));
  for (const [key, value] of Object.entries(request.metadata?.set ?? {})) {
    if (!METADATA_KEY.test(key)) throw new DomainError("validation_failed", `invalid metadata key ${key}`);
    if (MULTI_KEYS.has(key) || cardinalities.get(key) === "multi") {
      throw new DomainError("validation_failed", `metadata key ${key} is multivalued`);
    }
    if (value === null) {
      map.delete(key);
      cardinalities.delete(key);
    } else {
      map.set(key, new Set([value]));
      cardinalities.set(key, "singleton");
    }
  }
  for (const [key, patch] of Object.entries(request.metadata?.multi ?? {})) {
    if (!METADATA_KEY.test(key)) throw new DomainError("validation_failed", `invalid metadata key ${key}`);
    if (SINGLETON_KEYS.has(key) || cardinalities.get(key) === "singleton") {
      throw new DomainError("validation_failed", `metadata key ${key} is singleton`);
    }
    const values = patch.replace === undefined ? new Set(map.get(key) ?? []) : new Set(patch.replace);
    for (const value of patch.add ?? []) values.add(value);
    for (const value of patch.remove ?? []) values.delete(value);
    if (values.size === 0) {
      map.delete(key);
      cardinalities.delete(key);
    } else {
      map.set(key, values);
      cardinalities.set(key, "multi");
    }
  }
  const result: MetadataValue[] = [];
  for (const [key, values] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    for (const value of [...values].sort()) {
      if (value.length > 4096) throw new DomainError("limit_exceeded", `metadata value for ${key} exceeds 4 KiB`);
      const cardinality = cardinalities.get(key);
      if (cardinality === undefined) throw new DomainError("internal_error", `metadata cardinality missing for ${key}`);
      result.push({ key, value, cardinality });
    }
  }
  if (result.length > 100) throw new DomainError("limit_exceeded", "revision exceeds 100 metadata values");
  return result;
}

function linkKey(link: LinkValue): string {
  return `${link.kind}\u0000${link.targetSlug}`;
}

function explicitLinks(current: StoredLink[], request: IngestRequest): LinkValue[] {
  const map = new Map(
    current.filter((link) => link.origin === "explicit").map((link) => [linkKey(link), { kind: link.kind, targetSlug: link.targetSlug }])
  );
  for (const link of request.links?.remove ?? []) map.delete(linkKey(link));
  for (const link of request.links?.add ?? []) {
    if (!LINK_KINDS.includes(link.kind) || !SLUG.test(link.targetSlug)) {
      throw new DomainError("validation_failed", "invalid link");
    }
    map.set(linkKey(link), link);
  }
  return [...map.values()].sort((a, b) => linkKey(a).localeCompare(linkKey(b)));
}

function derivedSlugs(body: string, ownSlug: string): string[] {
  const slugs = new Set<string>();
  for (const match of body.matchAll(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)) {
    const slug = match[1];
    if (slug !== undefined && slug !== ownSlug) slugs.add(slug);
  }
  return [...slugs].sort();
}

export class MemoryService {
  constructor(private readonly db: D1Database) {}

  async get(actor: ActorContext, slug: string, revisionId?: string): Promise<DocumentSnapshot> {
    requireScope(actor, "memory:read");
    const row = await this.db
      .prepare(
        revisionId === undefined
          ? `SELECT d.id document_id, d.workspace_id, d.slug, d.type,
                    r.id revision_id, r.revision_number, r.parent_revision_id,
                    r.title, r.body, r.summary, r.created_at, r.principal_id,
                    r.client_id, r.agent_label, r.reason, r.restored_from_revision_id
             FROM documents d JOIN current_revisions r ON r.doc_id = d.id
             WHERE d.workspace_id = ? AND d.slug = ?`
          : `SELECT d.id document_id, d.workspace_id, d.slug, d.type,
                    r.id revision_id, r.revision_number, r.parent_revision_id,
                    r.title, r.body, r.summary, r.created_at, r.principal_id,
                    r.client_id, r.agent_label, r.reason, r.restored_from_revision_id
             FROM documents d JOIN revisions r ON r.doc_id = d.id
             WHERE d.workspace_id = ? AND d.slug = ? AND r.id = ?`
      )
      .bind(...(revisionId === undefined ? [actor.workspaceId, slug] : [actor.workspaceId, slug, revisionId]))
      .first<CurrentRow>();
    if (row === null) throw new DomainError("not_found", `No document named ${slug}`);
    const [metadata, links] = await Promise.all([
      this.readMetadata(actor.workspaceId, row.revision_id),
      this.readLinks(actor.workspaceId, row.revision_id)
    ]);
    return {
      documentId: row.document_id,
      workspaceId: row.workspace_id,
      slug: row.slug,
      type: row.type,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      parentRevisionId: row.parent_revision_id,
      title: row.title,
      body: row.body,
      summary: row.summary,
      createdAt: row.created_at,
      principalId: row.principal_id,
      clientId: row.client_id,
      agentLabel: row.agent_label,
      reason: row.reason,
      restoredFromRevisionId: row.restored_from_revision_id,
      metadata,
      links
    };
  }

  async recall(actor: ActorContext, query: string, limit = 8): Promise<RecallHit[]> {
    requireScope(actor, "memory:read");
    const terms = [...query.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
    if (terms.length === 0) return this.recallSymbols(actor, query.trim(), limit);
    const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const phrase = terms.join(" ").toLowerCase();
    const bounded = Math.max(1, Math.min(limit, 20));
    const result = await this.db
      .prepare(
        `SELECT f.document_id, r.id revision_id, f.slug, d.type, f.title,
                NULLIF(f.summary, '') summary,
                snippet(current_fts, 5, '[', ']', ' … ', 16) snippet,
                bm25(current_fts, 2.0, 8.0, 4.0, 1.0) raw_score,
                CASE
                  WHEN lower(f.title) = ? THEN 4
                  WHEN instr(lower(f.title), ?) > 0 THEN 3
                  WHEN instr(lower(f.summary), ?) > 0 THEN 2
                  WHEN instr(lower(f.body), ?) > 0 THEN 1
                  ELSE 0
                END phrase_boost
         FROM current_fts f
         JOIN documents d ON d.id = f.document_id AND d.workspace_id = f.workspace_id
         JOIN current_revisions r ON r.doc_id = d.id
         WHERE current_fts MATCH ? AND f.workspace_id = ?
         ORDER BY phrase_boost DESC, raw_score, f.document_id
         LIMIT ?`
      )
      .bind(phrase, phrase, phrase, phrase, ftsQuery, actor.workspaceId, bounded)
      .all<{
        document_id: string;
        revision_id: string;
        slug: string;
        type: DocumentType;
        title: string;
        summary: string | null;
        snippet: string;
        raw_score: number;
        phrase_boost: number;
      }>();
    return result.results.map((row) => ({
      documentId: row.document_id,
      revisionId: row.revision_id,
      slug: row.slug,
      type: row.type,
      title: row.title,
      summary: row.summary,
      snippet: row.snippet,
      score: Math.min(1, row.phrase_boost * 0.2 + 0.2 / (1 + Math.exp(row.raw_score)))
    }));
  }

  private async recallSymbols(actor: ActorContext, query: string, limit: number): Promise<RecallHit[]> {
    if (query === "") return [];
    const bounded = Math.max(1, Math.min(limit, 20));
    const rows = await this.db.prepare(
      `SELECT f.document_id, r.id revision_id, f.slug, d.type, f.title,
              NULLIF(f.summary, '') summary,
              CASE WHEN f.summary <> '' THEN f.summary ELSE substr(f.body, 1, 160) END snippet,
              CASE
                WHEN f.title = ? THEN 4
                WHEN instr(f.title, ?) > 0 THEN 3
                WHEN instr(f.summary, ?) > 0 THEN 2
                ELSE 1
              END phrase_boost
       FROM current_fts f
       JOIN documents d ON d.id = f.document_id AND d.workspace_id = f.workspace_id
       JOIN current_revisions r ON r.doc_id = d.id
       WHERE f.workspace_id = ?
         AND (instr(f.title, ?) > 0 OR instr(f.summary, ?) > 0 OR instr(f.body, ?) > 0)
       ORDER BY phrase_boost DESC, f.document_id LIMIT ?`
    ).bind(query, query, query, actor.workspaceId, query, query, query, bounded).all<{
      document_id: string; revision_id: string; slug: string; type: DocumentType;
      title: string; summary: string | null; snippet: string; phrase_boost: number;
    }>();
    return rows.results.map((row) => ({
      documentId: row.document_id,
      revisionId: row.revision_id,
      slug: row.slug,
      type: row.type,
      title: row.title,
      summary: row.summary,
      snippet: row.snippet,
      score: Math.min(1, 0.2 + row.phrase_boost * 0.2)
    }));
  }

  async recallBySourceUrl(actor: ActorContext, sourceUrl: string, limit = 8): Promise<RecallHit[]> {
    requireScope(actor, "memory:read");
    const bounded = Math.max(1, Math.min(limit, 20));
    const rows = await this.db.prepare(
      `SELECT d.id document_id, r.id revision_id, d.slug, d.type, r.title, r.summary
       FROM documents d
       JOIN current_revisions r ON r.doc_id = d.id
       JOIN revision_metadata rm ON rm.workspace_id = d.workspace_id
         AND rm.revision_id = r.id AND rm.key = 'source_url' AND rm.value = ?
       WHERE d.workspace_id = ?
       ORDER BY d.slug LIMIT ?`
    ).bind(sourceUrl, actor.workspaceId, bounded).all<{
      document_id: string; revision_id: string; slug: string; type: DocumentType;
      title: string; summary: string | null;
    }>();
    return rows.results.map((row) => ({
      documentId: row.document_id,
      revisionId: row.revision_id,
      slug: row.slug,
      type: row.type,
      title: row.title,
      summary: row.summary,
      snippet: row.summary ?? row.title,
      score: 1
    }));
  }

  async index(actor: ActorContext, options: { type?: DocumentType; limit?: number; afterSlug?: string } = {}): Promise<DocumentIndexEntry[]> {
    requireScope(actor, "memory:read");
    const bounded = Math.max(1, Math.min(options.limit ?? 50, 100));
    const clauses = ["d.workspace_id = ?", "d.slug > ?"];
    const bindings: unknown[] = [actor.workspaceId, options.afterSlug ?? ""];
    if (options.type !== undefined) {
      clauses.push("d.type = ?");
      bindings.push(options.type);
    }
    const rows = await this.db
      .prepare(
        `SELECT d.id document_id, d.slug, d.type, r.id revision_id, r.revision_number,
                r.title, r.summary, r.created_at,
                (SELECT rm.value FROM revision_metadata rm
                 WHERE rm.workspace_id = d.workspace_id AND rm.revision_id = r.id AND rm.key = 'status'
                 LIMIT 1) status
         FROM documents d JOIN current_revisions r ON r.doc_id = d.id
         WHERE ${clauses.join(" AND ")}
         ORDER BY d.slug LIMIT ?`
      )
      .bind(...bindings, bounded)
      .all<{
        document_id: string; slug: string; type: DocumentType; revision_id: string;
        revision_number: number; title: string; summary: string | null; created_at: string; status: string | null;
      }>();
    return rows.results.map((row) => ({
      documentId: row.document_id,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      slug: row.slug,
      type: row.type,
      title: row.title,
      summary: row.summary,
      updatedAt: row.created_at,
      status: row.status
    }));
  }

  async history(actor: ActorContext, slug: string, limit = 50): Promise<RevisionHeader[]> {
    requireScope(actor, "memory:read");
    const bounded = Math.max(1, Math.min(limit, 100));
    const rows = await this.db
      .prepare(
        `SELECT r.id revision_id, r.revision_number, r.parent_revision_id, r.created_at,
                r.principal_id, r.client_id, r.agent_label, r.reason,
                r.restored_from_revision_id, r.request_hash
         FROM documents d JOIN revisions r ON r.doc_id = d.id
         WHERE d.workspace_id = ? AND d.slug = ?
         ORDER BY r.revision_number DESC LIMIT ?`
      )
      .bind(actor.workspaceId, slug, bounded)
      .all<{
        revision_id: string; revision_number: number; parent_revision_id: string | null; created_at: string;
        principal_id: string; client_id: string; agent_label: string | null; reason: string;
        restored_from_revision_id: string | null; request_hash: string;
      }>();
    return rows.results.map((row) => ({
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      parentRevisionId: row.parent_revision_id,
      createdAt: row.created_at,
      principalId: row.principal_id,
      clientId: row.client_id,
      agentLabel: row.agent_label,
      reason: row.reason,
      restoredFromRevisionId: row.restored_from_revision_id,
      requestHash: row.request_hash
    }));
  }

  async lint(actor: ActorContext, limit = 100): Promise<LintFinding[]> {
    requireScope(actor, "memory:read");
    const bounded = Math.max(1, Math.min(limit, 200));
    const [unresolved, missing, orphans, stale] = await Promise.all([
      this.db.prepare(
        `SELECT d.slug, rl.target_slug
         FROM documents d JOIN current_revisions r ON r.doc_id = d.id
         JOIN revision_links rl ON rl.revision_id = r.id AND rl.workspace_id = d.workspace_id
         WHERE d.workspace_id = ? AND NOT EXISTS (
           SELECT 1 FROM documents target
           WHERE target.workspace_id = d.workspace_id AND target.slug = rl.target_slug
         )
         ORDER BY d.slug, rl.target_slug LIMIT ?`
      ).bind(actor.workspaceId, bounded).all<{ slug: string; target_slug: string }>(),
      this.db.prepare(
        `SELECT d.slug FROM documents d JOIN current_revisions r ON r.doc_id = d.id
         WHERE d.workspace_id = ? AND d.type != 'system' AND (r.summary IS NULL OR trim(r.summary) = '')
         ORDER BY d.slug LIMIT ?`
      ).bind(actor.workspaceId, bounded).all<{ slug: string }>(),
      this.db.prepare(
        `SELECT d.slug FROM documents d
         WHERE d.workspace_id = ? AND d.type != 'system'
           AND NOT EXISTS (
             SELECT 1 FROM revision_links rl JOIN current_revisions sr ON sr.id = rl.revision_id
             WHERE rl.workspace_id = d.workspace_id AND (rl.target_document_id = d.id OR sr.doc_id = d.id)
           )
         ORDER BY d.slug LIMIT ?`
      ).bind(actor.workspaceId, bounded).all<{ slug: string }>(),
      this.db.prepare(
        `SELECT d.slug, rm2.value last_active
         FROM documents d JOIN current_revisions r ON r.doc_id = d.id
         JOIN revision_metadata rm ON rm.revision_id = r.id AND rm.key = 'status' AND rm.value = 'active'
         JOIN revision_metadata rm2 ON rm2.revision_id = r.id AND rm2.key = 'last_active'
         WHERE d.workspace_id = ? AND d.type = 'project' AND date(rm2.value) < date('now', '-90 days')
         ORDER BY d.slug LIMIT ?`
      ).bind(actor.workspaceId, bounded).all<{ slug: string; last_active: string }>()
    ]);
    return [
      ...unresolved.results.map((row): LintFinding => ({ kind: "unresolved_reference", slug: row.slug, detail: `Target ${row.target_slug} does not exist` })),
      ...missing.results.map((row): LintFinding => ({ kind: "missing_summary", slug: row.slug, detail: "Current revision has no summary" })),
      ...orphans.results.map((row): LintFinding => ({ kind: "orphan", slug: row.slug, detail: "No current incoming or outgoing links" })),
      ...stale.results.map((row): LintFinding => ({ kind: "stale_active_project", slug: row.slug, detail: `Active project was last active ${row.last_active}` }))
    ].slice(0, bounded);
  }

  async ingest(actor: ActorContext, request: IngestRequest): Promise<IngestResult> {
    requireScope(actor, "memory:write");
    return this.writeRevision(actor, request, "ingest", null);
  }

  private async writeRevision(
    actor: ActorContext,
    request: IngestRequest,
    operationKind: "ingest" | "link" | "restore",
    restoredFromRevisionId: string | null
  ): Promise<IngestResult> {
    validateRequest(request);
    const hash = await requestHash(request);
    const replay = await this.findOperation(actor.workspaceId, request.operationId);
    if (replay !== null) return this.replayResult(actor, request, hash, operationKind, replay);

    let current: DocumentSnapshot | null = null;
    try {
      current = await this.get({ ...actor, scopes: new Set(["memory:read"]) }, request.slug);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "not_found") throw error;
    }

    const creating = current === null;
    if (current === null) {
      if (request.expectedRevisionId !== undefined) {
        throw new DomainError("revision_conflict", "New documents cannot have an expected revision");
      }
      if (request.type === undefined || request.title === undefined || request.body === undefined) {
        throw new DomainError("validation_failed", "New documents require type, title, and body");
      }
    } else {
      if (request.type !== undefined && request.type !== current.type) {
        throw new DomainError("validation_failed", "Document type is immutable");
      }
      if (request.expectedRevisionId !== current.revisionId) {
        throw new DomainError("revision_conflict", "Expected revision is stale", {
          currentRevisionId: current.revisionId,
          currentRevisionNumber: current.revisionNumber
        });
      }
    }

    const title = request.title ?? current?.title;
    const body = request.body ?? current?.body;
    const summary = request.summary === undefined ? (current?.summary ?? null) : request.summary;
    if (title === undefined || body === undefined) throw new DomainError("validation_failed", "title and body are required");
    let metadata = applyMetadataPatch(current?.metadata ?? [], request);
    if (creating && request.type === "source" && !metadata.some((item) => item.key === "trust")) {
      const trustMetadata: MetadataValue = { key: "trust", value: "untrusted", cardinality: "singleton" };
      metadata = [...metadata, trustMetadata]
        .sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
    }
    const explicit = explicitLinks(current?.links ?? [], request);

    const secretFields: Record<string, string> = { title, body, summary: summary ?? "" };
    for (const item of metadata) secretFields[`metadata.${item.key}`] = item.value;
    const findings = await scanSecrets(secretFields);
    if (findings.length > 0) {
      throw new DomainError("secret_detected", "Likely secret material was detected", {
        findings: findings.map(({ field, category, fingerprint }) => ({ field, category, fingerprint }))
      });
    }

    const targetSlugs = new Set([...explicit.map((link) => link.targetSlug), ...derivedSlugs(body, request.slug)]);
    const resolved = new Map<string, string>();
    for (const slug of targetSlugs) {
      const target = await this.db
        .prepare("SELECT id FROM documents WHERE workspace_id = ? AND slug = ?")
        .bind(actor.workspaceId, slug)
        .first<{ id: string }>();
      if (target !== null) resolved.set(slug, target.id);
    }
    for (const link of explicit) {
      if (!resolved.has(link.targetSlug)) {
        throw new DomainError("validation_failed", `Explicit link target ${link.targetSlug} does not exist`);
      }
    }

    const links: StoredLink[] = [
      ...explicit.map((link): StoredLink => ({ ...link, origin: "explicit", targetDocumentId: resolved.get(link.targetSlug) ?? null })),
      ...derivedSlugs(body, request.slug).map((targetSlug): StoredLink => ({
        kind: "related",
        targetSlug,
        origin: "body",
        targetDocumentId: resolved.get(targetSlug) ?? null
      }))
    ];
    if (links.length > 100) throw new DomainError("limit_exceeded", "revision exceeds 100 links");

    const documentId = current?.documentId ?? crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const revisionNumber = (current?.revisionNumber ?? 0) + 1;
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const statements: D1PreparedStatement[] = [];
    if (creating) {
      statements.push(
        this.db
          .prepare("INSERT INTO documents(id, workspace_id, type, slug, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(documentId, actor.workspaceId, request.type, request.slug, createdAt)
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO operations(workspace_id, operation_id, request_hash, principal_id, kind, status,
                                  result_document_id, result_revision_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
        )
        .bind(
          actor.workspaceId,
          request.operationId,
          hash,
          actor.principalId,
          operationKind,
          documentId,
          revisionId,
          createdAt
        ),
      this.db
        .prepare(
          `INSERT INTO revisions(id, workspace_id, doc_id, revision_number, parent_revision_id,
                                 title, body, summary, created_at, principal_id, client_id,
                                 agent_label, reason, operation_id, request_hash,
                                 restored_from_revision_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          revisionId,
          actor.workspaceId,
          documentId,
          revisionNumber,
          current?.revisionId ?? null,
          title,
          body,
          summary,
          createdAt,
          actor.principalId,
          actor.clientId,
          actor.agentLabel ?? null,
          request.reason,
          request.operationId,
          hash,
          restoredFromRevisionId
        )
    );
    for (const item of metadata) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO revision_metadata(workspace_id, revision_id, key, value, cardinality) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(actor.workspaceId, revisionId, item.key, item.value, item.cardinality)
      );
    }
    for (const link of links) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO revision_links(workspace_id, revision_id, kind, target_slug, target_document_id, origin)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(actor.workspaceId, revisionId, link.kind, link.targetSlug, link.targetDocumentId, link.origin)
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO audit_events(id, workspace_id, kind, created_at, principal_id, client_id,
                                    agent_label, document_id, revision_id, request_id, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          actor.workspaceId,
          operationKind,
          createdAt,
          actor.principalId,
          actor.clientId,
          actor.agentLabel ?? null,
          documentId,
          revisionId,
          actor.requestId,
          JSON.stringify({ revisionNumber, creating })
        )
    );

    try {
      await this.db.batch(statements);
    } catch (error) {
      const racedReplay = await this.findOperation(actor.workspaceId, request.operationId);
      if (racedReplay !== null) return this.replayResult(actor, request, hash, operationKind, racedReplay);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("revision_conflict")) {
        let latest: DocumentSnapshot | null = null;
        try {
          latest = await this.get({ ...actor, scopes: new Set(["memory:read"]) }, request.slug);
        } catch {
          // The transaction may have raced a purge. Return a conflict without content.
        }
        throw new DomainError("revision_conflict", "A concurrent revision won the write", {
          currentRevisionId: latest?.revisionId,
          currentRevisionNumber: latest?.revisionNumber
        });
      }
      if (message.includes("UNIQUE constraint failed: documents.workspace_id, documents.slug")) {
        throw new DomainError("already_exists", `Document ${request.slug} already exists`);
      }
      throw error;
    }

    return {
      documentId,
      revisionId,
      revisionNumber,
      slug: request.slug,
      idempotentReplay: false,
      unresolvedReferences: derivedSlugs(body, request.slug).filter((slug) => !resolved.has(slug))
    };
  }

  async link(actor: ActorContext, request: LinkRequest): Promise<IngestResult> {
    requireScope(actor, "memory:write");
    return this.writeRevision(
      actor,
      {
        operationId: request.operationId,
        reason: request.reason,
        slug: request.sourceSlug,
        expectedRevisionId: request.expectedRevisionId,
        links: request.action === "add" ? { add: [request.link] } : { remove: [request.link] }
      },
      "link",
      null
    );
  }

  async restore(actor: ActorContext, request: RestoreRequest): Promise<IngestResult> {
    requireScope(actor, "memory:admin");
    const readActor: ActorContext = { ...actor, scopes: new Set<MemoryScope>(["memory:read"]) };
    const [current, target] = await Promise.all([
      this.get(readActor, request.slug),
      this.get(readActor, request.slug, request.targetRevisionId)
    ]);
    if (current.revisionId !== request.expectedRevisionId) {
      throw new DomainError("revision_conflict", "Expected revision is stale", {
        currentRevisionId: current.revisionId,
        currentRevisionNumber: current.revisionNumber
      });
    }

    const currentMetadata = metadataMap(current.metadata);
    const targetMetadata = metadataMap(target.metadata);
    const currentCardinalities = new Map(current.metadata.map((item) => [item.key, item.cardinality]));
    const targetCardinalities = new Map(target.metadata.map((item) => [item.key, item.cardinality]));
    const set: Record<string, string | null> = {};
    const multi: NonNullable<IngestRequest["metadata"]>["multi"] = {};
    for (const key of new Set([...currentMetadata.keys(), ...targetMetadata.keys()])) {
      const targetValues = [...(targetMetadata.get(key) ?? [])];
      const cardinality = targetCardinalities.get(key) ?? currentCardinalities.get(key);
      if (cardinality === "singleton") set[key] = targetValues[0] ?? null;
      else if (cardinality === "multi") multi[key] = { replace: targetValues };
      else throw new DomainError("internal_error", `metadata cardinality missing for ${key}`);
    }

    const currentExplicit = current.links
      .filter((item) => item.origin === "explicit")
      .map(({ kind, targetSlug }) => ({ kind, targetSlug }));
    const targetExplicit = target.links
      .filter((item) => item.origin === "explicit")
      .map(({ kind, targetSlug }) => ({ kind, targetSlug }));

    return this.writeRevision(
      actor,
      {
        operationId: request.operationId,
        reason: request.reason,
        slug: request.slug,
        expectedRevisionId: request.expectedRevisionId,
        title: target.title,
        body: target.body,
        summary: target.summary,
        metadata: { set, multi },
        links: { remove: currentExplicit, add: targetExplicit }
      },
      "restore",
      target.revisionId
    );
  }

  async authorizePurge(actor: OwnerContext, slug: string, confirmation: string): Promise<PurgeAuthorization> {
    if (confirmation !== slug) throw new DomainError("validation_failed", "Purge confirmation must exactly match the slug");
    const authenticatedAt = Date.parse(actor.reauthenticatedAt);
    const now = Date.now();
    if (!Number.isFinite(authenticatedAt) || authenticatedAt > now + 60_000 || now - authenticatedAt > 300_000) {
      throw new DomainError("reauthentication_required", "Passkey authentication must be less than five minutes old");
    }
    const document = await this.db
      .prepare("SELECT id FROM documents WHERE workspace_id = ? AND slug = ?")
      .bind(actor.workspaceId, slug)
      .first<{ id: string }>();
    if (document === null) throw new DomainError("not_found", `No document named ${slug}`);
    const id = crypto.randomUUID();
    const createdAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
    const expiresAt = new Date(now + 300_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const hash = await requestHash({ workspaceId: actor.workspaceId, documentId: document.id, principalId: actor.principalId, slug });
    await this.db
      .prepare(
        `INSERT INTO purge_authorizations(id, workspace_id, document_id, principal_id, request_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, actor.workspaceId, document.id, actor.principalId, hash, expiresAt, createdAt)
      .run();
    return { id, documentId: document.id, slug, expiresAt };
  }

  async purge(actor: OwnerContext, authorizationId: string, slug: string): Promise<{ purgedRevisions: number }> {
    const authorization = await this.db
      .prepare(
        `SELECT p.document_id, p.principal_id, p.request_hash, p.expires_at
         FROM purge_authorizations p
         JOIN documents d ON d.id = p.document_id AND d.workspace_id = p.workspace_id
         WHERE p.id = ? AND p.workspace_id = ? AND d.slug = ?`
      )
      .bind(authorizationId, actor.workspaceId, slug)
      .first<{ document_id: string; principal_id: string; request_hash: string; expires_at: string }>();
    if (authorization === null || authorization.principal_id !== actor.principalId) {
      throw new DomainError("forbidden", "Invalid purge authorization");
    }
    if (Date.parse(authorization.expires_at) < Date.now()) {
      throw new DomainError("reauthentication_required", "Purge authorization expired");
    }
    const count = await this.db
      .prepare("SELECT COUNT(*) count FROM revisions WHERE workspace_id = ? AND doc_id = ?")
      .bind(actor.workspaceId, authorization.document_id)
      .first<{ count: number }>();
    const purgedRevisions = count?.count ?? 0;
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await this.db.batch([
      this.db.prepare("PRAGMA defer_foreign_keys = ON"),
      this.db
        .prepare(
          `INSERT INTO audit_events(id, workspace_id, kind, created_at, principal_id, client_id,
                                    agent_label, document_id, request_id, detail_json)
           VALUES (?, ?, 'purge', ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          actor.workspaceId,
          createdAt,
          actor.principalId,
          actor.clientId,
          actor.agentLabel ?? null,
          authorization.document_id,
          actor.requestId,
          JSON.stringify({ purgedRevisions, requestHash: authorization.request_hash })
        ),
      this.db
        .prepare(
          `UPDATE operations SET status = 'purged', result_document_id = NULL, result_revision_id = NULL
           WHERE workspace_id = ? AND result_document_id = ?`
        )
        .bind(actor.workspaceId, authorization.document_id),
      this.db
        .prepare(
          `DELETE FROM revision_links WHERE workspace_id = ? AND revision_id IN
             (SELECT id FROM revisions WHERE workspace_id = ? AND doc_id = ?)`
        )
        .bind(actor.workspaceId, actor.workspaceId, authorization.document_id),
      this.db
        .prepare(
          `DELETE FROM revision_metadata WHERE workspace_id = ? AND revision_id IN
             (SELECT id FROM revisions WHERE workspace_id = ? AND doc_id = ?)`
        )
        .bind(actor.workspaceId, actor.workspaceId, authorization.document_id),
      this.db
        .prepare("DELETE FROM current_fts WHERE workspace_id = ? AND document_id = ?")
        .bind(actor.workspaceId, authorization.document_id),
      this.db
        .prepare("DELETE FROM revisions WHERE workspace_id = ? AND doc_id = ?")
        .bind(actor.workspaceId, authorization.document_id),
      this.db
        .prepare("DELETE FROM documents WHERE workspace_id = ? AND id = ?")
        .bind(actor.workspaceId, authorization.document_id),
      this.db
        .prepare("DELETE FROM purge_authorizations WHERE id = ? AND workspace_id = ?")
        .bind(authorizationId, actor.workspaceId),
      this.db.prepare("PRAGMA defer_foreign_keys = OFF")
    ]);
    return { purgedRevisions };
  }

  private async readMetadata(workspaceId: string, revisionId: string): Promise<MetadataValue[]> {
    const rows = await this.db
      .prepare(
        `SELECT key, value, cardinality FROM revision_metadata
         WHERE workspace_id = ? AND revision_id = ? ORDER BY key, value`
      )
      .bind(workspaceId, revisionId)
      .all<MetadataValue>();
    return rows.results;
  }

  private async readLinks(workspaceId: string, revisionId: string): Promise<StoredLink[]> {
    const rows = await this.db
      .prepare(
        `SELECT rl.kind, rl.target_slug targetSlug,
                COALESCE(rl.target_document_id, target.id) targetDocumentId, rl.origin
         FROM revision_links rl
         LEFT JOIN documents target
           ON target.workspace_id = rl.workspace_id AND target.slug = rl.target_slug
         WHERE rl.workspace_id = ? AND rl.revision_id = ?
         ORDER BY rl.kind, rl.target_slug, rl.origin`
      )
      .bind(workspaceId, revisionId)
      .all<{
        kind: StoredLink["kind"];
        targetSlug: string;
        targetDocumentId: string | null;
        origin: StoredLink["origin"];
      }>();
    return rows.results;
  }

  private async findOperation(workspaceId: string, operationId: string): Promise<OperationRow | null> {
    return this.db
      .prepare(
        `SELECT request_hash, principal_id, kind, status, result_document_id, result_revision_id
         FROM operations WHERE workspace_id = ? AND operation_id = ?`
      )
      .bind(workspaceId, operationId)
      .first<OperationRow>();
  }

  private async replayResult(
    actor: ActorContext,
    request: IngestRequest,
    hash: string,
    operationKind: "ingest" | "link" | "restore",
    operation: OperationRow
  ): Promise<IngestResult> {
    if (
      operation.principal_id !== actor.principalId ||
      operation.kind !== operationKind ||
      operation.request_hash !== hash
    ) {
      throw new DomainError("idempotency_mismatch", "Operation ID was already used for a different request");
    }
    if (operation.status === "purged") throw new DomainError("gone", "The operation's document was permanently purged");
    if (operation.result_revision_id === null || operation.result_document_id === null) {
      throw new DomainError("internal_error", "Completed operation has no result");
    }
    const row = await this.db
      .prepare("SELECT revision_number FROM revisions WHERE workspace_id = ? AND id = ?")
      .bind(actor.workspaceId, operation.result_revision_id)
      .first<{ revision_number: number }>();
    if (row === null) throw new DomainError("internal_error", "Completed operation result is missing");
    return {
      documentId: operation.result_document_id,
      revisionId: operation.result_revision_id,
      revisionNumber: row.revision_number,
      slug: request.slug,
      idempotentReplay: true,
      unresolvedReferences: []
    };
  }
}
