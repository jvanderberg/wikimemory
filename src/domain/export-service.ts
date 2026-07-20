import { DomainError } from "./errors";
import { isRecord } from "./guards";
import type { ActorContext, DocumentType, LinkKind } from "./types";

const MAX_EXPORT_ROWS = 10_000;

function requireRead(actor: ActorContext): void {
  if (!actor.scopes.has("memory:read"))
    throw new DomainError("forbidden", "Missing required scope memory:read");
}

function safeAuditDetail(value: string): Record<string, string | number | boolean> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    const detail: Record<string, string | number | boolean> = {};
    if (typeof parsed["revisionNumber"] === "number")
      detail["revisionNumber"] = parsed["revisionNumber"];
    if (typeof parsed["creating"] === "boolean") detail["creating"] = parsed["creating"];
    if (typeof parsed["purgedRevisions"] === "number")
      detail["purgedRevisions"] = parsed["purgedRevisions"];
    if (typeof parsed["requestHash"] === "string") detail["requestHash"] = parsed["requestHash"];
    return detail;
  } catch {
    return {};
  }
}

function aliasMap(values: string[], prefix: string): Map<string, string> {
  return new Map(
    [...new Set(values)].sort().map((value, index) => [value, `${prefix}-${index + 1}`])
  );
}

function archiveLine(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

async function bounded<T>(statement: D1PreparedStatement, label: string): Promise<T[]> {
  const rows = await statement.all<T>();
  if (rows.results.length > MAX_EXPORT_ROWS)
    throw new DomainError("limit_exceeded", `${label} exceeds the export limit`);
  return rows.results;
}

interface PrincipalRow {
  id: string;
}
interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
}
interface MembershipRow {
  principal_id: string;
  role: string;
  created_at: string;
}
interface DocumentRow {
  id: string;
  type: DocumentType;
  slug: string;
  created_at: string;
}
interface RevisionRow {
  id: string;
  doc_id: string;
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
  request_hash: string;
  restored_from_revision_id: string | null;
}
interface MetadataRow {
  revision_id: string;
  key: string;
  value: string;
  cardinality: "singleton" | "multi";
}
interface LinkRow {
  revision_id: string;
  kind: LinkKind;
  target_slug: string;
  target_document_id: string | null;
  origin: "explicit" | "body";
}
interface AuditRow {
  id: string;
  kind: string;
  created_at: string;
  principal_id: string | null;
  client_id: string | null;
  agent_label: string | null;
  document_id: string | null;
  revision_id: string | null;
  request_id: string;
  detail_json: string;
}
interface TombstoneRow {
  operation_id: string;
  request_hash: string;
  principal_id: string;
  kind: string;
  created_at: string;
}

export class ExportService {
  constructor(private readonly db: D1Database) {}

  async jsonl(actor: ActorContext): Promise<string> {
    requireRead(actor);
    const [
      workspace,
      principals,
      memberships,
      documents,
      revisions,
      metadata,
      links,
      audits,
      tombstones
    ] = await Promise.all([
      this.db
        .prepare("SELECT id, name, created_at FROM workspaces WHERE id = ?")
        .bind(actor.workspaceId)
        .first<WorkspaceRow>(),
      bounded<PrincipalRow>(
        this.db
          .prepare(`SELECT DISTINCT p.id FROM principals p WHERE p.id IN (
        SELECT principal_id FROM memberships WHERE workspace_id = ?
        UNION SELECT principal_id FROM revisions WHERE workspace_id = ?
        UNION SELECT principal_id FROM audit_events WHERE workspace_id = ? AND principal_id IS NOT NULL
      ) ORDER BY p.id LIMIT ?`)
          .bind(actor.workspaceId, actor.workspaceId, actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "principals"
      ),
      bounded<MembershipRow>(
        this.db
          .prepare(
            "SELECT principal_id, role, created_at FROM memberships WHERE workspace_id = ? ORDER BY principal_id LIMIT ?"
          )
          .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "memberships"
      ),
      bounded<DocumentRow>(
        this.db
          .prepare(
            "SELECT id, type, slug, created_at FROM documents WHERE workspace_id = ? ORDER BY slug LIMIT ?"
          )
          .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "documents"
      ),
      bounded<RevisionRow>(
        this.db
          .prepare(`SELECT id, doc_id, revision_number, parent_revision_id, title, body, summary,
        created_at, principal_id, client_id, agent_label, reason, request_hash, restored_from_revision_id
        FROM revisions WHERE workspace_id = ? ORDER BY doc_id, revision_number LIMIT ?`)
          .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "revisions"
      ),
      bounded<MetadataRow>(
        this.db
          .prepare(
            "SELECT revision_id, key, value, cardinality FROM revision_metadata WHERE workspace_id = ? ORDER BY revision_id, key, value LIMIT ?"
          )
          .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "metadata values"
      ),
      bounded<LinkRow>(
        this.db
          .prepare(
            "SELECT revision_id, kind, target_slug, target_document_id, origin FROM revision_links WHERE workspace_id = ? ORDER BY revision_id, kind, target_slug, origin LIMIT ?"
          )
          .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "links"
      ),
      bounded<AuditRow>(
        this.db
          .prepare(`SELECT id, kind, created_at, principal_id, client_id, agent_label,
        document_id, revision_id, request_id, detail_json FROM audit_events
        WHERE workspace_id = ? ORDER BY created_at, id LIMIT ?`)
          .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "audit events"
      ),
      bounded<TombstoneRow>(
        this.db
          .prepare(`SELECT operation_id, request_hash, principal_id, kind, created_at
        FROM operations WHERE workspace_id = ? AND status = 'purged' ORDER BY created_at, operation_id LIMIT ?`)
          .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
        "purge tombstones"
      )
    ]);
    if (workspace === null) throw new DomainError("not_found", "Workspace does not exist");

    const actorAliases = aliasMap(
      principals.map((row) => row.id),
      "actor"
    );
    const clientAliases = aliasMap(
      [
        ...revisions.map((row) => row.client_id),
        ...audits.flatMap((row) => (row.client_id === null ? [] : [row.client_id]))
      ],
      "client"
    );
    const lines: string[] = [];
    lines.push(
      archiveLine({
        record: "manifest",
        format: "wikimemory-jsonl",
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        workspaceRef: "workspace-1",
        limits: { maxRowsPerKind: MAX_EXPORT_ROWS }
      })
    );
    lines.push(
      archiveLine({
        record: "workspace",
        workspaceRef: "workspace-1",
        name: workspace.name,
        createdAt: workspace.created_at
      })
    );
    for (const row of principals)
      lines.push(
        archiveLine({
          record: "principal",
          principalRef: actorAliases.get(row.id),
          label: actorAliases.get(row.id)
        })
      );
    for (const row of memberships)
      lines.push(
        archiveLine({
          record: "membership",
          workspaceRef: "workspace-1",
          principalRef: actorAliases.get(row.principal_id),
          role: row.role,
          createdAt: row.created_at
        })
      );
    for (const clientRef of clientAliases.values())
      lines.push(archiveLine({ record: "client", clientRef }));
    for (const row of documents)
      lines.push(
        archiveLine({
          record: "document",
          documentId: row.id,
          type: row.type,
          slug: row.slug,
          createdAt: row.created_at
        })
      );
    for (const row of revisions)
      lines.push(
        archiveLine({
          record: "revision",
          revisionId: row.id,
          documentId: row.doc_id,
          revisionNumber: row.revision_number,
          parentRevisionId: row.parent_revision_id,
          title: row.title,
          body: row.body,
          summary: row.summary,
          createdAt: row.created_at,
          principalRef: actorAliases.get(row.principal_id),
          clientRef: clientAliases.get(row.client_id),
          agentLabel: row.agent_label,
          reason: row.reason,
          requestHash: row.request_hash,
          restoredFromRevisionId: row.restored_from_revision_id
        })
      );
    for (const row of metadata)
      lines.push(
        archiveLine({
          record: "metadata",
          revisionId: row.revision_id,
          key: row.key,
          value: row.value,
          cardinality: row.cardinality
        })
      );
    for (const row of links)
      lines.push(
        archiveLine({
          record: "link",
          revisionId: row.revision_id,
          kind: row.kind,
          targetSlug: row.target_slug,
          targetDocumentId: row.target_document_id,
          origin: row.origin
        })
      );
    for (const row of audits)
      lines.push(
        archiveLine({
          record: "audit",
          auditId: row.id,
          kind: row.kind,
          createdAt: row.created_at,
          principalRef: row.principal_id === null ? null : actorAliases.get(row.principal_id),
          clientRef: row.client_id === null ? null : clientAliases.get(row.client_id),
          agentLabel: row.agent_label,
          documentId: row.document_id,
          revisionId: row.revision_id,
          requestId: row.request_id,
          detail: safeAuditDetail(row.detail_json)
        })
      );
    for (const row of tombstones)
      lines.push(
        archiveLine({
          record: "purge_tombstone",
          operationId: row.operation_id,
          requestHash: row.request_hash,
          principalRef: actorAliases.get(row.principal_id),
          kind: row.kind,
          createdAt: row.created_at
        })
      );
    return `${lines.join("\n")}\n`;
  }

  async markdown(actor: ActorContext): Promise<string> {
    requireRead(actor);
    const rows = await bounded<{
      slug: string;
      type: DocumentType;
      title: string;
      body: string;
      summary: string | null;
      revision_number: number;
      created_at: string;
    }>(
      this.db
        .prepare(`SELECT d.slug, d.type, r.title, r.body, r.summary, r.revision_number, r.created_at
      FROM documents d JOIN current_revisions r ON r.doc_id = d.id
      WHERE d.workspace_id = ? ORDER BY d.type, d.slug LIMIT ?`)
        .bind(actor.workspaceId, MAX_EXPORT_ROWS + 1),
      "documents"
    );
    const generatedAt = new Date().toISOString();
    const index = rows
      .map((row) => `- [${row.title}](#${row.slug}) — ${row.type}, revision ${row.revision_number}`)
      .join("\n");
    const pages = rows
      .map(
        (row) =>
          `\n---\n\n<a id="${row.slug}"></a>\n\n# ${row.title}\n\n- Slug: \`${row.slug}\`\n- Type: \`${row.type}\`\n- Revision: ${row.revision_number}\n- Updated: ${row.created_at}\n${row.summary === null ? "" : `\n> ${row.summary.replaceAll("\n", " ")}\n`}\n${row.body}\n`
      )
      .join("");
    return `# Wikimemory export\n\nGenerated ${generatedAt}. This is a current-state convenience export; JSONL is the lossless history archive.\n\n## Index\n\n${index || "_(empty)_"}\n${pages}`;
  }
}
