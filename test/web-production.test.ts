import { env } from "cloudflare:workers";
import { PASSKEY_OWNER_ID } from "../src/auth/passkey-management";
import { sha256 } from "../src/domain/crypto";
import type { Env } from "../src/env";
import { handleWebApi } from "../src/web/app";

const ORIGIN = "https://memory.example";
const CURRENT_SESSION_ID = "production-current-session";
const CURRENT_CREDENTIAL_ID = "production-current-credential";
const REVOCABLE_CREDENTIAL_ID = "production-revocable-credential";

function appEnv(): Env {
  return {
    DB: env.DB,
    OAUTH_KV: env.OAUTH_KV,
    ASSETS: env.ASSETS,
    OAUTH_PROVIDER: env.OAUTH_PROVIDER,
    APP_ENV: "production",
    APP_BASE_URL: ORIGIN,
    SETUP_TOKEN_HASH: "a".repeat(64)
  };
}

function ownerRequest(path: string, method = "GET", body?: object): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      cookie: `wm_web_session=${CURRENT_SESSION_ID}`,
      origin: ORIGIN,
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function storeSession(
  sessionId: string,
  credentialId: string,
  principalId = PASSKEY_OWNER_ID
): Promise<string> {
  const sessionRef = await sha256(sessionId);
  const now = new Date().toISOString();
  await env.OAUTH_KV.put(
    `web-session:${sessionRef}`,
    JSON.stringify({
      principalId,
      workspaceId: "primary-workspace",
      credentialId,
      authenticatedAt: now,
      createdAt: now
    })
  );
  return sessionRef;
}

describe("production web management boundary", () => {
  beforeAll(async () => {
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
      env.DB.prepare(`INSERT INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
        VALUES (?, ?, 'public-key-current', 0, '[]', 'multiDevice', 1,
                '2026-07-19T00:00:00Z', 'Current passkey')`).bind(
        CURRENT_CREDENTIAL_ID,
        PASSKEY_OWNER_ID
      ),
      env.DB.prepare(`INSERT INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
        VALUES (?, ?, 'public-key-revocable', 0, '[]', 'singleDevice', 0,
                '2026-07-19T00:00:01Z', 'Old passkey')`).bind(
        REVOCABLE_CREDENTIAL_ID,
        PASSKEY_OWNER_ID
      )
    ]);
    await storeSession(CURRENT_SESSION_ID, CURRENT_CREDENTIAL_ID);
  });

  it("creates a named additional-passkey registration link", async () => {
    const malformed = await handleWebApi(ownerRequest("/api/app/passkeys", "POST", {}), appEnv());
    expect(malformed.status).toBe(400);

    const created = await handleWebApi(
      ownerRequest("/api/app/passkeys", "POST", { label: "Tablet" }),
      appEnv()
    );
    expect(created.status).toBe(200);
    const body = await created.json<{ registrationUrl: string }>();
    expect(body.registrationUrl).toMatch(/^https:\/\/memory\.example\/passkeys\/add#/u);
  });

  it("revokes an individual non-final passkey and its attributed sessions", async () => {
    const lostSessionKey = await storeSession("lost-passkey-session", REVOCABLE_CREDENTIAL_ID);
    const credentialRef = await sha256(REVOCABLE_CREDENTIAL_ID);
    const malformed = await handleWebApi(ownerRequest("/api/app/passkeys", "DELETE", {}), appEnv());
    expect(malformed.status).toBe(400);

    const revoked = await handleWebApi(
      ownerRequest("/api/app/passkeys", "DELETE", { credentialRef }),
      appEnv()
    );
    await expect(revoked.json()).resolves.toEqual({
      revoked: credentialRef,
      sessionCleanupComplete: true
    });
    await expect(env.OAUTH_KV.get(`web-session:${lostSessionKey}`)).resolves.toBeNull();
  });

  it("revokes an individual browser session", async () => {
    const otherRef = await storeSession("other-browser-session", CURRENT_CREDENTIAL_ID);
    const malformed = await handleWebApi(ownerRequest("/api/app/sessions", "DELETE", {}), appEnv());
    expect(malformed.status).toBe(400);

    const revoked = await handleWebApi(
      ownerRequest("/api/app/sessions", "DELETE", { sessionRef: otherRef }),
      appEnv()
    );
    await expect(revoked.json()).resolves.toEqual({ revoked: otherRef });
    await expect(env.OAUTH_KV.get(`web-session:${otherRef}`)).resolves.toBeNull();
  });

  it("ends the current production session on logout", async () => {
    const currentKey = `web-session:${await sha256(CURRENT_SESSION_ID)}`;
    const logout = await handleWebApi(ownerRequest("/api/app/logout", "POST"), appEnv());
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("wm_web_session=;");
    expect(logout.headers.get("set-cookie")).toContain("Secure;");
    await expect(env.OAUTH_KV.get(currentKey)).resolves.toBeNull();
  });
});
