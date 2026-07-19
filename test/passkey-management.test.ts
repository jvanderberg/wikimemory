import { env } from "cloudflare:workers";
import {
  createRegistrationToken,
  listPasskeys,
  PASSKEY_OWNER_ID,
  registrationToken,
  requireRecentPasskeyAuthentication,
  revokePasskey
} from "../src/auth/passkey-management";
import { sha256 } from "../src/domain/crypto";

describe("passkey management", () => {
  beforeAll(async () => {
    await env.DB.prepare(`INSERT INTO principals
      (id, provider, provider_subject, email_verified, created_at)
      VALUES (?, 'passkey', ?, 1, '2026-07-19T00:00:00Z')`)
      .bind(PASSKEY_OWNER_ID, PASSKEY_OWNER_ID)
      .run();
  });

  it("lists opaque credential references, revokes one credential, and preserves the final one", async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
        VALUES ('credential-one', ?, 'public-key-one', 0, '[]', 'singleDevice', 0, '2026-07-19T00:00:00Z', 'Laptop')`).bind(
        PASSKEY_OWNER_ID
      ),
      env.DB.prepare(`INSERT INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
        VALUES ('credential-two', ?, 'public-key-two', 0, '[]', 'multiDevice', 1, '2026-07-19T00:00:01Z', 'Password manager')`).bind(
        PASSKEY_OWNER_ID
      )
    ]);

    const listed = await listPasskeys(env.DB);
    expect(listed).toEqual([
      {
        credentialRef: await sha256("credential-one"),
        label: "Laptop",
        deviceType: "singleDevice",
        backedUp: false,
        createdAt: "2026-07-19T00:00:00Z",
        lastUsedAt: null
      },
      {
        credentialRef: await sha256("credential-two"),
        label: "Password manager",
        deviceType: "multiDevice",
        backedUp: true,
        createdAt: "2026-07-19T00:00:01Z",
        lastUsedAt: null
      }
    ]);

    const revokedId = await revokePasskey(env.DB, await sha256("credential-one"));
    expect(revokedId).toBe("credential-one");
    await expect(revokePasskey(env.DB, await sha256("credential-two"))).rejects.toThrow(
      "final passkey"
    );
    await expect(
      env.DB.prepare("DELETE FROM passkey_credentials WHERE credential_id = 'credential-two'").run()
    ).rejects.toThrow("cannot delete final passkey");
  });

  it("creates opaque, expiring, owner-bound registration tokens", async () => {
    const token = await createRegistrationToken(env.DB, "  Phone  ");
    expect(token.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());
    await expect(registrationToken(env.DB, token.rawToken)).resolves.toEqual({
      tokenHash: await sha256(token.rawToken),
      label: "Phone"
    });
    await expect(registrationToken(env.DB, "too-short")).resolves.toBeNull();
  });

  it("requires authentication from the last five minutes", () => {
    expect(() => {
      requireRecentPasskeyAuthentication(new Date().toISOString());
    }).not.toThrow();
    expect(() => {
      requireRecentPasskeyAuthentication(new Date(Date.now() - 301_000).toISOString());
    }).toThrow("five minutes");
    expect(() => {
      requireRecentPasskeyAuthentication("not-a-date");
    }).toThrow("five minutes");
  });
});
