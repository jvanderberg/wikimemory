import { env } from "cloudflare:workers";
import { PASSKEY_OWNER_ID } from "../src/auth/passkey-management";
import { actorFromAuthorization } from "../src/auth/props";

const productionEnv = { APP_ENV: "production", DB: env.DB } as const;
const baseProps = {
  workspaceId: "primary-workspace",
  principalId: PASSKEY_OWNER_ID,
  clientId: "recovery-race-client",
  scopes: ["memory:read"]
} as const;

describe("production MCP authorization credentials", () => {
  beforeAll(async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO principals
      (id, provider, provider_subject, email_verified, created_at)
      VALUES (?, 'passkey', ?, 1, '2026-07-19T00:00:00Z')`)
      .bind(PASSKEY_OWNER_ID, PASSKEY_OWNER_ID)
      .run();
    await env.DB.prepare(`INSERT INTO passkey_credentials
      (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
      VALUES ('credential-still-authorized', ?, 'public-key', 0, '[]', 'singleDevice', 0,
              '2026-07-19T00:00:00Z', 'Authorized device')`)
      .bind(PASSKEY_OWNER_ID)
      .run();
  });

  it("rejects a grant created by a passkey removed during recovery", async () => {
    await expect(
      actorFromAuthorization(
        { ...baseProps, credentialId: "credential-removed-during-recovery" },
        productionEnv
      )
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("accepts a production grant only while its authorizing passkey exists", async () => {
    await expect(
      actorFromAuthorization(
        { ...baseProps, credentialId: "credential-still-authorized" },
        productionEnv
      )
    ).resolves.toMatchObject({ principalId: PASSKEY_OWNER_ID });
  });

  it("does not require a passkey binding for local development grants", async () => {
    await expect(
      actorFromAuthorization(baseProps, { APP_ENV: "local", DB: env.DB })
    ).resolves.toMatchObject({ principalId: PASSKEY_OWNER_ID });
  });
});
