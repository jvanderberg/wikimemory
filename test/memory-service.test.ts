import { env } from "cloudflare:workers";
import type { DomainError } from "../src/domain/errors";
import { ExportService } from "../src/domain/export-service";
import { isRecord } from "../src/domain/guards";
import { MemoryService, normalizeSourceUrl } from "../src/domain/memory-service";
import type {
  ActorContext,
  IngestRequest,
  OwnerContext,
  RestoreRequest
} from "../src/domain/types";

const testEnv = env;

async function fixture(label: string): Promise<{ actor: ActorContext; service: MemoryService }> {
  const principalId = `principal-${label}`;
  const workspaceId = `workspace-${label}`;
  const createdAt = "2026-07-18T12:00:00Z";
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO principals(id, provider, provider_subject, email, email_verified, created_at) VALUES (?, 'local', ?, ?, 1, ?)"
    ).bind(principalId, principalId, `${label}@example.test`, createdAt),
    testEnv.DB.prepare("INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)").bind(
      workspaceId,
      label,
      createdAt
    ),
    testEnv.DB.prepare(
      "INSERT INTO memberships(workspace_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)"
    ).bind(workspaceId, principalId, createdAt)
  ]);
  return {
    actor: {
      workspaceId,
      principalId,
      clientId: "test-client",
      agentLabel: "test-agent",
      scopes: new Set(["memory:read", "memory:write", "memory:admin"]),
      requestId: crypto.randomUUID()
    },
    service: new MemoryService(testEnv.DB)
  };
}

describe("MemoryService", () => {
  it("isolates documents and search results by authenticated workspace", async () => {
    const left = await fixture("isolation-left");
    const right = await fixture("isolation-right");
    await left.service.ingest(left.actor, {
      operationId: "private-left",
      reason: "workspace isolation fixture",
      slug: "private-memory",
      type: "note",
      title: "Private memory",
      body: "Unique narwhal context"
    });
    await expect(right.service.get(right.actor, "private-memory")).rejects.toMatchObject({
      code: "not_found"
    } satisfies Partial<DomainError>);
    await expect(right.service.recall(right.actor, "narwhal")).resolves.toEqual([]);
  });

  it("creates, reads, searches, and idempotently replays a revision", async () => {
    const { actor, service } = await fixture("create");
    const request: IngestRequest = {
      operationId: "op-create",
      reason: "capture the database choice",
      slug: "cloud-storage",
      type: "topic",
      title: "Cloud storage",
      body: "D1 provides SQLite-compatible full text search.",
      summary: "D1 is the selected cloud store.",
      metadata: { multi: { tag: { add: ["cloud", "sqlite"] } } }
    };
    const created = await service.ingest(actor, request);
    expect(created).toMatchObject({ revisionNumber: 1, idempotentReplay: false });

    const replay = await service.ingest(actor, request);
    expect(replay).toMatchObject({ revisionId: created.revisionId, idempotentReplay: true });

    const document = await service.get(actor, "cloud-storage");
    expect(document.metadata.map(({ value }) => value)).toEqual(["cloud", "sqlite"]);
    expect(document.body).toContain("full text search");

    const hits = await service.recall(actor, "SQLite search");
    expect(hits.map(({ slug }) => slug)).toContain("cloud-storage");
  });

  it("boosts exact phrases, normalizes scores, and recalls symbol-only queries", async () => {
    const { actor, service } = await fixture("recall-quality");
    await service.ingest(actor, {
      operationId: "recall-repetition",
      reason: "ranking control",
      slug: "repetitive",
      type: "note",
      title: "Repetitive fixture",
      body: "phosphor badger ".repeat(100)
    });
    await service.ingest(actor, {
      operationId: "recall-exact",
      reason: "exact title fixture",
      slug: "exact-title",
      type: "note",
      title: "Phosphor Badger",
      body: "One concise reference. 🧪"
    });

    const ranked = await service.recall(actor, "phosphor badger");
    expect(ranked[0]?.slug).toBe("exact-title");
    expect(ranked.every((hit) => hit.score >= 0 && hit.score <= 1)).toBe(true);
    await expect(service.recall(actor, "🧪")).resolves.toEqual([
      expect.objectContaining({ slug: "exact-title" })
    ]);
  });

  it("supports declared custom singleton metadata and exact source URL discovery", async () => {
    const { actor, service } = await fixture("source-metadata");
    const sourceUrl = "https://example.org/reports/annual-review-2026";
    const created = await service.ingest(actor, {
      operationId: "source-metadata-create",
      reason: "capture attributed source",
      slug: "annual-review",
      type: "source",
      title: "Annual review",
      body: "A durable source summary.",
      metadata: {
        set: { source_url: sourceUrl, author: "Example Author", published: "2026-07-18" },
        multi: { tag: { add: ["research"] } }
      }
    });

    const document = await service.get(actor, "annual-review");
    expect(document.metadata).toEqual(
      expect.arrayContaining([
        { key: "author", value: "Example Author", cardinality: "singleton" },
        { key: "published", value: "2026-07-18", cardinality: "singleton" },
        { key: "tag", value: "research", cardinality: "multi" }
      ])
    );
    await expect(service.recallBySourceUrl(actor, sourceUrl)).resolves.toEqual([
      expect.objectContaining({ slug: "annual-review", revisionId: created.revisionId })
    ]);
    await expect(
      service.ingest(actor, {
        operationId: "source-metadata-invalid-switch",
        reason: "try invalid cardinality switch",
        slug: "annual-review",
        expectedRevisionId: created.revisionId,
        metadata: { multi: { author: { add: ["Another Author"] } } }
      })
    ).rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<DomainError>);
  });

  it("carries snapshots forward and rejects stale expected revisions", async () => {
    const { actor, service } = await fixture("conflict");
    const first = await service.ingest(actor, {
      operationId: "op-1",
      reason: "create",
      slug: "project-one",
      type: "project",
      title: "Project One",
      body: "Initial state",
      metadata: { set: { status: "active" } }
    });
    const second = await service.ingest(actor, {
      operationId: "op-2",
      reason: "finish project",
      slug: "project-one",
      expectedRevisionId: first.revisionId,
      summary: "The project is complete.",
      metadata: { set: { status: "done" } }
    });
    expect(second.revisionNumber).toBe(2);
    const current = await service.get(actor, "project-one");
    expect(current.body).toBe("Initial state");
    expect(current.metadata).toContainEqual({
      key: "status",
      value: "done",
      cardinality: "singleton"
    });

    await expect(
      service.ingest(actor, {
        operationId: "op-stale",
        reason: "stale write",
        slug: "project-one",
        expectedRevisionId: first.revisionId,
        body: "stale"
      })
    ).rejects.toMatchObject({ code: "revision_conflict" } satisfies Partial<DomainError>);
  });

  it("keeps unresolved body references while requiring explicit targets", async () => {
    const { actor, service } = await fixture("links");
    const result = await service.ingest(actor, {
      operationId: "op-link-body",
      reason: "record an unresolved idea",
      slug: "origin",
      type: "note",
      title: "Origin",
      body: "See [[future-page]]."
    });
    expect(result.unresolvedReferences).toEqual(["future-page"]);
    const doc = await service.get(actor, "origin");
    expect(doc.links).toContainEqual({
      kind: "related",
      targetSlug: "future-page",
      targetDocumentId: null,
      origin: "body"
    });

    const target = await service.ingest(actor, {
      operationId: "op-link-target",
      reason: "materialize deferred target",
      slug: "future-page",
      type: "note",
      title: "Future page",
      body: "The target now exists."
    });
    const resolved = await service.get(actor, "origin");
    expect(resolved.links).toContainEqual({
      kind: "related",
      targetSlug: "future-page",
      targetDocumentId: target.documentId,
      origin: "body"
    });

    await expect(
      service.ingest(actor, {
        operationId: "op-explicit-missing",
        reason: "bad explicit target",
        slug: "origin",
        expectedRevisionId: result.revisionId,
        links: { add: [{ kind: "cites", targetSlug: "missing" }] }
      })
    ).rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<DomainError>);
  });

  it("rejects secret-like content before persistence", async () => {
    const { actor, service } = await fixture("secrets");
    await expect(
      service.ingest(actor, {
        operationId: "op-secret",
        reason: "should fail",
        slug: "bad-secret",
        type: "note",
        title: "Bad secret",
        body: "AKIAIOSFODNN7EXAMPLE"
      })
    ).rejects.toMatchObject({ code: "secret_detected" } satisfies Partial<DomainError>);
    await expect(service.get(actor, "bad-secret")).rejects.toMatchObject({
      code: "not_found"
    } satisfies Partial<DomainError>);
  });

  it("marks new source material untrusted unless trust is explicit", async () => {
    const { actor, service } = await fixture("source-trust");
    await service.ingest(actor, {
      operationId: "source-default-trust",
      reason: "capture outside material",
      slug: "outside-source",
      type: "source",
      title: "Outside source",
      body: "Untrusted external text."
    });
    await expect(service.get(actor, "outside-source")).resolves.toMatchObject({
      metadata: [{ key: "trust", value: "untrusted", cardinality: "singleton" }]
    });
  });

  it("enforces revision and audit immutability in SQL", async () => {
    const { actor, service } = await fixture("immutable");
    const created = await service.ingest(actor, {
      operationId: "op-immutable",
      reason: "create",
      slug: "immutable",
      type: "topic",
      title: "Immutable",
      body: "Original"
    });
    await expect(
      testEnv.DB.prepare("UPDATE revisions SET body = 'changed' WHERE id = ?")
        .bind(created.revisionId)
        .run()
    ).rejects.toThrow("revisions are immutable");
    await expect(
      testEnv.DB.prepare("DELETE FROM audit_events WHERE revision_id = ?")
        .bind(created.revisionId)
        .run()
    ).rejects.toThrow("audit events are append-only");
    await expect(
      testEnv.DB.prepare("DELETE FROM revisions WHERE id = ?").bind(created.revisionId).run()
    ).rejects.toThrow("revision deletion requires purge authorization");
  });

  it("indexes current pages, returns revision headers, and classifies lint findings", async () => {
    const { actor, service } = await fixture("catalog");
    const first = await service.ingest(actor, {
      operationId: "catalog-1",
      reason: "create unlinked page",
      slug: "catalog-page",
      type: "topic",
      title: "Catalog page",
      body: "See [[not-created]]."
    });
    await service.ingest(actor, {
      operationId: "catalog-2",
      reason: "record a second revision",
      slug: "catalog-page",
      expectedRevisionId: first.revisionId,
      body: "Still see [[not-created]]."
    });

    const index = await service.index(actor);
    expect(index).toContainEqual(
      expect.objectContaining({ slug: "catalog-page", revisionNumber: 2 })
    );
    const history = await service.history(actor, "catalog-page");
    expect(history.map(({ revisionNumber }) => revisionNumber)).toEqual([2, 1]);
    const lint = await service.lint(actor);
    expect(lint).toContainEqual(
      expect.objectContaining({ kind: "unresolved_reference", slug: "catalog-page" })
    );
    expect(lint).toContainEqual(
      expect.objectContaining({ kind: "missing_summary", slug: "catalog-page" })
    );
  });

  it("restores by appending a compensating revision", async () => {
    const { actor, service } = await fixture("restore");
    const first = await service.ingest(actor, {
      operationId: "restore-1",
      reason: "first state",
      slug: "restorable",
      type: "topic",
      title: "Restorable",
      body: "First body",
      metadata: { set: { status: "active" } }
    });
    const second = await service.ingest(actor, {
      operationId: "restore-2",
      reason: "second state",
      slug: "restorable",
      expectedRevisionId: first.revisionId,
      body: "Second body",
      metadata: { set: { status: "done" } }
    });
    const restoreRequest: RestoreRequest = {
      operationId: "restore-3",
      reason: "return to the first state",
      slug: "restorable",
      targetRevisionId: first.revisionId,
      expectedRevisionId: second.revisionId
    };
    const restored = await service.restore(actor, restoreRequest);
    expect(restored.revisionNumber).toBe(3);

    const replay = await service.restore(actor, restoreRequest);
    expect(replay).toMatchObject({
      documentId: restored.documentId,
      revisionId: restored.revisionId,
      revisionNumber: restored.revisionNumber,
      idempotentReplay: true
    });
    await expect(service.history(actor, "restorable")).resolves.toHaveLength(3);
    await expect(
      service.restore(actor, { ...restoreRequest, reason: "different operation payload" })
    ).rejects.toMatchObject({ code: "idempotency_mismatch" } satisfies Partial<DomainError>);
    await expect(
      service.restore(actor, { ...restoreRequest, operationId: "restore-stale" })
    ).rejects.toMatchObject({ code: "revision_conflict" } satisfies Partial<DomainError>);
    await expect(
      service.restore(actor, {
        ...restoreRequest,
        operationId: "restore-missing-expected",
        expectedRevisionId: "missing-revision"
      })
    ).rejects.toMatchObject({ code: "revision_conflict" } satisfies Partial<DomainError>);

    const current = await service.get(actor, "restorable");
    expect(current.body).toBe("First body");
    expect(current.restoredFromRevisionId).toBe(first.revisionId);
    expect(current.metadata).toContainEqual({
      key: "status",
      value: "active",
      cardinality: "singleton"
    });
  });

  it("purges content while preserving replay tombstones and sanitized audit", async () => {
    const { actor, service } = await fixture("purge");
    const createRequest: IngestRequest = {
      operationId: "purge-create",
      reason: "create disposable memory",
      slug: "disposable",
      type: "note",
      title: "Disposable",
      body: "This content must disappear."
    };
    await service.ingest(actor, createRequest);
    const owner: OwnerContext = {
      ...actor,
      role: "owner",
      reauthenticatedAt: new Date().toISOString()
    };
    const authorization = await service.authorizePurge(owner, "disposable", "disposable");
    await expect(service.purge(owner, authorization.id, "disposable")).resolves.toEqual({
      purgedRevisions: 1
    });
    await expect(service.get(actor, "disposable")).rejects.toMatchObject({
      code: "not_found"
    } satisfies Partial<DomainError>);
    await expect(service.ingest(actor, createRequest)).rejects.toMatchObject({
      code: "gone"
    } satisfies Partial<DomainError>);
    const tombstone = await testEnv.DB.prepare(
      "SELECT status, result_document_id FROM operations WHERE workspace_id = ? AND operation_id = ?"
    )
      .bind(actor.workspaceId, createRequest.operationId)
      .first<{ status: string; result_document_id: string | null }>();
    expect(tombstone).toEqual({ status: "purged", result_document_id: null });
    const audit = await testEnv.DB.prepare(
      "SELECT detail_json FROM audit_events WHERE workspace_id = ? AND kind = 'purge'"
    )
      .bind(actor.workspaceId)
      .first<{ detail_json: string }>();
    expect(audit?.detail_json).not.toContain(createRequest.body);
  });

  it("exports lossless JSONL with archive-local attribution and readable current Markdown", async () => {
    const { actor, service } = await fixture("export");
    const first = await service.ingest(actor, {
      operationId: "export-1",
      reason: "first exported state",
      slug: "exported-page",
      type: "topic",
      title: "Exported page",
      body: "First historical body",
      summary: "Portable current context"
    });
    await service.ingest(actor, {
      operationId: "export-2",
      reason: "second exported state",
      slug: "exported-page",
      expectedRevisionId: first.revisionId,
      body: "Current exported body"
    });
    await service.ingest(actor, {
      operationId: "export-purge",
      reason: "create purge export fixture",
      slug: "purged-export",
      type: "note",
      title: "Purged export",
      body: "This must not remain in the archive"
    });
    const owner: OwnerContext = {
      ...actor,
      role: "owner",
      reauthenticatedAt: new Date().toISOString()
    };
    const authorization = await service.authorizePurge(owner, "purged-export", "purged-export");
    await service.purge(owner, authorization.id, "purged-export");
    await testEnv.DB.prepare(`INSERT INTO audit_events(id, workspace_id, kind, created_at, principal_id, client_id, request_id, detail_json)
      VALUES (?, ?, 'future-kind', ?, ?, ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        actor.workspaceId,
        new Date().toISOString(),
        actor.principalId,
        actor.clientId,
        crypto.randomUUID(),
        JSON.stringify({ unexpected: "do-not-export-this-detail" })
      )
      .run();

    const exporter = new ExportService(testEnv.DB);
    const jsonl = await exporter.jsonl(actor);
    const records = jsonl
      .trim()
      .split("\n")
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("Export line is not a JSON object");
        return parsed;
      });
    expect(records[0]).toMatchObject({ record: "manifest", schemaVersion: 1 });
    expect(records.filter((record) => record["record"] === "revision")).toHaveLength(2);
    expect(records).toContainEqual(
      expect.objectContaining({ record: "purge_tombstone", operationId: "export-purge" })
    );
    expect(jsonl).toContain("First historical body");
    expect(jsonl).toContain("Current exported body");
    expect(jsonl).not.toContain("This must not remain in the archive");
    expect(jsonl).not.toContain("principal-export");
    expect(jsonl).not.toContain("export@example.test");
    expect(jsonl).not.toContain("test-client");
    expect(jsonl).not.toContain("do-not-export-this-detail");
    expect(jsonl).toContain('"clientRef":"client-1"');

    const markdown = await exporter.markdown(actor);
    expect(markdown).toContain("Current exported body");
    expect(markdown).not.toContain("First historical body");
    expect(markdown).not.toContain("purged-export");
  });

  it("passes non-URL and non-http provenance values through normalization untouched", () => {
    // Values that are not parseable absolute http(s) URLs must round-trip unchanged,
    // so non-URL provenance (ISBNs, internal identifiers) survives ingest.
    expect(normalizeSourceUrl("  not a url at all  ")).toBe("not a url at all");
    expect(normalizeSourceUrl("isbn:978-0131103627")).toBe("isbn:978-0131103627");
    expect(normalizeSourceUrl("mailto:someone@example.test")).toBe("mailto:someone@example.test");
    expect(normalizeSourceUrl("http://example.com:80/a/")).toBe("http://example.com/a");
    expect(normalizeSourceUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeSourceUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeSourceUrl("https://example.com/a?b=2&a=1")).toBe(
      "https://example.com/a?a=1&b=2"
    );
  });

  it("rejects explicit self-referential links and keeps self-linked pages orphaned", async () => {
    const { actor, service } = await fixture("self-link");
    const created = await service.ingest(actor, {
      operationId: "self-link-1",
      reason: "create a page with no links",
      slug: "self-linker",
      type: "project",
      title: "Self linker",
      summary: "Page used to prove self-edges are refused.",
      body: "No outbound references here."
    });

    await expect(
      service.link(actor, {
        operationId: "self-link-2",
        reason: "attempt a self-supersede",
        sourceSlug: "self-linker",
        expectedRevisionId: created.revisionId,
        action: "add",
        link: { kind: "supersedes", targetSlug: "self-linker" }
      })
    ).rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<DomainError>);

    // The page must still be reported as an orphan; a self-edge must never satisfy the rule.
    const lint = await service.lint(actor);
    expect(lint).toContainEqual(expect.objectContaining({ kind: "orphan", slug: "self-linker" }));
  });

  it("requires an explicit expected revision when revising an existing document", async () => {
    const { actor, service } = await fixture("expected-revision");
    await service.ingest(actor, {
      operationId: "expected-1",
      reason: "create the page",
      slug: "guarded-page",
      type: "note",
      title: "Guarded page",
      body: "Original body"
    });

    await expect(
      service.ingest(actor, {
        operationId: "expected-2",
        reason: "attempt a blind overwrite",
        slug: "guarded-page",
        body: "Clobbered body"
      })
    ).rejects.toMatchObject({
      code: "revision_conflict",
      message: "expectedRevisionId is required when revising an existing document"
    } satisfies Partial<DomainError>);

    const snapshot = await service.get(actor, "guarded-page");
    expect(snapshot.body).toBe("Original body");
  });

  it("canonicalizes source URLs so tracking parameters resolve to one page", async () => {
    const { actor, service } = await fixture("source-url");
    await service.ingest(actor, {
      operationId: "source-url-1",
      reason: "store a source with tracking noise",
      slug: "canonical-source",
      type: "source",
      title: "Canonical source",
      summary: "Source stored with a tracking parameter.",
      body: "Body of the source document.",
      metadata: {
        set: { source_url: "https://Example.COM/docs/guide/?utm_source=news&gclid=xyz&page=2#frag" }
      }
    });

    const snapshot = await service.get(actor, "canonical-source");
    expect(snapshot.metadata).toContainEqual(
      expect.objectContaining({ key: "source_url", value: "https://example.com/docs/guide?page=2" })
    );

    for (const lookup of [
      "https://example.com/docs/guide?page=2",
      "https://example.com/docs/guide/?page=2&utm_campaign=spring",
      "https://Example.com/docs/guide?page=2#other"
    ]) {
      const hits = await service.recallBySourceUrl(actor, lookup);
      expect(hits.map(({ slug }) => slug)).toEqual(["canonical-source"]);
    }

    const miss = await service.recallBySourceUrl(actor, "https://example.com/docs/other");
    expect(miss).toEqual([]);
  });

  it("explains the required format when a metadata key is malformed", async () => {
    const { actor, service } = await fixture("metadata-key");
    await expect(
      service.ingest(actor, {
        operationId: "metadata-key-1",
        reason: "use a camelCase metadata key",
        slug: "metadata-key-page",
        type: "source",
        title: "Metadata key page",
        body: "Body",
        metadata: { set: { sourceUrl: "https://example.com/a" } }
      })
    ).rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<DomainError>);

    await expect(
      service.ingest(actor, {
        operationId: "metadata-key-2",
        reason: "use a camelCase metadata key",
        slug: "metadata-key-page",
        type: "source",
        title: "Metadata key page",
        body: "Body",
        metadata: { set: { sourceUrl: "https://example.com/a" } }
      })
    ).rejects.toThrow(/lowercase snake_case/);
  });
});
