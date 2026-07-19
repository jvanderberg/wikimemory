import { env } from "cloudflare:workers";
import type { TokenSummary } from "@cloudflare/workers-oauth-provider";
import { handlePasskeyApi } from "../src/auth/passkey-api";
import { PASSKEY_OWNER_ID } from "../src/auth/passkey-management";
import { sha256 } from "../src/domain/crypto";
import type { DomainError } from "../src/domain/errors";
import type { Env } from "../src/env";

const BASE_URL = "https://memory.example";
const MCP_RESOURCE = `${BASE_URL}/mcp`;

function appEnv(): Env {
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

function adminToken(
  values?: Partial<
    Pick<TokenSummary<unknown>, "userId" | "scope" | "audience" | "createdAt" | "grant">
  >
): TokenSummary<unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "token-id",
    grantId: "grant-id",
    userId: values?.userId ?? PASSKEY_OWNER_ID,
    createdAt: values?.createdAt ?? now,
    expiresAt: now + 3600,
    audience: values?.audience ?? MCP_RESOURCE,
    scope: values?.scope ?? ["memory:admin"],
    grant: values?.grant ?? {
      clientId: "coverage-client",
      scope: ["memory:admin"],
      props: {
        workspaceId: "primary-workspace",
        principalId: PASSKEY_OWNER_ID,
        clientId: "coverage-client",
        scopes: ["memory:admin"],
        authenticatedAt: new Date(now * 1000).toISOString(),
        credentialId: "api-credential-two"
      }
    }
  };
}

function request(method = "GET", body?: object): Request {
  return new Request(`${BASE_URL}/api/passkeys`, {
    method,
    headers: {
      authorization: "Bearer coverage-token",
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

describe("owner passkey administration API", () => {
  beforeAll(async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO principals
      (id, provider, provider_subject, email_verified, created_at)
      VALUES (?, 'passkey', ?, 1, '2026-07-19T00:00:00Z')`)
      .bind(PASSKEY_OWNER_ID, PASSKEY_OWNER_ID)
      .run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
        VALUES ('api-credential-one', ?, 'public-key-one', 0, '[]', 'singleDevice', 0,
                '2026-07-19T00:00:00Z', 'Laptop')`).bind(PASSKEY_OWNER_ID),
      env.DB.prepare(`INSERT INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
        VALUES ('api-credential-two', ?, 'public-key-two', 0, '[]', 'multiDevice', 1,
                '2026-07-19T00:00:01Z', 'Phone')`).bind(PASSKEY_OWNER_ID)
    ]);
  });

  it("requires a bearer token before attempting token decoding", async () => {
    let called = false;
    await expect(
      handlePasskeyApi(new Request(`${BASE_URL}/api/passkeys`), appEnv(), () => {
        called = true;
        return Promise.resolve(adminToken());
      })
    ).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DomainError>);
    expect(called).toBe(false);
  });

  it.each([
    ["unknown token", null],
    ["wrong owner", adminToken({ userId: "someone-else" })],
    ["missing scope", adminToken({ scope: ["memory:read"] })],
    [
      "invalid props",
      adminToken({
        grant: { clientId: "coverage-client", scope: ["memory:admin"], props: null }
      })
    ],
    [
      "wrong props owner",
      adminToken({
        grant: {
          clientId: "coverage-client",
          scope: ["memory:admin"],
          props: {
            workspaceId: "primary-workspace",
            principalId: "someone-else",
            clientId: "coverage-client",
            scopes: ["memory:admin"]
          }
        }
      })
    ],
    ["wrong audience", adminToken({ audience: "https://evil.example/mcp" })]
  ])("rejects %s", async (_label, token) => {
    await expect(
      handlePasskeyApi(request(), appEnv(), () => Promise.resolve(token))
    ).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DomainError>);
  });

  it("requires a recent passkey ceremony rather than recent token issuance", async () => {
    const staleCeremony = new Date(Date.now() - 301_000).toISOString();
    await expect(
      handlePasskeyApi(request(), appEnv(), () =>
        Promise.resolve(
          adminToken({
            createdAt: Math.floor(Date.now() / 1000),
            grant: {
              clientId: "coverage-client",
              scope: ["memory:admin"],
              props: {
                workspaceId: "primary-workspace",
                principalId: PASSKEY_OWNER_ID,
                clientId: "coverage-client",
                scopes: ["memory:admin"],
                authenticatedAt: staleCeremony,
                credentialId: "api-credential-two"
              }
            }
          })
        )
      )
    ).rejects.toMatchObject({ code: "reauthentication_required" } satisfies Partial<DomainError>);
  });

  it("rejects administration grants whose authorizing passkey was revoked", async () => {
    const token = adminToken();
    const props = token.grant.props;
    if (typeof props !== "object" || props === null)
      throw new Error("test token props are missing");
    await expect(
      handlePasskeyApi(request(), appEnv(), () =>
        Promise.resolve({
          ...token,
          grant: { ...token.grant, props: { ...props, credentialId: "revoked-passkey" } }
        })
      )
    ).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DomainError>);
  });

  it("lists credentials and creates registration links", async () => {
    const unwrap = (): Promise<TokenSummary<unknown>> => Promise.resolve(adminToken());
    const listed = await handlePasskeyApi(request(), appEnv(), unwrap);
    const listBody = await listed.json<{ passkeys: Array<{ label: string }> }>();
    expect(listBody.passkeys.map((passkey) => passkey.label)).toEqual(["Laptop", "Phone"]);

    const created = await handlePasskeyApi(request("POST", { label: "Tablet" }), appEnv(), unwrap);
    expect(created.status).toBe(200);
    const createBody = await created.json<{ registrationUrl: string; expiresAt: string }>();
    expect(createBody.registrationUrl).toMatch(/^https:\/\/memory\.example\/passkeys\/add#/u);
    expect(Date.parse(createBody.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("revokes one credential and refuses unsupported methods", async () => {
    const unwrap = (): Promise<TokenSummary<unknown>> => Promise.resolve(adminToken());
    const credentialRef = await sha256("api-credential-one");
    const revoked = await handlePasskeyApi(request("DELETE", { credentialRef }), appEnv(), unwrap);
    await expect(revoked.json()).resolves.toEqual({
      revoked: credentialRef,
      sessionCleanupComplete: true
    });
    await expect(
      env.DB.prepare(
        "SELECT credential_id FROM passkey_credentials WHERE credential_id = 'api-credential-one'"
      ).first()
    ).resolves.toBeNull();

    const refused = await handlePasskeyApi(request("PATCH"), appEnv(), unwrap);
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  it("reports successful revocation when stale-session cleanup is unavailable", async () => {
    await env.DB.prepare(`INSERT INTO passkey_credentials
      (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
      VALUES ('api-cleanup-failure', ?, 'public-key-cleanup', 0, '[]', 'singleDevice', 0,
              '2026-07-19T00:00:02Z', 'Cleanup failure')`)
      .bind(PASSKEY_OWNER_ID)
      .run();
    const originalList = env.OAUTH_KV.list.bind(env.OAUTH_KV);
    env.OAUTH_KV.list = () => {
      throw new Error("injected KV outage");
    };
    try {
      const credentialRef = await sha256("api-cleanup-failure");
      const response = await handlePasskeyApi(request("DELETE", { credentialRef }), appEnv(), () =>
        Promise.resolve(adminToken())
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        revoked: credentialRef,
        sessionCleanupComplete: false
      });
      await expect(
        env.DB.prepare(
          "SELECT credential_id FROM passkey_credentials WHERE credential_id = 'api-cleanup-failure'"
        ).first()
      ).resolves.toBeNull();
    } finally {
      env.OAUTH_KV.list = originalList;
    }
  });
});
