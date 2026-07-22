import { env, exports } from "cloudflare:workers";
import { createArchive, readArchive } from "../src/archive/format";
import { localOwnerActor } from "../src/auth/local";
import { MemoryService } from "../src/domain/memory-service";
import type { DocumentIdentity, DocumentSnapshot } from "../src/domain/types";

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

async function createLocalGrant(): Promise<void> {
  const registered = await exports.default.fetch(
    request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Web management test client",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    })
  );
  expect(registered.status).toBe(201);
  const { client_id: clientId } = await registered.json<{ client_id: string }>();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://client.example/callback",
    scope: "memory:read",
    state: "manage-test",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`
  });
  const authorization = await exports.default.fetch(
    request(`/authorize?${query.toString()}`, { redirect: "manual" })
  );
  expect(authorization.status).toBe(302);
  const consent = new URL(authorization.headers.get("location") ?? ORIGIN);
  const approval = await exports.default.fetch(
    request(`/api/local-authorize/approve?${consent.searchParams.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{}"
    })
  );
  expect(approval.status).toBe(200);
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

    const protectedRoute = await exports.default.fetch(request("/api/app/manage"));
    expect(protectedRoute.status).toBe(401);
  });

  it("browses, searches, and reports recent revisions", async () => {
    const documents = await exports.default.fetch(ownerRequest("/api/app/documents"));
    expect(documents.status).toBe(200);
    const documentBody = await documents.json<{
      items: Array<{ slug: string; project: string | null }>;
    }>();
    expect(documentBody.items.map((item) => item.slug)).toEqual(
      expect.arrayContaining(["home", "now"])
    );
    expect(documentBody.items.find((item) => item.slug === "home")?.project).toBeNull();
    const afterHome = await exports.default.fetch(ownerRequest("/api/app/documents?after=home"));
    const afterHomeBody = await afterHome.json<{ items: Array<{ slug: string }> }>();
    expect(afterHomeBody.items.some((item) => item.slug === "home")).toBe(false);
    expect(afterHomeBody.items.some((item) => item.slug === "now")).toBe(true);
    const emptySearch = await exports.default.fetch(ownerRequest("/api/app/search"));
    expect(emptySearch.status).toBe(200);

    const search = await exports.default.fetch(ownerRequest("/api/app/search?q=Wikimemory"));
    expect(search.status).toBe(200);
    const searchBody = await search.json<{ hits: Array<{ slug: string }> }>();
    expect(searchBody.hits.some((hit) => hit.slug === "home")).toBe(true);

    const recent = await exports.default.fetch(ownerRequest("/api/app/recent"));
    expect(recent.status).toBe(200);
    const recentBody = await recent.json<{
      revisions: Array<{ slug: string; type: string; title: string }>;
    }>();
    expect(recentBody.revisions.some((revision) => revision.slug === "now")).toBe(true);
    expect(recentBody.revisions.find((revision) => revision.slug === "now")).toMatchObject({
      type: "system",
      title: "Now"
    });
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
    await createLocalGrant();
    const manage = await exports.default.fetch(ownerRequest("/api/app/manage"));
    expect(manage.status).toBe(200);
    const management = await manage.json<{
      passkeys: unknown[];
      sessions: unknown[];
      clients: Array<{ clientName: string }>;
    }>();
    expect(management).toMatchObject({ passkeys: [], sessions: [] });
    expect(management.clients).toContainEqual(
      expect.objectContaining({ clientName: "Web management test client" })
    );

    const malformedGrant = await exports.default.fetch(mutation("/api/app/grants", {}, "DELETE"));
    expect(malformedGrant.status).toBe(400);
    const wrongGrantType = await exports.default.fetch(
      mutation("/api/app/grants", { grantId: 42 }, "DELETE")
    );
    expect(wrongGrantType.status).toBe(400);

    const missingBody = await exports.default.fetch(
      ownerRequest("/api/app/docs/home/restore", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "null"
      })
    );
    expect(missingBody.status).toBe(400);
    expect((await exports.default.fetch(ownerRequest("/api/app/docs/"))).status).not.toBe(200);

    const crossOriginLogout = await exports.default.fetch(
      ownerRequest("/api/app/logout", { method: "POST", headers: { origin: "https://evil.test" } })
    );
    expect(crossOriginLogout.status).toBe(403);

    const logout = await exports.default.fetch(mutation("/api/app/logout"));
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("wm_local_web=; ");

    const unknown = await exports.default.fetch(ownerRequest("/api/app/unknown"));
    expect(unknown.status).toBe(404);
    expect((await exports.default.fetch(ownerRequest("/api/app/export.jsonl"))).status).toBe(404);
    expect((await exports.default.fetch(ownerRequest("/api/app/export.md"))).status).toBe(404);
  });

  it("downloads, previews, and restores a complete ZIP backup", async () => {
    const downloaded = await exports.default.fetch(ownerRequest("/api/app/backup"));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain(".wmem.zip");
    const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
    const current = await readArchive(downloadedBytes);
    expect(current.documents.map((item) => item.slug)).toEqual(
      expect.arrayContaining(["home", "now"])
    );
    const downloadedForm = new FormData();
    downloadedForm.set(
      "backup",
      new File([downloadedBytes], "downloaded.wmem.zip", {
        type: "application/zip"
      })
    );
    const unchangedPreview = await exports.default.fetch(
      ownerRequest("/api/app/restore/preview", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: downloadedForm
      })
    );
    expect(unchangedPreview.status).toBe(200);
    await expect(unchangedPreview.json()).resolves.toMatchObject({
      preview: {
        newDocuments: 0,
        newRevisions: 0,
        conflicts: [],
        replacesStarterContent: false
      }
    });
    const invalidForm = new FormData();
    invalidForm.set("backup", new File(["not a zip"], "broken.wmem.zip"));
    const invalid = await exports.default.fetch(
      ownerRequest("/api/app/restore/preview", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: invalidForm
      })
    );
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json<{ error: string; message: string }>();
    expect(invalidBody.error).toBe("validation_failed");
    expect(invalidBody.message).toContain("Backup is invalid");
    const missingFile = await exports.default.fetch(
      ownerRequest("/api/app/restore/preview", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: new FormData()
      })
    );
    expect(missingFile.status).toBe(400);

    const conflictingIdentity: DocumentIdentity = {
      documentId: "different-home-identity",
      workspaceId: "archive-workspace",
      slug: "home",
      type: "system",
      createdAt: "2026-07-21T11:00:00Z"
    };
    const conflictingRevision: DocumentSnapshot = {
      ...conflictingIdentity,
      revisionId: "different-home-revision",
      revisionNumber: 1,
      parentRevisionId: null,
      title: "Different home",
      body: "Conflicting content",
      summary: null,
      principalId: "archive-private",
      clientId: "archive-private",
      agentLabel: null,
      reason: "conflict fixture",
      restoredFromRevisionId: null,
      metadata: [],
      links: []
    };
    const conflictBytes = await createArchive(
      [conflictingIdentity],
      [conflictingRevision],
      "test-schema"
    );
    const conflictForm = new FormData();
    conflictForm.set("backup", new File([conflictBytes], "conflict.wmem.zip"));
    const conflict = await exports.default.fetch(
      ownerRequest("/api/app/restore", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: conflictForm
      })
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "revision_conflict" });

    const identity: DocumentIdentity = {
      documentId: "web-archive-document",
      workspaceId: "archive-workspace",
      slug: "web-archive-note",
      type: "note",
      createdAt: "2026-07-21T12:00:00Z"
    };
    const revision: DocumentSnapshot = {
      ...identity,
      revisionId: "web-archive-revision-1",
      revisionNumber: 1,
      parentRevisionId: null,
      title: "Restored through the web",
      body: "Complete archived content",
      summary: "Web archive fixture",
      principalId: "archive-private",
      clientId: "archive-private",
      agentLabel: "archive-test",
      reason: "test web archive restore",
      restoredFromRevisionId: null,
      metadata: [{ key: "tag", value: "archive", cardinality: "multi" }],
      links: []
    };
    const bytes = await createArchive([identity], [revision], "test-schema");
    function upload(path: string, fields: Record<string, string> = {}): Request {
      const form = new FormData();
      form.set("backup", new File([bytes], "fixture.wmem.zip", { type: "application/zip" }));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      return ownerRequest(path, { method: "POST", headers: { origin: ORIGIN }, body: form });
    }

    const preview = await exports.default.fetch(upload("/api/app/restore/preview"));
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      preview: { newDocuments: 1, newRevisions: 1, conflicts: [] }
    });

    const restored = await exports.default.fetch(upload("/api/app/restore"));
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toEqual({
      restored: true,
      documents: 1,
      newRevisions: 1
    });
    const document = await exports.default.fetch(ownerRequest("/api/app/docs/web-archive-note"));
    expect(document.status).toBe(200);
    await expect(document.json()).resolves.toMatchObject({
      document: { title: "Restored through the web", body: "Complete archived content" }
    });

    const refusedReplacement = await exports.default.fetch(
      upload("/api/app/restore", { replace: "true", confirmation: "wrong" })
    );
    expect(refusedReplacement.status).toBe(400);

    const replacementForm = new FormData();
    replacementForm.set(
      "backup",
      new File([downloadedBytes], "downloaded.wmem.zip", { type: "application/zip" })
    );
    replacementForm.set("replace", "true");
    replacementForm.set("confirmation", "wikimemory-local");
    const replaced = await exports.default.fetch(
      ownerRequest("/api/app/restore", {
        method: "POST",
        headers: { origin: ORIGIN },
        body: replacementForm
      })
    );
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toEqual({
      restored: true,
      documents: current.documents.length,
      newRevisions: current.revisions.length
    });
    const removed = await exports.default.fetch(ownerRequest("/api/app/docs/web-archive-note"));
    expect(removed.status).not.toBe(200);
    const loginAfterReplacement = await exports.default.fetch(
      request("/api/app/login", { method: "POST", headers: { origin: ORIGIN } })
    );
    expect(loginAfterReplacement.status).toBe(200);
  });
});
