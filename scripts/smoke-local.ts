import { z } from "zod";

const base = process.env["WIKIMEMORY_URL"] ?? "http://127.0.0.1:8787";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const redirectUri = "http://127.0.0.1:9876/callback";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json<T>(response: Response, label: string, schema: z.ZodType<T>): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text}`);
  return schema.parse(JSON.parse(text));
}

function decodeMcp<T>(payload: string, schema: z.ZodType<T>): T {
  const data = payload
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  return schema.parse(JSON.parse(data.at(-1) ?? payload));
}

const registrationSchema = z.object({ client_id: z.string() });
const tokenSchema = z.object({ access_token: z.string() });
const initializeSchema = z.object({ result: z.object({ serverInfo: z.object({ name: z.string() }) }) });
const toolsSchema = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) });
const basicToolResponseSchema = z.object({ result: z.object({ isError: z.boolean().optional() }) });

const registration = await json(
  await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Wikimemory local smoke test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  }),
  "client registration",
  registrationSchema
);
assert(typeof registration.client_id === "string", "registration returned no client_id");

const authorize = new URL(`${base}/authorize`);
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: registration.client_id,
  redirect_uri: redirectUri,
  scope: "memory:read memory:write",
  state: "smoke-state",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: `${base}/mcp`
}).toString();

const consent = await fetch(authorize, { redirect: "manual" });
assert(consent.ok, `consent page failed (${consent.status})`);
assert(consent.headers.get("content-security-policy")?.includes(new URL(redirectUri).origin), "consent CSP does not allow the validated callback origin");
const consentHtml = await consent.text();
const csrf = consentHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
const cookie = consent.headers.get("set-cookie")?.split(";", 1)[0];
assert(csrf && cookie, "consent page did not issue CSRF state");

const approval = await fetch(authorize, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie },
  body: new URLSearchParams({ csrf })
});
assert(approval.status === 302, `approval failed (${approval.status}): ${await approval.text()}`);
const callbackLocation = approval.headers.get("location");
assert(callbackLocation !== null, "approval returned no callback location");
const callback = new URL(callbackLocation);
assert(callback.searchParams.get("state") === "smoke-state", "OAuth state was not preserved");
const code = callback.searchParams.get("code");
assert(code, "approval returned no authorization code");

const token = await json(
  await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${base}/mcp`
    })
  }),
  "token exchange",
  tokenSchema
);
assert(typeof token.access_token === "string", "token exchange returned no access token");

const commonHeaders = {
  authorization: `Bearer ${token.access_token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream"
};
const initializeResponse = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: commonHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "wikimemory-smoke", version: "0.1.0" }
    }
  })
});
const initialize = decodeMcp(await initializeResponse.text(), initializeSchema);
assert(initialize.result.serverInfo.name === "wikimemory", "MCP initialize failed");
const sessionId = initializeResponse.headers.get("mcp-session-id");
const mcpHeaders = sessionId ? { ...commonHeaders, "mcp-session-id": sessionId } : commonHeaders;
let requestId = 10;

async function callTool<T>(name: string, args: Record<string, unknown>, outputSchema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method: "tools/call", params: { name, arguments: args } })
  });
  const responseSchema = z.object({ result: z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }) });
  const payload = decodeMcp(await response.text(), responseSchema);
  assert(payload.result.isError !== true, `${name} returned an error: ${JSON.stringify(payload.result)}`);
  return outputSchema.parse(payload.result.structuredContent);
}

await fetch(`${base}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
});
const toolsResponse = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
});
const tools = decodeMcp(await toolsResponse.text(), toolsSchema);
const toolNames = tools.result.tools.map((tool) => tool.name);
for (const required of ["orient", "recall", "get", "ingest"]) {
  assert(toolNames.includes(required), `MCP tool ${required} is missing`);
}

const orientResponse = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "orient", arguments: {} } })
});
const orient = decodeMcp(await orientResponse.text(), basicToolResponseSchema);
assert(orient.result.isError !== true, "orient returned an error");

const suffix = crypto.randomUUID().slice(0, 8);
const smokeSlug = `smoke-web-${suffix}`;
const sourceUrl = `https://example.test/archive/${suffix}`;
const firstBody = `First local smoke body ${suffix}`;
const secondBody = `Second local smoke body ${suffix}`;
const ingestOutputSchema = z.object({ revisionId: z.string() });
const first = await callTool("ingest", {
  operationId: crypto.randomUUID(), reason: "web smoke create", slug: smokeSlug,
  type: "note", title: "Web smoke page", body: firstBody, summary: "Temporary web integration fixture",
  singletonMetadata: { source_url: sourceUrl, author: "Local smoke author" }
}, ingestOutputSchema);
const second = await callTool("ingest", {
  operationId: crypto.randomUUID(), reason: "web smoke update", slug: smokeSlug,
  expectedRevisionId: first.revisionId, body: secondBody
}, ingestOutputSchema);
const recallResult = await callTool("recall", { query: suffix, limit: 10 }, z.object({ hits: z.array(z.object({ slug: z.string() })) }));
assert(recallResult.hits.some((hit) => hit.slug === smokeSlug), "recall structured content is invalid or missing the fixture");
const sourceRecall = await callTool("recall", { sourceUrl }, z.object({ hits: z.array(z.object({ slug: z.string() })) }));
assert(sourceRecall.hits.some((hit) => hit.slug === smokeSlug), "exact source-URL recall did not find the fixture");
const historyResult = await callTool("history", { slug: smokeSlug }, z.object({ revisions: z.array(z.unknown()) }));
assert(historyResult.revisions.length === 2, "history structured content is invalid");
await callTool("lint", { limit: 20 }, z.object({ findings: z.array(z.unknown()) }));

const webLogin = await fetch(`${base}/app/login`, { method: "POST", redirect: "manual" });
assert(webLogin.status === 303, `web login failed (${webLogin.status})`);
const webCookie = webLogin.headers.get("set-cookie")?.split(";", 1)[0];
assert(webCookie, "web login returned no session cookie");
const historicalPage = await fetch(`${base}/app/docs/${smokeSlug}?revision=${first.revisionId}`, { headers: { cookie: webCookie } });
assert(historicalPage.ok, `historical page failed (${historicalPage.status})`);
const historicalHtml = await historicalPage.text();
const csrfCookie = historicalPage.headers.get("set-cookie")?.split(";", 1)[0];
const webCsrf = historicalHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
assert(csrfCookie && webCsrf, "document page returned no CSRF state");
const browserCookies = `${webCookie}; ${csrfCookie}`;

const rejectedRestore = await fetch(`${base}/app/docs/${smokeSlug}/restore`, {
  method: "POST",
  headers: { cookie: browserCookies, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: "wrong-token", targetRevisionId: first.revisionId, expectedRevisionId: second.revisionId })
});
assert(rejectedRestore.status === 403, `invalid CSRF was not rejected (${rejectedRestore.status})`);

const restoreResponse = await fetch(`${base}/app/docs/${smokeSlug}/restore`, {
  method: "POST", redirect: "manual",
  headers: { cookie: browserCookies, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: webCsrf, targetRevisionId: first.revisionId, expectedRevisionId: second.revisionId })
});
assert(restoreResponse.status === 303, `web restore failed (${restoreResponse.status}): ${await restoreResponse.text()}`);
const restoredPage = await fetch(`${base}/app/docs/${smokeSlug}`, { headers: { cookie: browserCookies } });
assert((await restoredPage.text()).includes(firstBody), "restored page does not contain the historical body");

const purgeAuthorization = await fetch(`${base}/app/docs/${smokeSlug}/purge-authorize`, {
  method: "POST",
  headers: { cookie: browserCookies, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: webCsrf, confirmation: smokeSlug })
});
const purgeHtml = await purgeAuthorization.text();
const authorizationId = purgeHtml.match(/name="authorizationId" value="([^"]+)"/)?.[1];
assert(purgeAuthorization.ok && authorizationId, `purge authorization failed (${purgeAuthorization.status})`);
const purgeResponse = await fetch(`${base}/app/docs/${smokeSlug}/purge-apply`, {
  method: "POST", redirect: "manual",
  headers: { cookie: browserCookies, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: webCsrf, authorizationId })
});
assert(purgeResponse.status === 303, `purge apply failed (${purgeResponse.status}): ${await purgeResponse.text()}`);

const jsonlExport = await fetch(`${base}/app/export.jsonl`, { headers: { cookie: browserCookies } });
const archive = await jsonlExport.text();
assert(jsonlExport.ok && archive.includes('"record":"manifest"'), "JSONL export failed");
assert(!archive.includes(firstBody) && !archive.includes(secondBody), "purged content leaked into export");
assert(archive.includes('"record":"purge_tombstone"'), "purge tombstone is missing from export");
const markdownExport = await fetch(`${base}/app/export.md`, { headers: { cookie: browserCookies } });
assert(markdownExport.ok && (await markdownExport.text()).includes("# Wikimemory export"), "Markdown export failed");

const managePage = await fetch(`${base}/app/manage`, { headers: { cookie: browserCookies } });
const manageHtml = await managePage.text();
const grantId = manageHtml.match(/name="grantId" value="([^"]+)"/)?.[1];
assert(managePage.ok && grantId, "Manage page did not show the OAuth grant");
const revokeResponse = await fetch(`${base}/app/grants/revoke`, {
  method: "POST", redirect: "manual",
  headers: { cookie: browserCookies, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: webCsrf, grantId })
});
assert(revokeResponse.status === 303, `grant revocation failed (${revokeResponse.status})`);

console.log(`local OAuth + MCP + owner web smoke test passed (${toolNames.length} tools)`);
