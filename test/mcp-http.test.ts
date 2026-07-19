import { exports } from "cloudflare:workers";
import { z } from "zod";

const ORIGIN = "https://example.test";
const REDIRECT_URI = "https://client.example/callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function workerRequest(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  expect(response.ok).toBe(true);
  return schema.parse(await response.json());
}

function decodeEvent<T>(body: string, schema: z.ZodType<T>): T {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  return schema.parse(JSON.parse(data.at(-1) ?? body));
}

async function authorize(): Promise<string> {
  const registration = await responseJson(
    await workerRequest("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "MCP coverage client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    }),
    z.object({ client_id: z.string() })
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: REDIRECT_URI,
    scope: "memory:read memory:write memory:admin",
    state: "coverage-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`
  });
  const redirected = await workerRequest(`/authorize?${query.toString()}`, { redirect: "manual" });
  expect(redirected.status).toBe(302);
  const location = redirected.headers.get("location");
  expect(location).not.toBeNull();
  const consent = new URL(location ?? ORIGIN);

  const options = await responseJson(
    await workerRequest(`/api/local-authorize/options?${consent.searchParams.toString()}`),
    z.object({ clientName: z.string(), requestedScopes: z.array(z.string()) })
  );
  expect(options).toEqual({
    clientName: "MCP coverage client",
    requestedScopes: ["memory:read", "memory:write", "memory:admin"]
  });

  const approval = await responseJson(
    await workerRequest(`/api/local-authorize/approve?${consent.searchParams.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{}"
    }),
    z.object({ redirectTo: z.string() })
  );
  const callback = new URL(approval.redirectTo);
  expect(callback.searchParams.get("state")).toBe("coverage-state");
  const code = callback.searchParams.get("code");
  expect(code).not.toBeNull();

  const token = await responseJson(
    await workerRequest("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code: code ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: `${ORIGIN}/mcp`
      })
    }),
    z.object({ access_token: z.string() })
  );
  return token.access_token;
}

describe("authenticated Streamable HTTP MCP", () => {
  it("exercises every V1 tool through the protocol boundary", async () => {
    const accessToken = await authorize();
    const baseHeaders = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
    const initializeResponse = await workerRequest("/mcp", {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "mcp-coverage", version: "0.1.0" }
        }
      })
    });
    expect(initializeResponse.status).toBe(200);
    const initialize = decodeEvent(
      await initializeResponse.text(),
      z.object({ result: z.object({ serverInfo: z.object({ name: z.string() }) }) })
    );
    expect(initialize.result.serverInfo.name).toBe("wikimemory");
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    const headers = new Headers(baseHeaders);
    if (sessionId !== null) headers.set("mcp-session-id", sessionId);

    await workerRequest("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });

    let id = 2;
    async function rpc(method: string, params: object): Promise<unknown> {
      const response = await workerRequest("/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params })
      });
      expect(response.status).toBe(200);
      return decodeEvent(await response.text(), z.object({ result: z.unknown() })).result;
    }

    const tools = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(await rpc("tools/list", {}));
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "get",
      "history",
      "index",
      "ingest",
      "link",
      "lint",
      "orient",
      "recall",
      "restore_apply",
      "restore_preview"
    ]);

    const resultSchema = z.object({
      isError: z.boolean().optional(),
      structuredContent: z.record(z.string(), z.unknown())
    });
    async function tool(name: string, args: object): Promise<z.infer<typeof resultSchema>> {
      return resultSchema.parse(await rpc("tools/call", { name, arguments: args }));
    }

    const oriented = await tool("orient", {});
    expect(oriented.isError).not.toBe(true);
    expect(oriented.structuredContent).toHaveProperty("now");

    const first = await tool("ingest", {
      operationId: "mcp-http-create",
      reason: "create MCP HTTP fixture",
      slug: "mcp-http-fixture",
      type: "note",
      title: "MCP HTTP fixture",
      body: "First MCP boundary body",
      summary: "Exercises the real MCP adapter",
      singletonMetadata: { source_url: "https://example.test/mcp-http-fixture" },
      tags: ["coverage"]
    });
    expect(first.isError).not.toBe(true);
    const firstRevisionId = z.string().parse(first.structuredContent["revisionId"]);

    const second = await tool("ingest", {
      operationId: "mcp-http-update",
      reason: "update MCP HTTP fixture",
      slug: "mcp-http-fixture",
      expectedRevisionId: firstRevisionId,
      body: "Second MCP boundary body that is long enough to paginate"
    });
    const secondRevisionId = z.string().parse(second.structuredContent["revisionId"]);

    const recalled = await tool("recall", { query: "MCP boundary", limit: 10 });
    expect(recalled.structuredContent["hits"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "mcp-http-fixture" })])
    );
    const sourceRecall = await tool("recall", {
      sourceUrl: "https://example.test/mcp-http-fixture"
    });
    expect(sourceRecall.structuredContent["hits"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "mcp-http-fixture" })])
    );
    const noMatches = await tool("recall", { query: "definitely-absent-phrase" });
    expect(noMatches.structuredContent["hits"]).toEqual([]);

    const page = await tool("get", { slug: "mcp-http-fixture", maxCharacters: 12 });
    const nextCursor = z.string().parse(page.structuredContent["nextCursor"]);
    const continued = await tool("get", { slug: "mcp-http-fixture", cursor: nextCursor });
    expect(continued.isError).not.toBe(true);
    const invalidCursor = await tool("get", { slug: "mcp-http-fixture", cursor: "invalid" });
    expect(invalidCursor).toMatchObject({
      isError: true,
      structuredContent: { code: "validation_failed" }
    });
    const mismatchedCursor = await tool("get", { slug: "now", cursor: nextCursor });
    expect(mismatchedCursor).toMatchObject({
      isError: true,
      structuredContent: { code: "validation_failed" }
    });

    const indexed = await tool("index", { type: "note", limit: 1 });
    expect(indexed.structuredContent["items"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "mcp-http-fixture" })])
    );
    const indexCursor = z.string().parse(indexed.structuredContent["nextCursor"]);
    const nextIndexPage = await tool("index", { type: "note", limit: 1, cursor: indexCursor });
    expect(nextIndexPage.isError).not.toBe(true);
    const history = await tool("history", { slug: "mcp-http-fixture" });
    expect(history.structuredContent["revisions"]).toHaveLength(2);
    const missingHistory = await tool("history", { slug: "missing-mcp-document" });
    expect(missingHistory.isError).not.toBe(true);
    expect(missingHistory.structuredContent["revisions"]).toEqual([]);
    const lint = await tool("lint", { limit: 20 });
    expect(lint.structuredContent["findings"]).toBeInstanceOf(Array);

    const linked = await tool("link", {
      operationId: "mcp-http-link",
      reason: "link MCP HTTP fixture",
      sourceSlug: "mcp-http-fixture",
      expectedRevisionId: secondRevisionId,
      action: "add",
      kind: "related",
      targetSlug: "now"
    });
    const linkedRevisionId = z.string().parse(linked.structuredContent["revisionId"]);

    const unchangedPreview = await tool("restore_preview", {
      slug: "mcp-http-fixture",
      targetRevisionId: linkedRevisionId
    });
    expect(unchangedPreview.structuredContent).toMatchObject({
      bodyChanged: false,
      linksChanged: false
    });

    const preview = await tool("restore_preview", {
      slug: "mcp-http-fixture",
      targetRevisionId: firstRevisionId
    });
    expect(preview.structuredContent).toMatchObject({ bodyChanged: true, linksChanged: true });

    const restored = await tool("restore_apply", {
      operationId: "mcp-http-restore",
      reason: "restore MCP HTTP fixture",
      slug: "mcp-http-fixture",
      targetRevisionId: firstRevisionId,
      expectedCurrentRevisionId: linkedRevisionId
    });
    expect(restored.isError).not.toBe(true);
    expect(restored.structuredContent).toMatchObject({
      slug: "mcp-http-fixture",
      revisionNumber: 4
    });
  });
});
