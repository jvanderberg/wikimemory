import { env } from "cloudflare:workers";
import { handleCrudApi } from "../src/api/crud";
import { ensureLocalOwner } from "../src/auth/local";
import type { DocumentSnapshot } from "../src/domain/types";

const origin = "https://memory.example";

function props(scopes: string[]) {
  return {
    workspaceId: "local-workspace",
    principalId: "local-owner",
    clientId: "crud-test",
    scopes
  };
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`${origin}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
}

describe("versioned CRUD API", () => {
  beforeEach(async () => {
    await ensureLocalOwner(env);
  });

  it("requires admin scope for writes while allowing read-scoped listing", async () => {
    const listed = await handleCrudApi(request("/api/v1/documents"), env, props(["memory:read"]));
    expect(listed.status).toBe(200);
    const denied = await handleCrudApi(
      request("/api/v1/documents", "POST", {
        slug: "read-only-create",
        type: "note"
      }),
      env,
      props(["memory:read"])
    );
    expect(denied.status).toBe(403);
  });

  it("creates identities and losslessly appends historical revisions with metadata and links", async () => {
    const admin = props(["memory:read", "memory:admin"]);
    for (const document of [
      {
        documentId: "crud-target-id",
        slug: "crud-target",
        type: "topic",
        createdAt: "2025-01-01T00:00:00Z"
      },
      {
        documentId: "crud-source-id",
        slug: "crud-source",
        type: "note",
        createdAt: "2025-01-02T00:00:00Z"
      }
    ]) {
      const created = await handleCrudApi(
        request("/api/v1/documents", "POST", document),
        env,
        admin
      );
      expect(created.status).toBe(201);
    }
    const first = await handleCrudApi(
      request("/api/v1/documents/crud-source/revisions", "POST", {
        operationId: "crud-source-r1",
        revisionId: "crud-source-revision-1",
        revisionNumber: 1,
        parentRevisionId: null,
        title: "First",
        body: "First body",
        summary: "First summary",
        createdAt: "2025-01-02T01:00:00Z",
        sourceActor: "legacy-agent",
        reason: "original creation",
        metadata: [
          { key: "status", value: "active", cardinality: "singleton" },
          { key: "tag", value: "one", cardinality: "multi" }
        ],
        links: [
          {
            kind: "related",
            targetSlug: "crud-target",
            origin: "explicit",
            targetDocumentId: "crud-target-id"
          }
        ]
      }),
      env,
      admin
    );
    expect(first.status).toBe(201);
    const invalidAncestry = await handleCrudApi(
      request("/api/v1/documents/crud-source", "PUT", {
        operationId: "crud-source-invalid-ancestry",
        revisionNumber: 2,
        parentRevisionId: "crud-source-revision-1",
        title: "Invalid ancestry",
        body: "Body",
        createdAt: "2025-02-01T00:00:00Z",
        reason: "test",
        restoredFromRevisionId: "missing-revision",
        metadata: [],
        links: []
      }),
      env,
      admin
    );
    expect(invalidAncestry.status).toBe(400);
    const second = await handleCrudApi(
      request("/api/v1/documents/crud-source", "PUT", {
        operationId: "crud-source-r2",
        revisionId: "crud-source-revision-2",
        revisionNumber: 2,
        parentRevisionId: "crud-source-revision-1",
        title: "Second",
        body: "Second body",
        summary: null,
        createdAt: "2025-02-03T04:05:06Z",
        sourceActor: "codex",
        reason: "historical update",
        restoredFromRevisionId: "crud-source-revision-1",
        metadata: [{ key: "tag", value: "two", cardinality: "multi" }],
        links: []
      }),
      env,
      admin
    );
    expect(second.status).toBe(201);

    const history = await handleCrudApi(
      request("/api/v1/documents/crud-source/revisions?limit=10"),
      env,
      admin
    );
    const payload = await history.json<{ items: DocumentSnapshot[] }>();
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]?.revisionId).toBe("crud-source-revision-1");
    expect(payload.items[0]?.createdAt).toBe("2025-01-02T01:00:00Z");
    expect(payload.items[0]?.agentLabel).toBe("legacy-agent");
    expect(payload.items[0]?.metadata).toContainEqual({
      key: "status",
      value: "active",
      cardinality: "singleton"
    });
    expect(payload.items[0]?.links).toContainEqual({
      kind: "related",
      targetSlug: "crud-target",
      targetDocumentId: "crud-target-id",
      origin: "explicit"
    });
    expect(payload.items[1]).toMatchObject({
      revisionId: "crud-source-revision-2",
      parentRevisionId: "crud-source-revision-1",
      restoredFromRevisionId: "crud-source-revision-1"
    });
    const replay = await handleCrudApi(
      request("/api/v1/documents/crud-source/revisions", "POST", {
        operationId: "crud-source-r1",
        revisionId: "crud-source-revision-1",
        revisionNumber: 1,
        parentRevisionId: null,
        title: "First",
        body: "First body",
        summary: "First summary",
        createdAt: "2025-01-02T01:00:00Z",
        sourceActor: "legacy-agent",
        reason: "original creation",
        metadata: [
          { key: "status", value: "active", cardinality: "singleton" },
          { key: "tag", value: "one", cardinality: "multi" }
        ],
        links: [
          {
            kind: "related",
            targetSlug: "crud-target",
            origin: "explicit",
            targetDocumentId: "crud-target-id"
          }
        ]
      }),
      env,
      admin
    );
    expect(replay.status).toBe(201);
    const metadata = await handleCrudApi(request("/api/v1/metadata"), env, admin);
    const metadataPayload = await metadata.json<{ items: Array<{ slug: string; key: string }> }>();
    expect(
      metadataPayload.items.some((item) => item.slug === "crud-source" && item.key === "tag")
    ).toBe(true);
    const links = await handleCrudApi(request("/api/v1/links"), env, admin);
    const linkPayload = await links.json<{ items: unknown[] }>();
    expect(Array.isArray(linkPayload.items)).toBe(true);
  });

  it("enforces the body limit in UTF-8 bytes", async () => {
    const admin = props(["memory:read", "memory:admin"]);
    await handleCrudApi(
      request("/api/v1/documents", "POST", { slug: "crud-bytes", type: "note" }),
      env,
      admin
    );
    const response = await handleCrudApi(
      request("/api/v1/documents/crud-bytes", "PUT", {
        operationId: "crud-bytes-r1",
        revisionNumber: 1,
        title: "Large UTF-8 body",
        body: "😀".repeat(70_000),
        createdAt: "2025-01-01T00:00:00Z",
        reason: "limit test",
        metadata: [],
        links: []
      }),
      env,
      admin
    );
    expect(response.status).toBe(400);
  });

  it("rejects altered idempotent replays and out-of-order history", async () => {
    const admin = props(["memory:read", "memory:admin"]);
    await handleCrudApi(
      request("/api/v1/documents", "POST", { slug: "crud-conflict", type: "note" }),
      env,
      admin
    );
    const revision = {
      operationId: "crud-conflict-r1",
      revisionNumber: 1,
      parentRevisionId: null,
      title: "One",
      body: "Body",
      createdAt: "2025-01-01T00:00:00Z",
      reason: "create",
      metadata: [],
      links: []
    };
    expect(
      (
        await handleCrudApi(
          request("/api/v1/documents/crud-conflict/revisions", "POST", revision),
          env,
          admin
        )
      ).status
    ).toBe(201);
    const altered = await handleCrudApi(
      request("/api/v1/documents/crud-conflict/revisions", "POST", {
        ...revision,
        body: "Changed"
      }),
      env,
      admin
    );
    expect(altered.status).toBe(409);
    const skipped = await handleCrudApi(
      request("/api/v1/documents/crud-conflict/revisions", "POST", {
        ...revision,
        operationId: "skip",
        revisionNumber: 3,
        parentRevisionId: null
      }),
      env,
      admin
    );
    expect(skipped.status).toBe(409);
  });
});
