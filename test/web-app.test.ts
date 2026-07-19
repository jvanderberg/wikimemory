import { env, exports } from "cloudflare:workers";
import { localOwnerActor } from "../src/auth/local";
import { MemoryService } from "../src/domain/memory-service";

const ORIGIN = "https://example.test";
const OWNER_COOKIE = "wm_local_web=owner";

function request(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

function ownerRequest(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("cookie", OWNER_COOKIE);
  return request(path, { ...init, headers });
}

function mutation(path: string, body?: object, method = "POST"): Request {
  return ownerRequest(path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

describe("web application JSON API", () => {
  it("authenticates the local owner and reports session state", async () => {
    const anonymous = await exports.default.fetch(request("/api/app/session"));
    expect(anonymous.status).toBe(200);
    await expect(anonymous.json()).resolves.toEqual({
      authenticated: false,
      environment: "local",
      loginUrl: "/app/login"
    });

    const denied = await exports.default.fetch(
      request("/api/app/login", { method: "POST", headers: { origin: "https://evil.test" } })
    );
    expect(denied.status).toBe(403);

    const login = await exports.default.fetch(
      request("/api/app/login", { method: "POST", headers: { origin: ORIGIN } })
    );
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("wm_local_web=owner");

    const authenticated = await exports.default.fetch(ownerRequest("/api/app/session"));
    await expect(authenticated.json()).resolves.toEqual({
      authenticated: true,
      environment: "local"
    });
  });

  it("browses, searches, exports, and reports recent revisions", async () => {
    const documents = await exports.default.fetch(ownerRequest("/api/app/documents"));
    expect(documents.status).toBe(200);
    const documentBody = await documents.json<{ items: Array<{ slug: string }> }>();
    expect(documentBody.items.map((item) => item.slug)).toEqual(
      expect.arrayContaining(["home", "now"])
    );

    const search = await exports.default.fetch(ownerRequest("/api/app/search?q=Wikimemory"));
    expect(search.status).toBe(200);
    const searchBody = await search.json<{ hits: Array<{ slug: string }> }>();
    expect(searchBody.hits.some((hit) => hit.slug === "home")).toBe(true);

    const recent = await exports.default.fetch(ownerRequest("/api/app/recent"));
    expect(recent.status).toBe(200);
    const recentBody = await recent.json<{ revisions: Array<{ slug: string }> }>();
    expect(recentBody.revisions.some((revision) => revision.slug === "now")).toBe(true);

    const markdown = await exports.default.fetch(ownerRequest("/api/app/export.md"));
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("content-disposition")).toMatch(
      /wikimemory-\d{4}-\d{2}-\d{2}\.md/u
    );
    expect(await markdown.text()).toContain("# Wikimemory home");

    const jsonl = await exports.default.fetch(ownerRequest("/api/app/export.jsonl"));
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get("content-type")).toContain("application/x-ndjson");
    const archive = new TextDecoder().decode(await jsonl.arrayBuffer());
    expect(archive).toContain('"record":"manifest"');
  });

  it("loads document history and performs restore through the web boundary", async () => {
    const service = new MemoryService(env.DB);
    const actor = localOwnerActor("web-api-test");
    const original = await service.ingest(actor, {
      operationId: "web-restore-create",
      reason: "create web restore fixture",
      slug: "web-restore-fixture",
      type: "note",
      title: "Original title",
      body: "Original body"
    });
    const current = await service.ingest(actor, {
      operationId: "web-restore-update",
      reason: "update web restore fixture",
      slug: "web-restore-fixture",
      expectedRevisionId: original.revisionId,
      title: "Current title",
      body: "Current body"
    });

    const historical = await exports.default.fetch(
      ownerRequest(`/api/app/docs/web-restore-fixture?revision=${original.revisionId}`)
    );
    expect(historical.status).toBe(200);
    const historicalBody = await historical.json<{
      document: { title: string };
      current: { revisionId: string };
      history: Array<{ revisionNumber: number }>;
    }>();
    expect(historicalBody.document.title).toBe("Original title");
    expect(historicalBody.current.revisionId).toBe(current.revisionId);
    expect(historicalBody.history).toHaveLength(2);

    const restored = await exports.default.fetch(
      mutation("/api/app/docs/web-restore-fixture/restore", {
        targetRevisionId: original.revisionId,
        expectedRevisionId: current.revisionId
      })
    );
    expect(restored.status).toBe(200);
    const restoredBody = await restored.json<{ revisionNumber: number }>();
    expect(restoredBody.revisionNumber).toBe(3);

    const currentAfterRestore = await exports.default.fetch(
      ownerRequest("/api/app/docs/web-restore-fixture")
    );
    const currentBody = await currentAfterRestore.json<{ document: { title: string } }>();
    expect(currentBody.document.title).toBe("Original title");
  });

  it("requires exact confirmation and purges through one-use authorization", async () => {
    const service = new MemoryService(env.DB);
    await service.ingest(localOwnerActor("web-api-test"), {
      operationId: "web-purge-create",
      reason: "create web purge fixture",
      slug: "web-purge-fixture",
      type: "note",
      title: "Purge fixture",
      body: "Content that should disappear"
    });

    const refused = await exports.default.fetch(
      mutation("/api/app/docs/web-purge-fixture/purge-authorize", { confirmation: "wrong" })
    );
    expect(refused.status).toBe(400);

    const authorized = await exports.default.fetch(
      mutation("/api/app/docs/web-purge-fixture/purge-authorize", {
        confirmation: "web-purge-fixture"
      })
    );
    expect(authorized.status).toBe(200);
    const authorization = await authorized.json<{ id: string }>();

    const purged = await exports.default.fetch(
      mutation("/api/app/docs/web-purge-fixture/purge-apply", {
        authorizationId: authorization.id
      })
    );
    expect(purged.status).toBe(200);
    await expect(purged.json()).resolves.toEqual({ purgedRevisions: 1 });

    const missing = await exports.default.fetch(ownerRequest("/api/app/docs/web-purge-fixture"));
    expect(missing.status).toBe(404);
  });

  it("lists local management state, validates mutations, and logs out", async () => {
    const manage = await exports.default.fetch(ownerRequest("/api/app/manage"));
    expect(manage.status).toBe(200);
    await expect(manage.json()).resolves.toMatchObject({ passkeys: [], sessions: [] });

    const malformedGrant = await exports.default.fetch(mutation("/api/app/grants", {}, "DELETE"));
    expect(malformedGrant.status).toBe(400);

    const crossOriginLogout = await exports.default.fetch(
      ownerRequest("/api/app/logout", { method: "POST", headers: { origin: "https://evil.test" } })
    );
    expect(crossOriginLogout.status).toBe(403);

    const logout = await exports.default.fetch(mutation("/api/app/logout"));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("wm_local_web=; ");

    const unknown = await exports.default.fetch(ownerRequest("/api/app/unknown"));
    expect(unknown.status).toBe(404);
  });
});
