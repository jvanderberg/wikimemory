import { strToU8, unzipSync, zipSync } from "fflate";
import { createArchive, readArchive } from "../src/archive/format";
import type { DocumentIdentity, DocumentSnapshot } from "../src/domain/types";

const identity: DocumentIdentity = {
  documentId: "archive-doc",
  workspaceId: "workspace",
  slug: "archive-note",
  type: "note",
  createdAt: "2025-01-01T00:00:00Z"
};
const revision = (number: number, body: string): DocumentSnapshot => ({
  documentId: identity.documentId,
  workspaceId: identity.workspaceId,
  slug: identity.slug,
  type: identity.type,
  revisionId: `archive-revision-${number}`,
  revisionNumber: number,
  parentRevisionId: number === 1 ? null : `archive-revision-${number - 1}`,
  title: `Revision ${number}`,
  body,
  summary: number === 1 ? "Initial" : null,
  createdAt: `2025-01-0${number}T00:00:00Z`,
  principalId: "private-principal",
  clientId: "private-client",
  agentLabel: "codex",
  reason: `reason ${number}`,
  restoredFromRevisionId: number === 1 ? null : "archive-revision-1",
  metadata: [
    { key: "project", value: "wikimemory", cardinality: "singleton" },
    { key: "tag", value: `tag-${number}`, cardinality: "multi" }
  ],
  links: [{ kind: "related", targetSlug: "target", origin: "explicit", targetDocumentId: null }]
});

describe("Wikimemory ZIP archive", () => {
  it("round trips complete history in human-readable Markdown with a versioned manifest", async () => {
    const bytes = await createArchive(
      [identity],
      [revision(1, "First body"), revision(2, "Second body")],
      "0004.sql",
      "2026-07-21T00:00:00Z"
    );
    const files = unzipSync(bytes);
    expect(Object.keys(files)[0]).toBe("manifest.json");
    expect(files["content/projects/wikimemory/notes/archive-note.md"]).toBeDefined();
    expect(files["history/archive-note/000001.md"]).toBeDefined();
    expect(new TextDecoder().decode(files["history/archive-note/000001.md"])).toContain(
      "metadata:"
    );
    const restored = await readArchive(bytes);
    expect(restored.manifest).toMatchObject({
      format: "wikimemory-archive",
      formatVersion: 1,
      counts: { documents: 1, revisions: 2 }
    });
    expect(
      restored.revisions.map((item) => ({
        id: item.revisionId,
        body: item.body,
        metadata: item.metadata,
        links: item.links
      }))
    ).toEqual([
      {
        id: "archive-revision-1",
        body: "First body",
        metadata: revision(1, "").metadata,
        links: revision(1, "").links
      },
      {
        id: "archive-revision-2",
        body: "Second body",
        metadata: revision(2, "").metadata,
        links: revision(2, "").links
      }
    ]);
    expect(JSON.stringify(restored)).not.toContain("private-principal");
    expect(JSON.stringify(restored)).not.toContain("private-client");
    expect(new TextDecoder().decode(files["documents.json"])).not.toContain("workspace");
    expect(restored.revisions[1]?.restoredFromRevisionId).toBe("archive-revision-1");
  });

  it("rejects modified checksummed content and unsafe paths", async () => {
    const bytes = await createArchive([identity], [revision(1, "Body")], "schema");
    const files = unzipSync(bytes);
    files["history/archive-note/000001.md"] = strToU8("tampered");
    await expect(readArchive(zipSync(files))).rejects.toThrow("checksum failed");
    await expect(readArchive(zipSync({ "../escape": strToU8("bad") }))).rejects.toThrow(
      "Unsafe archive path"
    );
  });

  it("rejects undeclared files and non-contiguous history", async () => {
    const bytes = await createArchive([identity], [revision(1, "Body")], "schema");
    const files = unzipSync(bytes);
    files["undeclared.txt"] = strToU8("not in manifest");
    await expect(readArchive(zipSync(files))).rejects.toThrow("do not match its manifest");
    await expect(
      readArchive(await createArchive([identity], [revision(2, "Second only")], "schema"))
    ).rejects.toThrow("revision chain is invalid");
  });

  it("never derives a ZIP path from unsafe project metadata", async () => {
    const unsafe = revision(1, "Body");
    unsafe.metadata = [{ key: "project", value: "../../escape", cardinality: "singleton" }];
    const files = unzipSync(await createArchive([identity], [unsafe], "schema"));
    expect(files["content/unfiled/notes/archive-note.md"]).toBeDefined();
    expect(Object.keys(files).some((path) => path.includes(".."))).toBe(false);
  });
});
