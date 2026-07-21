import { z } from "zod";
import type {
  AdminAppendRevisionRequest,
  AdminCreateDocumentRequest,
  DocumentIdentity,
  DocumentSnapshot
} from "../src/domain/types.ts";

const identitySchema = z
  .object({
    documentId: z.string(),
    workspaceId: z.string(),
    slug: z.string(),
    type: z.enum(["system", "project", "topic", "source", "note"]),
    createdAt: z.string()
  })
  .strict();
const metadataSchema = z
  .object({ key: z.string(), value: z.string(), cardinality: z.enum(["singleton", "multi"]) })
  .strict();
const linkSchema = z
  .object({
    kind: z.enum(["related", "part_of", "supersedes", "cites", "contradicts"]),
    targetSlug: z.string(),
    origin: z.enum(["explicit", "body"]),
    targetDocumentId: z.string().nullable()
  })
  .strict();
const snapshotSchema = z
  .object({
    documentId: z.string(),
    workspaceId: z.string(),
    slug: z.string(),
    type: z.enum(["system", "project", "topic", "source", "note"]),
    revisionId: z.string(),
    revisionNumber: z.number().int().positive(),
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
    metadata: z.array(metadataSchema),
    links: z.array(linkSchema)
  })
  .strict();

const currentMetadataSchema = z
  .object({
    slug: z.string(),
    revisionId: z.string(),
    key: z.string(),
    value: z.string(),
    cardinality: z.enum(["singleton", "multi"])
  })
  .strict();
const currentLinkSchema = linkSchema.extend({ slug: z.string(), revisionId: z.string() }).strict();

export type CurrentMetadata = z.infer<typeof currentMetadataSchema>;
export type CurrentLink = z.infer<typeof currentLinkSchema>;

export class WikimemoryApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class WikimemoryClient {
  readonly origin: string;
  private readonly accessToken: string;
  private readonly fetchFn: typeof fetch;
  constructor(origin: string, accessToken: string, fetchFn: typeof fetch = fetch) {
    this.origin = origin.replace(/\/$/u, "");
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.accessToken}`);
    if (init?.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchFn(`${this.origin}/api/v1${path}`, { ...init, headers });
    const value: unknown = await response.json();
    if (!response.ok) {
      const message =
        typeof value === "object" &&
        value !== null &&
        "message" in value &&
        typeof value.message === "string"
          ? value.message
          : `Wikimemory API returned HTTP ${response.status}`;
      throw new WikimemoryApiError(response.status, message);
    }
    return value;
  }
  async listDocuments(): Promise<DocumentIdentity[]> {
    const all: DocumentIdentity[] = [];
    let after: string | null = null;
    do {
      const page = z
        .object({ items: z.array(identitySchema), next: z.string().nullable() })
        .strict()
        .parse(
          await this.request(
            `/documents?limit=100${after === null ? "" : `&after=${encodeURIComponent(after)}`}`
          )
        );
      all.push(...page.items);
      after = page.next;
    } while (after !== null);
    return all;
  }
  async getDocument(
    slug: string
  ): Promise<{ identity: DocumentIdentity; current: DocumentSnapshot | null }> {
    return z
      .object({ identity: identitySchema, current: snapshotSchema.nullable() })
      .strict()
      .parse(await this.request(`/documents/${encodeURIComponent(slug)}`));
  }
  async createDocument(input: AdminCreateDocumentRequest): Promise<DocumentIdentity> {
    return identitySchema.parse(
      await this.request("/documents", { method: "POST", body: JSON.stringify(input) })
    );
  }
  async listRevisions(slug: string): Promise<DocumentSnapshot[]> {
    const all: DocumentSnapshot[] = [];
    let after = 0;
    for (;;) {
      const page = z
        .object({ items: z.array(snapshotSchema), next: z.number().int().nullable() })
        .strict()
        .parse(
          await this.request(
            `/documents/${encodeURIComponent(slug)}/revisions?limit=100&after=${after}`
          )
        );
      all.push(...page.items);
      if (page.next === null) return all;
      after = page.next;
    }
  }
  async getRevision(slug: string, revisionId: string): Promise<DocumentSnapshot> {
    return snapshotSchema.parse(
      await this.request(
        `/documents/${encodeURIComponent(slug)}/revisions/${encodeURIComponent(revisionId)}`
      )
    );
  }
  async appendRevision(slug: string, input: AdminAppendRevisionRequest): Promise<DocumentSnapshot> {
    return snapshotSchema.parse(
      await this.request(`/documents/${encodeURIComponent(slug)}/revisions`, {
        method: "POST",
        body: JSON.stringify(input)
      })
    );
  }
  async deleteDocument(slug: string): Promise<void> {
    z.object({ purgedRevisions: z.number().int().nonnegative() })
      .strict()
      .parse(
        await this.request(
          `/documents/${encodeURIComponent(slug)}?confirm=${encodeURIComponent(slug)}`,
          { method: "DELETE" }
        )
      );
  }
  async listCurrentMetadata(): Promise<CurrentMetadata[]> {
    return z
      .object({ items: z.array(currentMetadataSchema) })
      .strict()
      .parse(await this.request("/metadata")).items;
  }
  async listCurrentLinks(): Promise<CurrentLink[]> {
    return z
      .object({ items: z.array(currentLinkSchema) })
      .strict()
      .parse(await this.request("/links")).items;
  }
}
