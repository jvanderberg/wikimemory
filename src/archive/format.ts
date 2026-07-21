import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { DocumentIdentity, DocumentSnapshot, DocumentType } from "../domain/types.ts";
import { WIKIMEMORY_VERSION } from "../version.ts";

export const ARCHIVE_FORMAT_VERSION = 1;
export const ARCHIVE_FORMAT = "wikimemory-archive";

const manifestSchema = z
  .object({
    format: z.literal(ARCHIVE_FORMAT),
    formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
    createdBy: z
      .object({ wikimemoryVersion: z.string(), databaseSchemaVersion: z.string() })
      .strict(),
    createdAt: z.iso.datetime({ offset: false }),
    counts: z
      .object({
        documents: z.number().int().nonnegative(),
        revisions: z.number().int().nonnegative()
      })
      .strict(),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u))
  })
  .strict();

const identitySchema = z
  .object({
    documentId: z.string().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    type: z.enum(["system", "project", "topic", "source", "note"]),
    createdAt: z.iso.datetime({ offset: false })
  })
  .strict();

const revisionSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    type: z.enum(["system", "project", "topic", "source", "note"]),
    revisionId: z.string().min(1).max(200),
    revisionNumber: z.number().int().positive(),
    parentRevisionId: z.string().min(1).max(200).nullable(),
    title: z.string().min(1).max(300),
    summary: z.string().max(1000).nullable(),
    createdAt: z.iso.datetime({ offset: false }),
    sourceActor: z.string().max(200).nullable(),
    reason: z.string().min(1).max(500),
    restoredFromRevisionId: z.string().min(1).max(200).nullable(),
    metadata: z.array(
      z
        .object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
          value: z.string().max(4096),
          cardinality: z.enum(["singleton", "multi"])
        })
        .strict()
    ),
    links: z.array(
      z
        .object({
          kind: z.enum(["related", "part_of", "supersedes", "cites", "contradicts"]),
          targetSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          origin: z.enum(["explicit", "body"]),
          targetDocumentId: z.string().nullable()
        })
        .strict()
    )
  })
  .strict();

export type ArchiveManifest = z.infer<typeof manifestSchema>;

export interface WikimemoryArchive {
  manifest: ArchiveManifest;
  documents: DocumentIdentity[];
  revisions: DocumentSnapshot[];
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", source.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function plural(type: DocumentType): string {
  return type === "source" ? "sources" : `${type}s`;
}

function projectFor(revision: DocumentSnapshot): string | null {
  const project = revision.metadata.find((item) => item.key === "project")?.value;
  return project !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(project) ? project : null;
}

function contentPath(identity: DocumentIdentity, current: DocumentSnapshot): string {
  if (identity.type === "system") return `content/system/${identity.slug}.md`;
  if (identity.type === "project") return `content/projects/${identity.slug}/index.md`;
  const project = projectFor(current);
  return project === null
    ? `content/unfiled/${plural(identity.type)}/${identity.slug}.md`
    : `content/projects/${project}/${plural(identity.type)}/${identity.slug}.md`;
}

function revisionFrontmatter(
  identity: DocumentIdentity,
  revision: DocumentSnapshot
): Record<string, unknown> {
  return {
    documentId: identity.documentId,
    slug: identity.slug,
    type: identity.type,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    parentRevisionId: revision.parentRevisionId,
    title: revision.title,
    summary: revision.summary,
    createdAt: revision.createdAt,
    sourceActor: revision.agentLabel,
    reason: revision.reason,
    restoredFromRevisionId: revision.restoredFromRevisionId,
    metadata: revision.metadata,
    links: revision.links
  };
}

function markdown(identity: DocumentIdentity, revision: DocumentSnapshot): Uint8Array {
  return strToU8(
    `---\n${stringify(revisionFrontmatter(identity, revision), { lineWidth: 0 })}---\n\n${revision.body}`
  );
}

export async function createArchive(
  documents: DocumentIdentity[],
  revisions: DocumentSnapshot[],
  databaseSchemaVersion: string,
  createdAt = new Date().toISOString()
): Promise<Uint8Array> {
  const identities = new Map(documents.map((document) => [document.documentId, document]));
  const grouped = new Map<string, DocumentSnapshot[]>();
  for (const revision of revisions) {
    if (!identities.has(revision.documentId))
      throw new Error(`Revision ${revision.revisionId} has no document identity`);
    const values = grouped.get(revision.documentId) ?? [];
    values.push(revision);
    grouped.set(revision.documentId, values);
  }
  const files: Record<string, Uint8Array> = {};
  files["documents.json"] = strToU8(
    JSON.stringify(
      [...documents]
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map(({ documentId, slug, type, createdAt }) => ({ documentId, slug, type, createdAt })),
      null,
      2
    )
  );
  for (const identity of [...documents].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const history = (grouped.get(identity.documentId) ?? []).sort(
      (a, b) => a.revisionNumber - b.revisionNumber
    );
    for (const revision of history)
      files[`history/${identity.slug}/${String(revision.revisionNumber).padStart(6, "0")}.md`] =
        markdown(identity, revision);
    const current = history.at(-1);
    if (current !== undefined) files[contentPath(identity, current)] = markdown(identity, current);
  }
  const checksums: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files)) checksums[path] = await sha256(bytes);
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    createdBy: { wikimemoryVersion: WIKIMEMORY_VERSION, databaseSchemaVersion },
    createdAt,
    counts: { documents: documents.length, revisions: revisions.length },
    files: checksums
  };
  return zipSync(
    { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), ...files },
    { level: 6 }
  );
}

function parseMarkdown(bytes: Uint8Array): {
  attributes: z.infer<typeof revisionSchema>;
  body: string;
} {
  const value = strFromU8(bytes);
  if (!value.startsWith("---\n")) throw new Error("Archive Markdown is missing frontmatter");
  const end = value.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Archive Markdown has unterminated frontmatter");
  const raw: unknown = parse(value.slice(4, end), { maxAliasCount: 0 });
  return { attributes: revisionSchema.parse(raw), body: value.slice(end + 5).replace(/^\n/u, "") };
}

function validateRevisionCollections(revision: z.infer<typeof revisionSchema>, path: string): void {
  const metadata = new Set<string>();
  const singleton = new Set<string>();
  const cardinalities = new Map<string, "singleton" | "multi">();
  for (const item of revision.metadata) {
    const key = `${item.key}\u0000${item.value}`;
    const cardinality = cardinalities.get(item.key);
    if (
      metadata.has(key) ||
      (cardinality !== undefined && cardinality !== item.cardinality) ||
      (item.cardinality === "singleton" && singleton.has(item.key))
    )
      throw new Error(`Archive metadata is invalid: ${path}`);
    metadata.add(key);
    cardinalities.set(item.key, item.cardinality);
    if (item.cardinality === "singleton") singleton.add(item.key);
  }
  const links = new Set<string>();
  for (const link of revision.links) {
    const key = `${link.kind}\u0000${link.targetSlug}\u0000${link.origin}`;
    if (links.has(key)) throw new Error(`Archive links are invalid: ${path}`);
    links.add(key);
  }
}

export async function readArchive(bytes: Uint8Array): Promise<WikimemoryArchive> {
  if (bytes.byteLength > 512 * 1024 * 1024) throw new Error("Archive exceeds 512 MiB");
  let expandedBytes = 0;
  let entries = 0;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      if (
        entry.name.startsWith("/") ||
        entry.name.split("/").includes("..") ||
        entry.name.includes("\\")
      )
        throw new Error(`Unsafe archive path: ${entry.name}`);
      entries += 1;
      expandedBytes += entry.originalSize;
      if (entries > 100_000) throw new Error("Archive has too many entries");
      if (expandedBytes > 1024 * 1024 * 1024) throw new Error("Expanded archive exceeds 1 GiB");
      return true;
    }
  });
  if (Object.keys(files).length > 100_000) throw new Error("Archive has too many entries");
  const manifestBytes = files["manifest.json"];
  const documentsBytes = files["documents.json"];
  if (manifestBytes === undefined || documentsBytes === undefined)
    throw new Error("Archive manifest or document index is missing");
  const manifest = manifestSchema.parse(JSON.parse(strFromU8(manifestBytes)) as unknown);
  const archivePaths = Object.keys(files)
    .filter((path) => path !== "manifest.json")
    .sort();
  const declaredPaths = Object.keys(manifest.files).sort();
  if (JSON.stringify(archivePaths) !== JSON.stringify(declaredPaths))
    throw new Error("Archive files do not match its manifest");
  for (const [path, expected] of Object.entries(manifest.files)) {
    const content = files[path];
    if (content === undefined || (await sha256(content)) !== expected)
      throw new Error(`Archive checksum failed: ${path}`);
  }
  const documents: DocumentIdentity[] = z
    .array(identitySchema)
    .parse(JSON.parse(strFromU8(documentsBytes)) as unknown)
    .map((identity) => ({ ...identity, workspaceId: "archive-workspace" }));
  if (
    new Set(documents.map((document) => document.documentId)).size !== documents.length ||
    new Set(documents.map((document) => document.slug)).size !== documents.length
  )
    throw new Error("Archive contains duplicate document identities");
  const revisions: DocumentSnapshot[] = [];
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^history\/[^/]+\/\d{6}\.md$/u.test(path)) continue;
    const { attributes, body } = parseMarkdown(content);
    validateRevisionCollections(attributes, path);
    const identity = documents.find((item) => item.documentId === attributes.documentId);
    if (
      identity === undefined ||
      identity.slug !== attributes.slug ||
      identity.type !== attributes.type ||
      path !== `history/${identity.slug}/${String(attributes.revisionNumber).padStart(6, "0")}.md`
    )
      throw new Error(`Archive identity mismatch: ${path}`);
    if (new TextEncoder().encode(body).byteLength > 262_144)
      throw new Error(`Archive revision body exceeds 262144 UTF-8 bytes: ${path}`);
    revisions.push({
      documentId: identity.documentId,
      workspaceId: identity.workspaceId,
      slug: identity.slug,
      type: identity.type,
      revisionId: attributes.revisionId,
      revisionNumber: attributes.revisionNumber,
      parentRevisionId: attributes.parentRevisionId,
      title: attributes.title,
      body,
      summary: attributes.summary,
      createdAt: attributes.createdAt,
      principalId: "archive-actor",
      clientId: "archive-client",
      agentLabel: attributes.sourceActor,
      reason: attributes.reason,
      restoredFromRevisionId: attributes.restoredFromRevisionId,
      metadata: attributes.metadata,
      links: attributes.links
    });
  }
  if (
    documents.length !== manifest.counts.documents ||
    revisions.length !== manifest.counts.revisions
  )
    throw new Error("Archive record counts do not match its manifest");
  const identities = new Map(documents.map((document) => [document.documentId, document]));
  for (const document of documents) {
    const history = revisions
      .filter((revision) => revision.documentId === document.documentId)
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
    const prior = new Set<string>();
    for (const [index, revision] of history.entries()) {
      const expectedNumber = index + 1;
      const expectedParent = history[index - 1]?.revisionId ?? null;
      if (
        revision.revisionNumber !== expectedNumber ||
        revision.parentRevisionId !== expectedParent ||
        prior.has(revision.revisionId) ||
        (revision.restoredFromRevisionId !== null && !prior.has(revision.restoredFromRevisionId))
      )
        throw new Error(`Archive revision chain is invalid for ${document.slug}`);
      prior.add(revision.revisionId);
      for (const link of revision.links) {
        if (link.targetDocumentId === null) continue;
        const target = identities.get(link.targetDocumentId);
        if (target?.slug !== link.targetSlug)
          throw new Error(`Archive link identity is invalid in ${document.slug}`);
      }
    }
  }
  return { manifest, documents, revisions };
}
