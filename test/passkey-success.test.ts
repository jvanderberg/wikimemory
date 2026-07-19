import { env } from "cloudflare:workers";
import type {
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse
} from "@simplewebauthn/server";
import {
  beginPasskeyAuthorization,
  productionWebOwner,
  registrationOptions,
  registrationVerify,
  setupOptions,
  setupVerify,
  verifyPasskeyAuthorization
} from "../src/auth/passkey";
import {
  createRegistrationToken,
  PASSKEY_OWNER_ID,
  registrationToken,
  revokePasskey
} from "../src/auth/passkey-management";
import { sha256 } from "../src/domain/crypto";
import type { Env } from "../src/env";

const BASE_URL = "https://memory.example";

function productionEnv(setupTokenHash: string): Env {
  return {
    DB: env.DB,
    OAUTH_KV: env.OAUTH_KV,
    ASSETS: env.ASSETS,
    OAUTH_PROVIDER: env.OAUTH_PROVIDER,
    APP_ENV: "production",
    APP_BASE_URL: BASE_URL,
    SETUP_TOKEN_HASH: setupTokenHash
  };
}

const browserRegistrationResponse = {
  id: "YnJvd3Nlci1jcmVkZW50aWFs",
  rawId: "YnJvd3Nlci1jcmVkZW50aWFs",
  type: "public-key",
  authenticatorAttachment: "platform",
  clientExtensionResults: {},
  response: {
    clientDataJSON: "Y2xpZW50LWRhdGE",
    attestationObject: "YXR0ZXN0YXRpb24",
    authenticatorData: "YXV0aGVudGljYXRvci1kYXRh",
    transports: ["internal", "hybrid"],
    publicKeyAlgorithm: -7,
    publicKey: "cHVibGljLWtleQ"
  }
} as const;

const browserAuthenticationResponse = {
  id: browserRegistrationResponse.id,
  rawId: browserRegistrationResponse.rawId,
  type: "public-key",
  authenticatorAttachment: "platform",
  clientExtensionResults: {},
  response: {
    clientDataJSON: "Y2xpZW50LWRhdGE",
    authenticatorData: "YXV0aGVudGljYXRvci1kYXRh",
    signature: "c2lnbmF0dXJl",
    userHandle: "dXNlcg"
  }
} as const;

function verifiedRegistration(
  credentialId: string = browserRegistrationResponse.id
): VerifiedRegistrationResponse {
  return {
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: {
        id: credentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ["internal"]
      },
      credentialType: "public-key",
      attestationObject: new Uint8Array([5, 6, 7]),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: BASE_URL,
      rpID: "memory.example"
    }
  };
}

function verifiedAuthentication(newCounter: number): VerifiedAuthenticationResponse {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: browserRegistrationResponse.id,
      newCounter,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: BASE_URL,
      rpID: "memory.example"
    }
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function flowId(response: Response): Promise<string> {
  const body = await response.json<{ flowId: string }>();
  return body.flowId;
}

describe("successful passkey lifecycle", () => {
  it("sets up the owner and seeds orientation through an injected verified ceremony", async () => {
    const token = "initial-setup-token-long-enough-for-validation";
    const appEnv = productionEnv(await sha256(token));
    const started = await setupOptions(
      post("/setup/options", { token, label: "Password manager" }),
      appEnv
    );
    expect(started.status).toBe(200);

    const completed = await setupVerify(
      post("/setup/verify", {
        flowId: await flowId(started),
        response: browserRegistrationResponse
      }),
      appEnv,
      () => Promise.resolve(verifiedRegistration())
    );
    await expect(completed.json()).resolves.toEqual({ ok: true, mode: "initial" });

    const credential = await env.DB.prepare(
      "SELECT label, public_key, backed_up FROM passkey_credentials WHERE credential_id = ?"
    )
      .bind(browserRegistrationResponse.id)
      .first<{ label: string; public_key: string; backed_up: number }>();
    expect(credential).toEqual({
      label: "Password manager",
      public_key: "AQIDBA",
      backed_up: 1
    });
    await expect(
      env.DB.prepare("SELECT slug FROM documents WHERE slug = 'home'").first<{ slug: string }>()
    ).resolves.toEqual({ slug: "home" });
  });

  it("adds another credential and consumes its one-use registration token", async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO principals
      (id, provider, provider_subject, email_verified, created_at)
      VALUES (?, 'passkey', ?, 1, '2026-07-19T00:00:00Z')`)
      .bind(PASSKEY_OWNER_ID, PASSKEY_OWNER_ID)
      .run();
    const token = await createRegistrationToken(
      env.DB,
      "Phone passkey",
      browserRegistrationResponse.id
    );
    const appEnv = productionEnv("a".repeat(64));
    const started = await registrationOptions(
      post("/passkeys/add/options", { token: token.rawToken }),
      appEnv
    );
    const addedId = "cGhvbmUtY3JlZGVudGlhbA";
    const completed = await registrationVerify(
      post("/passkeys/add/verify", {
        flowId: await flowId(started),
        response: browserRegistrationResponse
      }),
      appEnv,
      () => Promise.resolve(verifiedRegistration(addedId))
    );
    await expect(completed.json()).resolves.toEqual({ ok: true, label: "Phone passkey" });
    await expect(
      env.DB.prepare("SELECT label FROM passkey_credentials WHERE credential_id = ?")
        .bind(addedId)
        .first<{ label: string }>()
    ).resolves.toEqual({ label: "Phone passkey" });
    await expect(
      env.DB.prepare("SELECT 1 FROM passkey_registration_tokens WHERE token_hash = ?")
        .bind(await sha256(token.rawToken))
        .first()
    ).resolves.toBeNull();
  });

  it("rejects a registration flow after its authorizing credential is revoked", async () => {
    const authorizingCredential = "cGhvbmUtY3JlZGVudGlhbA";
    const token = await createRegistrationToken(
      env.DB,
      "Attacker replacement",
      authorizingCredential
    );
    const appEnv = productionEnv("a".repeat(64));
    const started = await registrationOptions(
      post("/passkeys/add/options", { token: token.rawToken }),
      appEnv
    );
    await revokePasskey(env.DB, await sha256(authorizingCredential));
    const completed = await registrationVerify(
      post("/passkeys/add/verify", {
        flowId: await flowId(started),
        response: browserRegistrationResponse
      }),
      appEnv,
      () => Promise.resolve(verifiedRegistration("YXR0YWNrZXItY3JlZGVudGlhbA"))
    );
    expect(completed.status).toBe(403);
  });

  it("invalidates every outstanding registration capability during recovery", async () => {
    const stale = await createRegistrationToken(
      env.DB,
      "Stale recovery link",
      browserRegistrationResponse.id
    );
    const recoveryToken = "recovery-setup-token-long-enough-for-validation";
    const appEnv = productionEnv(await sha256(recoveryToken));
    const started = await setupOptions(
      post("/setup/options", { token: recoveryToken, label: "Recovered passkey" }),
      appEnv
    );
    const completed = await setupVerify(
      post("/setup/verify", {
        flowId: await flowId(started),
        response: browserRegistrationResponse
      }),
      appEnv,
      () => Promise.resolve(verifiedRegistration("cmVjb3ZlcmVkLWNyZWRlbnRpYWw")),
      () => Promise.resolve()
    );
    await expect(completed.json()).resolves.toEqual({ ok: true, mode: "recovery" });
    await expect(registrationToken(env.DB, stale.rawToken)).resolves.toBeNull();
  });

  it("creates a production browser session after verified authentication", async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO passkey_credentials
      (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
      VALUES (?, ?, 'AQIDBA', 0, '["internal"]', 'multiDevice', 1,
              '2026-07-19T00:00:00Z', 'Password manager')`)
      .bind(browserRegistrationResponse.id, PASSKEY_OWNER_ID)
      .run();
    const appEnv = productionEnv("a".repeat(64));
    const started = await beginPasskeyAuthorization(
      new Request(`${BASE_URL}/app/login`),
      appEnv,
      "web"
    );
    const loginFlowId = new URL(started.headers.get("location") ?? BASE_URL).searchParams.get(
      "flowId"
    );
    expect(loginFlowId).not.toBeNull();
    const completed = await verifyPasskeyAuthorization(
      post("/auth/passkey/verify", {
        flowId: loginFlowId,
        response: browserAuthenticationResponse
      }),
      appEnv,
      () => Promise.resolve(verifiedAuthentication(1))
    );
    await expect(completed.json()).resolves.toEqual({ redirectTo: "/app" });
    expect(completed.headers.get("set-cookie")).toMatch(
      /^wm_web_session=[^;]+; HttpOnly; Secure; Path=\/; SameSite=Lax; Max-Age=86400$/u
    );
    const cookie = completed.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeDefined();
    await expect(
      productionWebOwner(
        new Request(`${BASE_URL}/api/app/session`, { headers: { cookie: cookie ?? "" } }),
        appEnv
      )
    ).resolves.toMatchObject({ principalId: PASSKEY_OWNER_ID, role: "owner" });
    await expect(
      env.DB.prepare("SELECT counter FROM passkey_credentials WHERE credential_id = ?")
        .bind(browserRegistrationResponse.id)
        .first<{ counter: number }>()
    ).resolves.toEqual({ counter: 1 });
  });

  it("rejects a verifier failure without advancing the credential counter", async () => {
    const appEnv = productionEnv("a".repeat(64));
    const started = await beginPasskeyAuthorization(
      new Request(`${BASE_URL}/app/login`),
      appEnv,
      "web"
    );
    const loginFlowId = new URL(started.headers.get("location") ?? BASE_URL).searchParams.get(
      "flowId"
    );
    const completed = await verifyPasskeyAuthorization(
      post("/auth/passkey/verify", {
        flowId: loginFlowId,
        response: browserAuthenticationResponse
      }),
      appEnv,
      () =>
        Promise.resolve({
          ...verifiedAuthentication(2),
          verified: false
        })
    );
    expect(completed.status).toBe(403);
  });
});
