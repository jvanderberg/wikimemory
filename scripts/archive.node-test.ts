import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikimemoryArchive } from "../src/archive/format.ts";
import type {
  AdminAppendRevisionRequest,
  AdminCreateDocumentRequest,
  DocumentIdentity,
  DocumentSnapshot
} from "../src/domain/types.ts";
import { type ArchiveApi, restoreArchive } from "./archive.ts";

const identity: DocumentIdentity = {
  documentId: "source-document",
  workspaceId: "archive-workspace",
  slug: "source-note",
  type: "note",
  createdAt: "2025-01-01T00:00:00Z"
};

const revision = (number: number): DocumentSnapshot => ({
  ...identity,
  revisionId: `source-revision-${number}`,
  revisionNumber: number,
  parentRevisionId: number === 1 ? null : `source-revision-${number - 1}`,
  title: `Revision ${number}`,
  body: `Body ${number}`,
  summary: null,
  createdAt: `2025-01-0${number}T00:00:00Z`,
  principalId: "archive-actor",
  clientId: "archive-client",
  agentLabel: "importer",
  reason: "archive restore",
  restoredFromRevisionId: number === 1 ? null : "source-revision-1",
  metadata: [],
  links: []
});

const archive: WikimemoryArchive = {
  manifest: {
    format: "wikimemory-archive",
    formatVersion: 1,
    createdBy: { wikimemoryVersion: "0.3.0", databaseSchemaVersion: "0004.sql" },
    createdAt: "2026-07-21T00:00:00Z",
    counts: { documents: 1, revisions: 2 },
    files: {}
  },
  documents: [identity],
  revisions: [revision(1), revision(2)]
};

class FakeApi implements ArchiveApi {
  readonly documents = new Map<string, DocumentIdentity>();
  readonly revisions = new Map<string, DocumentSnapshot[]>();
  readonly deleted: string[] = [];

  listDocuments(): Promise<DocumentIdentity[]> {
    return Promise.resolve([...this.documents.values()]);
  }
  createDocument(input: AdminCreateDocumentRequest): Promise<DocumentIdentity> {
    const value: DocumentIdentity = {
      documentId: input.documentId ?? "generated",
      workspaceId: "target-workspace",
      slug: input.slug,
      type: input.type,
      createdAt: input.createdAt ?? "generated"
    };
    this.documents.set(value.slug, value);
    return Promise.resolve(value);
  }
  listRevisions(slug: string): Promise<DocumentSnapshot[]> {
    return Promise.resolve(this.revisions.get(slug) ?? []);
  }
  appendRevision(slug: string, input: AdminAppendRevisionRequest): Promise<DocumentSnapshot> {
    const document = this.documents.get(slug);
    assert.ok(document);
    const value: DocumentSnapshot = {
      ...document,
      revisionId: input.revisionId ?? "generated",
      revisionNumber: input.revisionNumber,
      parentRevisionId: input.parentRevisionId ?? null,
      title: input.title,
      body: input.body,
      summary: input.summary ?? null,
      createdAt: input.createdAt,
      principalId: "target-owner",
      clientId: "api-client",
      agentLabel: input.sourceActor ?? null,
      reason: input.reason,
      restoredFromRevisionId: input.restoredFromRevisionId ?? null,
      metadata: input.metadata,
      links: input.links
    };
    this.revisions.set(slug, [...(this.revisions.get(slug) ?? []), value]);
    return Promise.resolve(value);
  }
  deleteDocument(slug: string): Promise<void> {
    this.deleted.push(slug);
    this.documents.delete(slug);
    this.revisions.delete(slug);
    return Promise.resolve();
  }
}

await describe("archive restore", async () => {
  await it("stops on identity conflicts without deleting target data", async () => {
    const api = new FakeApi();
    api.documents.set("source-note", { ...identity, documentId: "different-id" });
    await assert.rejects(() => restoreArchive(api, archive, false), /Document conflict/u);
    assert.deepEqual(api.deleted, []);
  });

  await it("explicit replacement removes seeds and restores exact history resumably", async () => {
    const api = new FakeApi();
    api.documents.set("home", {
      documentId: "seed-home",
      workspaceId: "target-workspace",
      slug: "home",
      type: "system",
      createdAt: "2026-01-01T00:00:00Z"
    });
    assert.equal(await restoreArchive(api, archive, true), 2);
    assert.deepEqual(api.deleted, ["home"]);
    assert.equal(
      api.revisions.get("source-note")?.[1]?.restoredFromRevisionId,
      "source-revision-1"
    );
    assert.equal(await restoreArchive(api, archive, false), 0);
  });
});
