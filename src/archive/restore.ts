import { isStarterRevision, type StarterSlug } from "../domain/starter-content.ts";
import type {
  AdminAppendRevisionRequest,
  AdminCreateDocumentRequest,
  DocumentIdentity,
  DocumentSnapshot
} from "../domain/types.ts";
import type { WikimemoryArchive } from "./format.ts";

export interface ArchiveApi {
  listDocuments(): Promise<DocumentIdentity[]>;
  createDocument(input: AdminCreateDocumentRequest): Promise<DocumentIdentity>;
  listRevisions(slug: string): Promise<DocumentSnapshot[]>;
  appendRevision(slug: string, input: AdminAppendRevisionRequest): Promise<DocumentSnapshot>;
  deleteDocument(slug: string): Promise<void>;
}

export interface RestoreConflict {
  slug: string;
  message: string;
}

export interface RestorePreview {
  documents: number;
  revisions: number;
  newDocuments: number;
  matchingDocuments: number;
  newRevisions: number;
  conflicts: RestoreConflict[];
  replacesStarterContent: boolean;
}

const starterSlugs: StarterSlug[] = ["home", "now"];

async function isPristineStarterTarget(
  api: ArchiveApi,
  existing: Map<string, DocumentIdentity>
): Promise<boolean> {
  if (existing.size !== starterSlugs.length) return false;
  return (
    await Promise.all(
      starterSlugs.map(async (slug) => {
        const document = existing.get(slug);
        if (document?.type !== "system") return false;
        const revisions = await api.listRevisions(slug);
        const revision = revisions.at(0);
        return (
          revisions.length === 1 && revision !== undefined && isStarterRevision(slug, revision)
        );
      })
    )
  ).every(Boolean);
}

function portable(revision: DocumentSnapshot): object {
  return {
    documentId: revision.documentId,
    slug: revision.slug,
    type: revision.type,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    parentRevisionId: revision.parentRevisionId,
    title: revision.title,
    body: revision.body,
    summary: revision.summary,
    createdAt: revision.createdAt,
    agentLabel: revision.agentLabel,
    reason: revision.reason,
    restoredFromRevisionId: revision.restoredFromRevisionId,
    metadata: revision.metadata
      .map((item) => ({ key: item.key, value: item.value, cardinality: item.cardinality }))
      .sort((a, b) =>
        `${a.key}\u0000${a.value}\u0000${a.cardinality}`.localeCompare(
          `${b.key}\u0000${b.value}\u0000${b.cardinality}`
        )
      ),
    links: revision.links
      .map((item) => ({
        kind: item.kind,
        targetSlug: item.targetSlug,
        targetDocumentId: item.targetDocumentId,
        origin: item.origin
      }))
      .sort((a, b) =>
        `${a.kind}\u0000${a.targetSlug}\u0000${a.origin}`.localeCompare(
          `${b.kind}\u0000${b.targetSlug}\u0000${b.origin}`
        )
      )
  };
}

export async function previewArchiveRestore(
  api: ArchiveApi,
  archive: WikimemoryArchive
): Promise<RestorePreview> {
  const existing = new Map((await api.listDocuments()).map((item) => [item.slug, item]));
  const conflicts: RestoreConflict[] = [];
  let newDocuments = 0;
  let matchingDocuments = 0;
  let newRevisions = 0;
  for (const document of archive.documents) {
    const present = existing.get(document.slug);
    const source = archive.revisions
      .filter((revision) => revision.documentId === document.documentId)
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
    if (present === undefined) {
      newDocuments += 1;
      newRevisions += source.length;
      continue;
    }
    if (present.documentId !== document.documentId || present.type !== document.type) {
      conflicts.push({
        slug: document.slug,
        message: "The target has a different document with this slug."
      });
      continue;
    }
    const revisions = await api.listRevisions(document.slug);
    const mismatch = revisions.findIndex(
      (revision, index) =>
        source[index] === undefined ||
        JSON.stringify(portable(source[index])) !== JSON.stringify(portable(revision))
    );
    if (mismatch >= 0 || revisions.length > source.length) {
      conflicts.push({
        slug: document.slug,
        message: `Revision ${mismatch >= 0 ? mismatch + 1 : source.length + 1} differs from the backup.`
      });
      continue;
    }
    matchingDocuments += 1;
    newRevisions += source.length - revisions.length;
  }
  const result: RestorePreview = {
    documents: archive.documents.length,
    revisions: archive.revisions.length,
    newDocuments,
    matchingDocuments,
    newRevisions,
    conflicts,
    replacesStarterContent: false
  };
  if (
    (conflicts.length > 0 || matchingDocuments !== existing.size) &&
    (await isPristineStarterTarget(api, existing))
  ) {
    return {
      documents: archive.documents.length,
      revisions: archive.revisions.length,
      newDocuments: archive.documents.length,
      matchingDocuments: 0,
      newRevisions: archive.revisions.length,
      conflicts: [],
      replacesStarterContent: true
    };
  }
  return result;
}

export async function restoreArchive(
  api: ArchiveApi,
  archive: WikimemoryArchive,
  replace: boolean
): Promise<number> {
  const existing = new Map(
    (await api.listDocuments()).map((document) => [document.slug, document])
  );
  if (replace) {
    for (const document of existing.values()) await api.deleteDocument(document.slug);
    existing.clear();
  } else {
    const preview = await previewArchiveRestore(api, archive);
    if (preview.replacesStarterContent) {
      for (const slug of starterSlugs) await api.deleteDocument(slug);
      existing.clear();
    }
    const conflict = preview.conflicts.at(0);
    if (conflict !== undefined)
      throw new Error(`Document conflict for ${conflict.slug}: ${conflict.message}`);
  }
  for (const document of archive.documents) {
    if (!existing.has(document.slug))
      await api.createDocument({
        documentId: document.documentId,
        slug: document.slug,
        type: document.type,
        createdAt: document.createdAt
      });
  }
  let imported = 0;
  for (const document of archive.documents) {
    const source = archive.revisions
      .filter((revision) => revision.documentId === document.documentId)
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
    const present = await api.listRevisions(document.slug);
    for (const revision of source.slice(present.length)) {
      await api.appendRevision(document.slug, {
        operationId: `archive-${archive.manifest.createdAt}-${revision.revisionId}`,
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        parentRevisionId: revision.parentRevisionId,
        title: revision.title,
        body: revision.body,
        summary: revision.summary,
        createdAt: revision.createdAt,
        sourceActor: revision.agentLabel,
        reason: revision.reason,
        restoredFromRevisionId: revision.restoredFromRevisionId,
        metadata: revision.metadata,
        links: revision.links
      });
      imported += 1;
    }
  }
  return imported;
}
