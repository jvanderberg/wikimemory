import { z } from "zod";

const documentType = z.enum(["system", "project", "topic", "source", "note"]);
const metadata = z.object({
  key: z.string(),
  value: z.string(),
  cardinality: z.enum(["singleton", "multi"])
});
const link = z.object({
  kind: z.enum(["related", "part_of", "supersedes", "cites", "contradicts"]),
  targetSlug: z.string(),
  origin: z.enum(["explicit", "body"]),
  targetDocumentId: z.string().nullable()
});
const document = z.object({
  documentId: z.string(),
  workspaceId: z.string(),
  slug: z.string(),
  type: documentType,
  revisionId: z.string(),
  revisionNumber: z.number().int(),
  parentRevisionId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  summary: z.string().nullable(),
  createdAt: z.string(),
  principalId: z.string(),
  clientId: z.string(),
  agentLabel: z.string().nullable(),
  reason: z.string(),
  restoredFromRevisionId: z.string().nullable(),
  metadata: z.array(metadata),
  links: z.array(link)
});
const indexEntry = z.object({
  documentId: z.string(),
  revisionId: z.string(),
  revisionNumber: z.number().int(),
  slug: z.string(),
  type: documentType,
  title: z.string(),
  summary: z.string().nullable(),
  updatedAt: z.string(),
  status: z.string().nullable()
});
const revision = z.object({
  revisionId: z.string(),
  revisionNumber: z.number().int(),
  parentRevisionId: z.string().nullable(),
  createdAt: z.string(),
  principalId: z.string(),
  clientId: z.string(),
  agentLabel: z.string().nullable(),
  reason: z.string(),
  restoredFromRevisionId: z.string().nullable(),
  requestHash: z.string()
});
const finding = z.object({
  kind: z.enum(["unresolved_reference", "orphan", "missing_summary", "stale_active_project"]),
  slug: z.string(),
  detail: z.string()
});
const storedContentTrust = z.literal("untrusted");
const restoreDifference = z.object({
  field: z.enum(["title", "body", "summary", "metadata", "links"]),
  currentPreview: z.string().nullable(),
  targetPreview: z.string().nullable(),
  currentCharacters: z.number().int().nonnegative(),
  targetCharacters: z.number().int().nonnegative(),
  currentTruncated: z.boolean(),
  targetTruncated: z.boolean()
});
const ingestResult = {
  documentId: z.string(),
  revisionId: z.string(),
  revisionNumber: z.number().int(),
  slug: z.string(),
  idempotentReplay: z.boolean(),
  unresolvedReferences: z.array(z.string())
};

export const MCP_OUTPUT_SCHEMAS = {
  orient: {
    storedContentTrust,
    now: document,
    activeProjects: z.array(indexEntry),
    recentRevisions: z.array(
      z.object({
        slug: z.string(),
        revision_number: z.number().int(),
        created_at: z.string(),
        reason: z.string()
      })
    ),
    lintCounts: z.record(z.string(), z.number().int().nonnegative())
  },
  recall: {
    storedContentTrust,
    hits: z.array(
      z.object({
        documentId: z.string(),
        revisionId: z.string(),
        slug: z.string(),
        type: documentType,
        title: z.string(),
        summary: z.string().nullable(),
        snippet: z.string(),
        score: z.number().min(0).max(1)
      })
    )
  },
  get: {
    ...document.shape,
    nextCursor: z.string().nullable(),
    storedContentTrust,
    linkResolution: z.literal("current_workspace_state")
  },
  index: { items: z.array(indexEntry), nextCursor: z.string().nullable(), storedContentTrust },
  history: { revisions: z.array(revision), storedContentTrust },
  lint: { findings: z.array(finding) },
  ingest: ingestResult,
  link: ingestResult,
  archive: ingestResult,
  restore_preview: {
    slug: z.string(),
    targetRevisionId: z.string(),
    expectedCurrentRevisionId: z.string(),
    titleChanged: z.boolean(),
    bodyChanged: z.boolean(),
    summaryChanged: z.boolean(),
    metadataChanged: z.boolean(),
    linksChanged: z.boolean(),
    storedContentTrust,
    differences: z.array(restoreDifference).max(5)
  },
  restore_apply: ingestResult
} satisfies Record<string, z.ZodRawShape>;
