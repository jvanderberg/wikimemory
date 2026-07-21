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
const initializeSchema = z.object({
  result: z.object({ serverInfo: z.object({ name: z.string() }) })
});
const toolsSchema = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) })
});
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

const consentRedirect = await fetch(authorize, { redirect: "manual" });
assert(consentRedirect.status === 302, `consent redirect failed (${consentRedirect.status})`);
const consentLocation = consentRedirect.headers.get("location");
assert(consentLocation !== null, "consent redirect returned no location");
const consent = new URL(consentLocation);
assert(consent.pathname === "/local-authorize", "consent did not use the React route");

const optionsUrl = new URL("/api/local-authorize/options", consent);
optionsUrl.search = consent.search;
const options = await json(
  await fetch(optionsUrl),
  "local authorization options",
  z.object({ clientName: z.string(), requestedScopes: z.array(z.string()) })
);
assert(options.clientName === "Wikimemory local smoke test", "consent named the wrong client");
assert(options.requestedScopes.includes("memory:read"), "consent omitted requested scopes");

const approveUrl = new URL("/api/local-authorize/approve", consent);
approveUrl.search = consent.search;
const approval = await fetch(approveUrl, {
  method: "POST",
  headers: { "content-type": "application/json", origin: new URL(base).origin },
  body: "{}"
});
const approved = await json(
  approval,
  "local authorization approval",
  z.object({ redirectTo: z.string() })
);
const callback = new URL(approved.redirectTo);
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

const apiResource = `${base}/api/v1`;
const apiRegistration = await json(
  await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Wikimemory admin API smoke test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  }),
  "API client registration",
  registrationSchema
);
const apiAuthorize = new URL(`${base}/authorize`);
apiAuthorize.search = new URLSearchParams({
  response_type: "code",
  client_id: apiRegistration.client_id,
  redirect_uri: redirectUri,
  scope: "memory:read memory:admin",
  state: "api-smoke-state",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: apiResource
}).toString();
const apiConsentRedirect = await fetch(apiAuthorize, { redirect: "manual" });
const apiConsentLocation = apiConsentRedirect.headers.get("location");
assert(apiConsentLocation !== null, "API consent redirect returned no location");
const apiConsent = new URL(apiConsentLocation);
const apiApprovalUrl = new URL("/api/local-authorize/approve", apiConsent);
apiApprovalUrl.search = apiConsent.search;
const apiApproved = await json(
  await fetch(apiApprovalUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(base).origin },
    body: "{}"
  }),
  "API authorization approval",
  z.object({ redirectTo: z.string() })
);
const apiCode = new URL(apiApproved.redirectTo).searchParams.get("code");
assert(apiCode, "API approval returned no authorization code");
const apiToken = await json(
  await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: apiRegistration.client_id,
      code: apiCode,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: apiResource
    })
  }),
  "API token exchange",
  tokenSchema
);
const apiSlug = `smoke-api-${crypto.randomUUID().slice(0, 8)}`;
const apiHeaders = {
  authorization: `Bearer ${apiToken.access_token}`,
  "content-type": "application/json"
};
const apiDocument = await fetch(`${base}/api/v1/documents`, {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({ slug: apiSlug, type: "note" })
});
assert(apiDocument.status === 201, `CRUD document create failed (${apiDocument.status})`);
const apiRevision = await fetch(`${base}/api/v1/documents/${apiSlug}`, {
  method: "PUT",
  headers: apiHeaders,
  body: JSON.stringify({
    operationId: `smoke:${apiSlug}:1`,
    revisionNumber: 1,
    title: "CRUD smoke",
    body: "Administrative API smoke fixture",
    createdAt: new Date().toISOString(),
    reason: "local integration smoke",
    metadata: [{ key: "tag", value: "smoke", cardinality: "multi" }],
    links: []
  })
});
assert(apiRevision.status === 201, `CRUD revision create failed (${apiRevision.status})`);
const apiHistory = await json(
  await fetch(`${base}/api/v1/documents/${apiSlug}/revisions`, { headers: apiHeaders }),
  "CRUD revision history",
  z.object({ items: z.array(z.object({ revisionNumber: z.number() })) })
);
assert(apiHistory.items.length === 1, "CRUD API did not return its created revision");
const apiDelete = await fetch(`${base}/api/v1/documents/${apiSlug}?confirm=${apiSlug}`, {
  method: "DELETE",
  headers: apiHeaders
});
assert(apiDelete.ok, `CRUD document delete failed (${apiDelete.status})`);

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

async function callTool<T>(
  name: string,
  args: Record<string, unknown>,
  outputSchema: z.ZodType<T>
): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId++,
      method: "tools/call",
      params: { name, arguments: args }
    })
  });
  const responseSchema = z.object({
    result: z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() })
  });
  const payload = decodeMcp(await response.text(), responseSchema);
  assert(
    payload.result.isError !== true,
    `${name} returned an error: ${JSON.stringify(payload.result)}`
  );
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
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "orient", arguments: {} }
  })
});
const orient = decodeMcp(await orientResponse.text(), basicToolResponseSchema);
assert(orient.result.isError !== true, "orient returned an error");

const suffix = crypto.randomUUID().slice(0, 8);
const smokeSlug = `smoke-web-${suffix}`;
const sourceUrl = `https://example.test/archive/${suffix}`;
const firstBody = `First local smoke body ${suffix}`;
const secondBody = `Second local smoke body ${suffix}`;
const ingestOutputSchema = z.object({ revisionId: z.string() });
const first = await callTool(
  "ingest",
  {
    operationId: crypto.randomUUID(),
    reason: "web smoke create",
    slug: smokeSlug,
    type: "note",
    title: "Web smoke page",
    body: firstBody,
    summary: "Temporary web integration fixture",
    singletonMetadata: { source_url: sourceUrl, author: "Local smoke author" }
  },
  ingestOutputSchema
);
const second = await callTool(
  "ingest",
  {
    operationId: crypto.randomUUID(),
    reason: "web smoke update",
    slug: smokeSlug,
    expectedRevisionId: first.revisionId,
    body: secondBody
  },
  ingestOutputSchema
);
const recallResult = await callTool(
  "recall",
  { query: suffix, limit: 10 },
  z.object({ hits: z.array(z.object({ slug: z.string() })) })
);
assert(
  recallResult.hits.some((hit) => hit.slug === smokeSlug),
  "recall structured content is invalid or missing the fixture"
);
const sourceRecall = await callTool(
  "recall",
  { sourceUrl },
  z.object({ hits: z.array(z.object({ slug: z.string() })) })
);
assert(
  sourceRecall.hits.some((hit) => hit.slug === smokeSlug),
  "exact source-URL recall did not find the fixture"
);
const historyResult = await callTool(
  "history",
  { slug: smokeSlug },
  z.object({ revisions: z.array(z.unknown()) })
);
assert(historyResult.revisions.length === 2, "history structured content is invalid");
await callTool("lint", { limit: 20 }, z.object({ findings: z.array(z.unknown()) }));

const webLogin = await fetch(`${base}/api/app/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: new URL(base).origin },
  body: "{}"
});
assert(webLogin.ok, `web login failed (${webLogin.status})`);
const webCookie = webLogin.headers.get("set-cookie")?.split(";", 1)[0];
assert(webCookie, "web login returned no session cookie");
const historicalPage = await fetch(
  `${base}/api/app/docs/${smokeSlug}?revision=${first.revisionId}`,
  {
    headers: { cookie: webCookie }
  }
);
const historical = await json(
  historicalPage,
  "historical document",
  z.object({ document: z.object({ body: z.string() }) })
);
assert(historical.document.body === firstBody, "historical API returned the wrong body");

const rejectedRestore = await fetch(`${base}/api/app/docs/${smokeSlug}/restore`, {
  method: "POST",
  headers: { cookie: webCookie }
});
assert(rejectedRestore.status === 403, `invalid CSRF was not rejected (${rejectedRestore.status})`);

const restoreResponse = await fetch(`${base}/api/app/docs/${smokeSlug}/restore`, {
  method: "POST",
  headers: {
    cookie: webCookie,
    "content-type": "application/json",
    origin: new URL(base).origin
  },
  body: JSON.stringify({
    targetRevisionId: first.revisionId,
    expectedRevisionId: second.revisionId
  })
});
assert(restoreResponse.ok, `web restore failed (${restoreResponse.status})`);
const restoredPage = await fetch(`${base}/api/app/docs/${smokeSlug}`, {
  headers: { cookie: webCookie }
});
const restored = await json(
  restoredPage,
  "restored document",
  z.object({ document: z.object({ body: z.string() }) })
);
assert(restored.document.body === firstBody, "restored page does not contain the historical body");

const purgeAuthorization = await fetch(`${base}/api/app/docs/${smokeSlug}/purge-authorize`, {
  method: "POST",
  headers: {
    cookie: webCookie,
    "content-type": "application/json",
    origin: new URL(base).origin
  },
  body: JSON.stringify({ confirmation: smokeSlug })
});
const authorization = await json(
  purgeAuthorization,
  "purge authorization",
  z.object({ id: z.string() })
);
const purgeResponse = await fetch(`${base}/api/app/docs/${smokeSlug}/purge-apply`, {
  method: "POST",
  headers: {
    cookie: webCookie,
    "content-type": "application/json",
    origin: new URL(base).origin
  },
  body: JSON.stringify({ authorizationId: authorization.id })
});
assert(purgeResponse.ok, `purge apply failed (${purgeResponse.status})`);

const jsonlExport = await fetch(`${base}/api/app/export.jsonl`, {
  headers: { cookie: webCookie }
});
const archive = await jsonlExport.text();
assert(jsonlExport.ok && archive.includes('"record":"manifest"'), "JSONL export failed");
assert(
  !archive.includes(firstBody) && !archive.includes(secondBody),
  "purged content leaked into export"
);
assert(archive.includes('"record":"purge_tombstone"'), "purge tombstone is missing from export");
const markdownExport = await fetch(`${base}/api/app/export.md`, {
  headers: { cookie: webCookie }
});
assert(
  markdownExport.ok && (await markdownExport.text()).includes("# Wikimemory export"),
  "Markdown export failed"
);

const manage = await json(
  await fetch(`${base}/api/app/manage`, { headers: { cookie: webCookie } }),
  "manage API",
  z.object({ clients: z.array(z.object({ id: z.string() })) })
);
const grantId = manage.clients[0]?.id;
assert(grantId !== undefined, "Manage API did not show the OAuth grant");
const revokeResponse = await fetch(`${base}/api/app/grants`, {
  method: "DELETE",
  headers: {
    cookie: webCookie,
    "content-type": "application/json",
    origin: new URL(base).origin
  },
  body: JSON.stringify({ grantId })
});
assert(revokeResponse.ok, `grant revocation failed (${revokeResponse.status})`);

console.log(`local OAuth + MCP + owner web smoke test passed (${toolNames.length} tools)`);
