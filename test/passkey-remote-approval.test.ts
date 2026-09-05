import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import {
  beginPasskeyAuthorization,
  decidePendingAuthorization,
  listPendingAuthorizations,
  passkeyAuthorizationStatus
} from "../src/auth/passkey";
import { PASSKEY_OWNER_ID } from "../src/auth/passkey-management";
import { sha256 } from "../src/domain/crypto";
import type { Env } from "../src/env";
import { handleWebApi } from "../src/web/app";

const ORIGIN = "https://memory.example";
const WORKER_ORIGIN = "https://example.test";
const REDIRECT_URI = "https://remote-client.example/callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CURRENT_SESSION_ID = "remote-approval-session";
const STALE_SESSION_ID = "remote-approval-stale-session";
const CREDENTIAL_ID = "remote-approval-credential";
const STATUS_SCHEMA = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["pending", "denied", "expired"]) }),
  z.object({ status: z.literal("approved"), redirectTo: z.string() })
]);
const REQUESTS_SCHEMA = z.object({
  requests: z.array(
    z.object({
      flowId: z.string(),
      clientName: z.string().nullable(),
      requestedScopes: z.array(z.string()),
      requestedAt: z.string(),
      expiresAt: z.string()
    })
  )
});

// The Worker's provider attaches its helpers to the request env on every fetch.
// Calling the passkey module directly needs helpers over the same KV namespace,
// so the test lets a provider instance with matching endpoints populate its env.
const notFound = { fetch: () => Promise.resolve(new Response(null, { status: 404 })) };
const provider = new OAuthProvider<Env>({
  apiHandlers: { "/mcp": notFound },
  defaultHandler: notFound,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  allowImplicitFlow: false
});
let production: Env;

async function productionEnv(): Promise<Env> {
  const base: Env = {
    DB: env.DB,
    OAUTH_KV: env.OAUTH_KV,
    ASSETS: env.ASSETS,
    OAUTH_PROVIDER: env.OAUTH_PROVIDER,
    APP_ENV: "production",
    APP_BASE_URL: ORIGIN,
    SETUP_TOKEN_HASH: "a".repeat(64)
  };
  await provider.fetch(new Request(`${ORIGIN}/helpers`), base, createExecutionContext());
  return base;
}

function ownerRequest(
  path: string,
  method = "GET",
  body?: object,
  sessionId = CURRENT_SESSION_ID
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: `wm_web_session=${sessionId}`,
      origin: ORIGIN,
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function storeSession(sessionId: string, authenticatedAt: string): Promise<void> {
  await env.OAUTH_KV.put(
    `web-session:${await sha256(sessionId)}`,
    JSON.stringify({
      principalId: PASSKEY_OWNER_ID,
      workspaceId: "primary-workspace",
      credentialId: CREDENTIAL_ID,
      authenticatedAt,
      createdAt: authenticatedAt
    })
  );
}

async function registerClient(): Promise<string> {
  const response = await exports.default.fetch(
    new Request(`${WORKER_ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Remote approval client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      })
    })
  );
  expect(response.status).toBe(201);
  return z.object({ client_id: z.string() }).parse(await response.json()).client_id;
}

async function startConnection(clientId: string, state = "remote-state"): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "memory:read memory:write",
    state,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`
  });
  const started = await beginPasskeyAuthorization(
    new Request(`${ORIGIN}/authorize?${query.toString()}`),
    production,
    "mcp"
  );
  expect(started.status).toBe(302);
  const flowId = new URL(started.headers.get("location") ?? ORIGIN).searchParams.get("flowId");
  expect(flowId).not.toBeNull();
  return flowId ?? "";
}

async function status(flowId: string): Promise<z.infer<typeof STATUS_SCHEMA>> {
  const response = await passkeyAuthorizationStatus(
    new Request(`${ORIGIN}/api/auth/status?flowId=${encodeURIComponent(flowId)}`),
    production
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return STATUS_SCHEMA.parse(await response.json());
}

describe("cross-device MCP connection approval", () => {
  let clientId = "";

  beforeAll(async () => {
    production = await productionEnv();
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO principals
        (id, provider, provider_subject, email_verified, created_at)
        VALUES (?, 'passkey', ?, 1, '2026-07-19T00:00:00Z')`).bind(
        PASSKEY_OWNER_ID,
        PASSKEY_OWNER_ID
      ),
      env.DB.prepare(`INSERT OR IGNORE INTO workspaces(id, name, created_at)
        VALUES ('primary-workspace', 'Wikimemory', '2026-07-19T00:00:00Z')`),
      env.DB.prepare(`INSERT OR IGNORE INTO memberships(workspace_id, principal_id, role, created_at)
        VALUES ('primary-workspace', ?, 'owner', '2026-07-19T00:00:00Z')`).bind(PASSKEY_OWNER_ID),
      env.DB.prepare(`INSERT OR IGNORE INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
        VALUES (?, ?, 'public-key-remote', 0, '["internal"]', 'multiDevice', 1,
                '2026-07-19T00:00:00Z', 'Laptop passkey')`).bind(CREDENTIAL_ID, PASSKEY_OWNER_ID)
    ]);
    await storeSession(CURRENT_SESSION_ID, new Date().toISOString());
    await storeSession(STALE_SESSION_ID, new Date(Date.now() - 10 * 60_000).toISOString());
    clientId = await registerClient();
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM passkey_challenges WHERE kind = 'mcp'"),
      env.DB.prepare("DELETE FROM authorization_decisions")
    ]);
  });

  it("lets a signed-in browser approve a request that is waiting on another device", async () => {
    const flowId = await startConnection(clientId);
    await expect(status(flowId)).resolves.toEqual({ status: "pending" });

    const listed = await handleWebApi(ownerRequest("/api/app/authorizations"), production);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const pending = REQUESTS_SCHEMA.parse(await listed.json());
    expect(pending.requests).toEqual([
      expect.objectContaining({
        flowId,
        clientName: "Remote approval client",
        requestedScopes: ["memory:read", "memory:write"]
      })
    ]);
    const request = pending.requests[0];
    expect(request).toBeDefined();
    const waitWindow =
      Date.parse(request?.expiresAt ?? "") - Date.parse(request?.requestedAt ?? "");
    expect(waitWindow).toBe(15 * 60_000);

    const approved = await handleWebApi(
      ownerRequest("/api/app/authorizations", "POST", { flowId, decision: "approve" }),
      production
    );
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toEqual({ flowId, status: "approved" });

    const outcome = await status(flowId);
    expect(outcome.status).toBe("approved");
    const callback = new URL(outcome.status === "approved" ? outcome.redirectTo : ORIGIN);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("remote-state");
    const code = callback.searchParams.get("code");
    expect(code).not.toBeNull();

    const token = await exports.default.fetch(
      new Request(`${WORKER_ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code ?? "",
          redirect_uri: REDIRECT_URI,
          code_verifier: VERIFIER,
          resource: `${ORIGIN}/mcp`
        })
      })
    );
    expect(token.status).toBe(200);
    const issued = z
      .object({ access_token: z.string(), refresh_token: z.string(), scope: z.string() })
      .parse(await token.json());
    expect(issued.scope).toBe("memory:read memory:write");

    await expect(status(flowId)).resolves.toEqual({ status: "expired" });
    await expect(listPendingAuthorizations(production)).resolves.toEqual([]);
  });

  it("records a denial for the waiting browser exactly once", async () => {
    const grantsBefore = (await env.OAUTH_KV.list({ prefix: "grant:" })).keys.length;
    const flowId = await startConnection(clientId, "denied-state");
    const denied = await handleWebApi(
      ownerRequest("/api/app/authorizations", "POST", { flowId, decision: "deny" }),
      production
    );
    await expect(denied.json()).resolves.toEqual({ flowId, status: "denied" });
    await expect(status(flowId)).resolves.toEqual({ status: "denied" });
    await expect(status(flowId)).resolves.toEqual({ status: "expired" });
    expect((await env.OAUTH_KV.list({ prefix: "grant:" })).keys).toHaveLength(grantsBefore);
  });

  it("rejects malformed, stale, and insufficiently authenticated decisions", async () => {
    const flowId = await startConnection(clientId);
    const malformed = await handleWebApi(
      ownerRequest("/api/app/authorizations", "POST", {
        flowId: "not-a-flow",
        decision: "approve"
      }),
      production
    );
    expect(malformed.status).toBe(400);
    const unknownDecision = await handleWebApi(
      ownerRequest("/api/app/authorizations", "POST", { flowId, decision: "maybe" }),
      production
    );
    expect(unknownDecision.status).toBe(400);
    const stale = await handleWebApi(
      ownerRequest(
        "/api/app/authorizations",
        "POST",
        { flowId, decision: "approve" },
        STALE_SESSION_ID
      ),
      production
    );
    expect(stale.status).toBe(401);
    await expect(stale.json()).resolves.toMatchObject({ error: "reauthentication_required" });
    await expect(status(flowId)).resolves.toEqual({ status: "pending" });

    const missing = await handleWebApi(
      ownerRequest("/api/app/authorizations", "POST", {
        flowId: crypto.randomUUID(),
        decision: "approve"
      }),
      production
    );
    expect(missing.status).toBe(404);

    const anonymous = await handleWebApi(
      new Request(`${ORIGIN}/api/app/authorizations`),
      production
    );
    expect(anonymous.status).toBe(401);
  });

  it("reports unknown and malformed flows without leaking decisions", async () => {
    await expect(status(crypto.randomUUID())).resolves.toEqual({ status: "expired" });
    await expect(
      passkeyAuthorizationStatus(new Request(`${ORIGIN}/api/auth/status?flowId=nope`), production)
    ).rejects.toThrow("Invalid authentication flow");
    await expect(
      decidePendingAuthorization(production, crypto.randomUUID(), "approve", {
        credentialId: CREDENTIAL_ID,
        authenticatedAt: new Date().toISOString()
      })
    ).rejects.toThrow("expired or was already completed");
  });

  it("skips waiting rows whose payload cannot be presented", async () => {
    const flowId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(`INSERT INTO passkey_challenges(flow_id, kind, challenge, payload_json, expires_at)
      VALUES (?, 'mcp', 'challenge', NULL, ?)`)
      .bind(flowId, expiresAt)
      .run();
    await expect(listPendingAuthorizations(production)).resolves.toEqual([]);
    await expect(status(flowId)).resolves.toEqual({ status: "pending" });
  });
});
