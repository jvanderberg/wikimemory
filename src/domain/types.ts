export const DOCUMENT_TYPES: readonly ["system", "project", "topic", "source", "note"] = [
  "system",
  "project",
  "topic",
  "source",
  "note"
];
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const LINK_KINDS: readonly ["related", "part_of", "supersedes", "cites", "contradicts"] = [
  "related",
  "part_of",
  "supersedes",
  "cites",
  "contradicts"
];
export type LinkKind = (typeof LINK_KINDS)[number];

export type MemoryScope = "memory:read" | "memory:write" | "memory:admin";

export interface ActorContext {
  workspaceId: string;
  principalId: string;
  clientId: string;
  agentLabel?: string;
  scopes: ReadonlySet<MemoryScope>;
  requestId: string;
}

export interface MetadataPatch {
  set?: Record<string, string | null>;
  multi?: Record<string, { replace?: string[]; add?: string[]; remove?: string[] }>;
}

export interface LinkValue {
  kind: LinkKind;
  targetSlug: string;
}

export interface LinkPatch {
  add?: LinkValue[];
  remove?: LinkValue[];
}

export interface IngestRequest {
  operationId: string;
  reason: string;
  slug: string;
  expectedRevisionId?: string;
  type?: DocumentType;
  title?: string;
  body?: string;
  summary?: string | null;
  metadata?: MetadataPatch;
  links?: LinkPatch;
}

export interface MetadataValue {
  key: string;
  value: string;
  cardinality: "singleton" | "multi";
}

export interface StoredLink extends LinkValue {
  origin: "explicit" | "body";
  targetDocumentId: string | null;
}

export interface DocumentSnapshot {
  documentId: string;
  workspaceId: string;
  slug: string;
  type: DocumentType;
  revisionId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  title: string;
  body: string;
  summary: string | null;
  createdAt: string;
  principalId: string;
  clientId: string;
  agentLabel: string | null;
  reason: string;
  restoredFromRevisionId: string | null;
  metadata: MetadataValue[];
  links: StoredLink[];
}

export interface DocumentIdentity {
  documentId: string;
  workspaceId: string;
  slug: string;
  type: DocumentType;
  createdAt: string;
}

export interface AdminCreateDocumentRequest {
  documentId?: string;
  slug: string;
  type: DocumentType;
  createdAt?: string;
}

export interface AdminAppendRevisionRequest {
  operationId: string;
  revisionId?: string;
  revisionNumber: number;
  parentRevisionId?: string | null;
  title: string;
  body: string;
  summary?: string | null;
  createdAt: string;
  sourceActor?: string | null;
  reason: string;
  restoredFromRevisionId?: string | null;
  metadata: MetadataValue[];
  links: StoredLink[];
}

export interface IngestResult {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
  slug: string;
  idempotentReplay: boolean;
  unresolvedReferences: string[];
}

export interface RestoreRequest {
  operationId: string;
  reason: string;
  slug: string;
  targetRevisionId: string;
  expectedRevisionId: string;
}

export interface LinkRequest {
  operationId: string;
  reason: string;
  sourceSlug: string;
  expectedRevisionId: string;
  action: "add" | "remove";
  link: LinkValue;
}

export interface ArchiveRequest {
  operationId: string;
  reason: string;
  slug: string;
  expectedRevisionId: string;
}

export interface OwnerContext extends ActorContext {
  role: "owner";
  reauthenticatedAt: string;
  credentialId?: string;
}

export interface PurgeAuthorization {
  id: string;
  documentId: string;
  slug: string;
  expiresAt: string;
}

export interface RecallHit {
  documentId: string;
  revisionId: string;
  slug: string;
  type: DocumentType;
  title: string;
  summary: string | null;
  snippet: string;
  score: number;
}

export interface DocumentIndexEntry {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
  slug: string;
  type: DocumentType;
  title: string;
  summary: string | null;
  updatedAt: string;
  status: string | null;
}

export interface RevisionHeader {
  revisionId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  createdAt: string;
  principalId: string;
  clientId: string;
  agentLabel: string | null;
  reason: string;
  restoredFromRevisionId: string | null;
  requestHash: string;
}

export interface LintFinding {
  kind: "unresolved_reference" | "orphan" | "missing_summary" | "stale_active_project";
  slug: string;
  detail: string;
}
