import { env } from "cloudflare:workers";
import {
  beginPasskeyAuthorization,
  endProductionWebSession,
  listProductionWebSessions,
  passkeyAuthorizationOptions,
  productionWebOwner,
  registrationOptions,
  revokeProductionSessionsForCredential,
  revokeProductionWebSession
} from "../src/auth/passkey";
import { PASSKEY_OWNER_ID } from "../src/auth/passkey-management";
import { sha256 } from "../src/domain/crypto";
import type { DomainError } from "../src/domain/errors";
import type { Env } from "../src/env";

const BASE_URL = "https://memory.example";
const SESSION_PREFIX = "web-session:";

function productionEnv(): Env {
  return {
    DB: env.DB,
    OAUTH_KV: env.OAUTH_KV,
    ASSETS: env.ASSETS,
    OAUTH_PROVIDER: env.OAUTH_PROVIDER,
    APP_ENV: "production",
    APP_BASE_URL: BASE_URL,
    SETUP_TOKEN_HASH: "a".repeat(64)
  };
}

async function storeSession(
  sessionId: string,
  values: {
    principalId?: string;
    workspaceId?: string;
    credentialId?: string;
    authenticatedAt?: string;
    createdAt?: string;
  }
): Promise<string> {
  const key = `${SESSION_PREFIX}${await sha256(sessionId)}`;
  const now = new Date().toISOString();
  await env.OAUTH_KV.put(
    key,
    JSON.stringify({
      principalId: values.principalId ?? PASSKEY_OWNER_ID,
      workspaceId: values.workspaceId ?? "primary-workspace",
      ...(values.credentialId === undefined ? {} : { credentialId: values.credentialId }),
      authenticatedAt: values.authenticatedAt ?? now,
      createdAt: values.createdAt ?? now
    })
  );
  return key;
}

describe("production passkey sessions", () => {
  beforeEach(async () => {
    const existing = await env.OAUTH_KV.list({ prefix: SESSION_PREFIX });
    await Promise.all(existing.keys.map(async ({ name }) => env.OAUTH_KV.delete(name)));
  });

  it("accepts only a valid owner session", async () => {
    const appEnv = productionEnv();
    await expect(productionWebOwner(new Request(`${BASE_URL}/app`), appEnv)).resolves.toBeNull();

    const wrongSession = "wrong-owner-session";
    await storeSession(wrongSession, { principalId: "someone-else" });
    await expect(
      productionWebOwner(
        new Request(`${BASE_URL}/app`, {
          headers: { cookie: `other=value; wm_web_session=${wrongSession}` }
        }),
        appEnv
      )
    ).resolves.toBeNull();

    const malformedSession = "malformed-owner-session";
    const malformedKey = `${SESSION_PREFIX}${await sha256(malformedSession)}`;
    await env.OAUTH_KV.put(malformedKey, JSON.stringify({ principalId: PASSKEY_OWNER_ID }));
    await expect(
      productionWebOwner(
        new Request(`${BASE_URL}/app`, {
          headers: { cookie: `wm_web_session=${malformedSession}` }
        }),
        appEnv
      )
    ).resolves.toBeNull();

    const wrongWorkspace = "wrong-workspace-session";
    await storeSession(wrongWorkspace, { workspaceId: "another-workspace" });
    await expect(
      productionWebOwner(
        new Request(`${BASE_URL}/app`, { headers: { cookie: `wm_web_session=${wrongWorkspace}` } }),
        appEnv
      )
    ).resolves.toBeNull();

    const ownerSession = "valid-owner-session";
    await storeSession(ownerSession, { credentialId: "laptop-passkey" });
    const owner = await productionWebOwner(
      new Request(`${BASE_URL}/app`, { headers: { cookie: `wm_web_session=${ownerSession}` } }),
      appEnv
    );
    expect(owner).toMatchObject({
      principalId: PASSKEY_OWNER_ID,
      workspaceId: "primary-workspace",
      role: "owner"
    });
    expect(owner?.scopes).toEqual(new Set(["memory:read", "memory:write", "memory:admin"]));
  });

  it("lists owner sessions and marks the current browser", async () => {
    const appEnv = productionEnv();
    const currentId = "current-list-session";
    const currentKey = await storeSession(currentId, {
      credentialId: "laptop-passkey",
      createdAt: "2026-07-19T02:00:00Z"
    });
    const olderKey = await storeSession("older-list-session", {
      credentialId: "phone-passkey",
      createdAt: "2026-07-19T01:00:00Z"
    });
    const foreignKey = await storeSession("foreign-list-session", {
      principalId: "someone-else",
      createdAt: "2026-07-19T03:00:00Z"
    });
    const malformedKey = `${SESSION_PREFIX}${"f".repeat(64)}`;
    await env.OAUTH_KV.put(malformedKey, "null");

    const sessions = await listProductionWebSessions(
      new Request(`${BASE_URL}/app/manage`, {
        headers: { cookie: `wm_web_session=${currentId}` }
      }),
      appEnv,
      PASSKEY_OWNER_ID
    );
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionRef: currentKey.slice(SESSION_PREFIX.length),
        current: true
      }),
      expect.objectContaining({ sessionRef: olderKey.slice(SESSION_PREFIX.length), current: false })
    ]);

    const withoutCurrent = await listProductionWebSessions(
      new Request(`${BASE_URL}/app/manage`),
      appEnv,
      PASSKEY_OWNER_ID
    );
    expect(withoutCurrent.every((session) => !session.current)).toBe(true);

    await Promise.all([
      env.OAUTH_KV.delete(currentKey),
      env.OAUTH_KV.delete(olderKey),
      env.OAUTH_KV.delete(foreignKey),
      env.OAUTH_KV.delete(malformedKey)
    ]);
  });

  it("revokes sessions by credential while preserving unrelated sessions", async () => {
    const appEnv = productionEnv();
    const matching = await storeSession("matching-credential-session", {
      credentialId: "lost-passkey"
    });
    const legacy = await storeSession("legacy-credential-session", {});
    const preserved = await storeSession("preserved-credential-session", {
      credentialId: "safe-passkey"
    });
    const foreign = await storeSession("foreign-credential-session", {
      principalId: "someone-else",
      credentialId: "lost-passkey"
    });
    const malformed = `${SESSION_PREFIX}${"e".repeat(64)}`;
    await env.OAUTH_KV.put(malformed, "null");

    await revokeProductionSessionsForCredential(appEnv, PASSKEY_OWNER_ID, "lost-passkey");
    await expect(env.OAUTH_KV.get(matching)).resolves.toBeNull();
    await expect(env.OAUTH_KV.get(legacy)).resolves.toBeNull();
    await expect(env.OAUTH_KV.get(preserved)).resolves.not.toBeNull();
    await expect(env.OAUTH_KV.get(foreign)).resolves.not.toBeNull();

    await Promise.all([
      env.OAUTH_KV.delete(preserved),
      env.OAUTH_KV.delete(foreign),
      env.OAUTH_KV.delete(malformed)
    ]);
  });

  it("revokes one referenced session and ends the current session", async () => {
    const appEnv = productionEnv();
    const referencedId = "referenced-session";
    const referencedKey = await storeSession(referencedId, {});
    const sessionRef = referencedKey.slice(SESSION_PREFIX.length);

    await expect(
      revokeProductionWebSession(appEnv, PASSKEY_OWNER_ID, "invalid")
    ).rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<DomainError>);
    await expect(
      revokeProductionWebSession(appEnv, PASSKEY_OWNER_ID, "0".repeat(64))
    ).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DomainError>);
    await revokeProductionWebSession(appEnv, PASSKEY_OWNER_ID, sessionRef);
    await expect(env.OAUTH_KV.get(referencedKey)).resolves.toBeNull();

    const currentId = "session-to-end";
    const currentKey = await storeSession(currentId, {});
    await endProductionWebSession(
      new Request(`${BASE_URL}/app`, { headers: { cookie: `wm_web_session=${currentId}` } }),
      appEnv
    );
    await expect(env.OAUTH_KV.get(currentKey)).resolves.toBeNull();
    await expect(
      endProductionWebSession(new Request(`${BASE_URL}/app`), appEnv)
    ).resolves.toBeUndefined();
  });
});

describe("passkey flow boundaries", () => {
  it("fails closed before setup and for invalid or expired flow references", async () => {
    const appEnv = productionEnv();
    const authorization = await beginPasskeyAuthorization(
      new Request(`${BASE_URL}/app/login`),
      appEnv,
      "web"
    );
    expect(authorization.status).toBe(503);

    await expect(
      passkeyAuthorizationOptions(
        new Request(`${BASE_URL}/api/auth/options?flowId=invalid`),
        appEnv
      )
    ).rejects.toMatchObject({ code: "validation_failed" } satisfies Partial<DomainError>);

    const expired = await passkeyAuthorizationOptions(
      new Request(`${BASE_URL}/api/auth/options?flowId=00000000-0000-4000-8000-000000000000`),
      appEnv
    );
    expect(expired.status).toBe(410);

    const registration = await registrationOptions(
      new Request(`${BASE_URL}/passkeys/add/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "x".repeat(32) })
      }),
      appEnv
    );
    expect(registration.status).toBe(403);
  });
});
