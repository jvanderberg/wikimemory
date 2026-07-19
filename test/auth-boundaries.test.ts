import { env } from "cloudflare:workers";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  approveLocalAuthorization,
  handleLocalAuthorization,
  localAuthorizationOptions
} from "../src/auth/local";
import {
  beginPasskeyAuthorization,
  passkeyAuthorizationOptions,
  registrationOptions,
  registrationVerify,
  setupOptions,
  setupVerify,
  verifyPasskeyAuthorization
} from "../src/auth/passkey";
import { createRegistrationToken, PASSKEY_OWNER_ID } from "../src/auth/passkey-management";
import { bindAuthorizationResource, canonicalMcpResource } from "../src/auth/resource";
import { sha256 } from "../src/domain/crypto";
import type { Env } from "../src/env";
import { validateEnvironment } from "../src/env";

const BASE_URL = "https://memory.example";

function appEnv(values?: Partial<Pick<Env, "APP_ENV" | "APP_BASE_URL" | "SETUP_TOKEN_HASH">>): Env {
  return {
    DB: env.DB,
    OAUTH_KV: env.OAUTH_KV,
    ASSETS: env.ASSETS,
    OAUTH_PROVIDER: env.OAUTH_PROVIDER,
    APP_ENV: values?.APP_ENV ?? "production",
    ...(values?.APP_BASE_URL === undefined ? {} : { APP_BASE_URL: values.APP_BASE_URL }),
    ...(values?.SETUP_TOKEN_HASH === undefined ? {} : { SETUP_TOKEN_HASH: values.SETUP_TOKEN_HASH })
  };
}

const authRequest = {
  responseType: "code",
  clientId: "coverage-client",
  redirectUri: "https://client.example/callback",
  scope: ["memory:read"],
  state: "state"
} satisfies AuthRequest;

const fakeRegistrationResponse = {
  id: "ZmFrZQ",
  rawId: "ZmFrZQ",
  type: "public-key",
  clientExtensionResults: {},
  response: { clientDataJSON: "ZmFrZQ", attestationObject: "ZmFrZQ" }
};

const fakeAuthenticationResponse = {
  id: "ZmFrZQ",
  rawId: "ZmFrZQ",
  type: "public-key",
  clientExtensionResults: {},
  response: {
    clientDataJSON: "ZmFrZQ",
    authenticatorData: "ZmFrZQ",
    signature: "ZmFrZQ"
  }
};

describe("environment and OAuth resource boundaries", () => {
  it("validates production configuration and leaves local configuration unrestricted", () => {
    expect(() => {
      validateEnvironment(appEnv({ APP_ENV: "local" }));
    }).not.toThrow();
    expect(() => {
      validateEnvironment(appEnv({ APP_BASE_URL: "http://memory.example" }));
    }).toThrow("must use HTTPS");
    expect(() => {
      validateEnvironment(appEnv({ APP_BASE_URL: BASE_URL, SETUP_TOKEN_HASH: "invalid" }));
    }).toThrow("SHA-256");
    expect(() => {
      validateEnvironment({
        ...appEnv({ APP_BASE_URL: BASE_URL, SETUP_TOKEN_HASH: "a".repeat(64) })
      });
    }).not.toThrow();
  });

  it("requires and binds the canonical MCP resource", () => {
    expect(() => canonicalMcpResource(undefined)).toThrow("APP_BASE_URL");
    expect(canonicalMcpResource(BASE_URL)).toBe(`${BASE_URL}/mcp`);
    expect(bindAuthorizationResource(authRequest, `${BASE_URL}/mcp`).resource).toBe(
      `${BASE_URL}/mcp`
    );
    expect(
      bindAuthorizationResource(
        { ...authRequest, resource: [`${BASE_URL}/mcp`] },
        `${BASE_URL}/mcp`
      ).resource
    ).toBe(`${BASE_URL}/mcp`);
    expect(() =>
      bindAuthorizationResource(
        { ...authRequest, resource: "https://evil.example/mcp" },
        `${BASE_URL}/mcp`
      )
    ).toThrow("not this Wikimemory");
    expect(() =>
      bindAuthorizationResource(
        { ...authRequest, resource: [`${BASE_URL}/mcp`, `${BASE_URL}/mcp`] },
        `${BASE_URL}/mcp`
      )
    ).toThrow("not this Wikimemory");
    expect(
      bindAuthorizationResource(
        { ...authRequest, codeChallenge: "challenge", codeChallengeMethod: "S256" },
        `${BASE_URL}/mcp`
      )
    ).toMatchObject({ codeChallenge: "challenge", codeChallengeMethod: "S256" });
  });
});

describe("local authorization boundaries", () => {
  it("redirects only GET requests in local mode", () => {
    const local = appEnv({ APP_ENV: "local" });
    const redirected = handleLocalAuthorization(
      new Request(`${BASE_URL}/authorize?client_id=test`),
      local
    );
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe(`${BASE_URL}/local-authorize?client_id=test`);
    expect(
      handleLocalAuthorization(new Request(`${BASE_URL}/authorize`, { method: "POST" }), local)
        .status
    ).toBe(405);
    expect(handleLocalAuthorization(new Request(`${BASE_URL}/authorize`), appEnv()).status).toBe(
      501
    );
  });

  it("hides local option and approval APIs in production", async () => {
    await expect(
      localAuthorizationOptions(new Request(`${BASE_URL}/api/local-authorize/options`), appEnv())
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      approveLocalAuthorization(
        new Request(`${BASE_URL}/api/local-authorize/approve`, { method: "POST" }),
        appEnv()
      )
    ).resolves.toMatchObject({ status: 404 });
  });
});

describe("passkey registration and authentication boundaries", () => {
  beforeAll(async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO principals
      (id, provider, provider_subject, email_verified, created_at)
      VALUES (?, 'passkey', ?, 1, '2026-07-19T00:00:00Z')`)
      .bind(PASSKEY_OWNER_ID, PASSKEY_OWNER_ID)
      .run();
  });

  it("rejects reused setup material before creating a challenge", async () => {
    const token = "reused-setup-token-with-at-least-32-characters";
    const tokenHash = await sha256(token);
    await env.DB.prepare(
      "INSERT INTO passkey_bootstrap(used_token_hash, completed_at) VALUES (?, '2026-07-19T00:00:00Z')"
    )
      .bind(tokenHash)
      .run();
    const result = await setupOptions(
      new Request(`${BASE_URL}/setup/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, label: "Primary passkey" })
      }),
      appEnv({ APP_BASE_URL: BASE_URL, SETUP_TOKEN_HASH: tokenHash })
    );
    expect(result.status).toBe(409);
  });

  it("creates a one-use add-passkey challenge with existing credentials excluded", async () => {
    await env.DB.prepare(`INSERT INTO passkey_credentials
      (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at, label)
      VALUES ('Y3JlZGVudGlhbA', ?, 'cHVibGljLWtleQ', 0, '["internal"]', 'multiDevice', 1,
              '2026-07-19T00:00:00Z', 'Existing passkey')`)
      .bind(PASSKEY_OWNER_ID)
      .run();
    const token = await createRegistrationToken(env.DB, "Phone passkey", "Y3JlZGVudGlhbA");
    const result = await registrationOptions(
      new Request(`${BASE_URL}/passkeys/add/options`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.rawToken })
      }),
      appEnv({ APP_BASE_URL: BASE_URL })
    );
    const body = await result.json<{
      flowId: string;
      label: string;
      options: { rp: { id: string }; excludeCredentials: Array<{ id: string }> };
    }>();
    expect(body.label).toBe("Phone passkey");
    expect(body.options.rp.id).toBe("memory.example");
    expect(body.options.excludeCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Y3JlZGVudGlhbA", transports: ["internal"] })
      ])
    );
  });

  it("creates and reads a browser authentication challenge", async () => {
    const environment = appEnv({ APP_BASE_URL: BASE_URL });
    const started = await beginPasskeyAuthorization(
      new Request(`${BASE_URL}/app/login`),
      environment,
      "web"
    );
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get("location") ?? BASE_URL);
    expect(location.pathname).toBe("/login");
    const flowId = location.searchParams.get("flowId");
    const options = await passkeyAuthorizationOptions(
      new Request(`${BASE_URL}/api/auth/options?flowId=${flowId ?? ""}`),
      environment
    );
    const body = await options.json<{ kind: string; options: { userVerification: string } }>();
    expect(body.kind).toBe("web");
    expect(body.options.userVerification).toBe("required");
  });

  it("consumes no state for unknown verification flows", async () => {
    const environment = appEnv({ APP_BASE_URL: BASE_URL });
    const flowId = "00000000-0000-4000-8000-000000000001";
    const setup = await setupVerify(
      new Request(`${BASE_URL}/setup/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId, response: fakeRegistrationResponse })
      }),
      environment
    );
    expect(setup.status).toBe(410);

    const registration = await registrationVerify(
      new Request(`${BASE_URL}/passkeys/add/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId, response: fakeRegistrationResponse })
      }),
      environment
    );
    expect(registration.status).toBe(410);

    const authentication = await verifyPasskeyAuthorization(
      new Request(`${BASE_URL}/auth/passkey/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId, response: fakeAuthenticationResponse })
      }),
      environment
    );
    expect(authentication.status).toBe(410);
  });

  it("fails closed for changed setup configuration and incomplete registration state", async () => {
    const setupFlowId = "00000000-0000-4000-8000-000000000010";
    await env.DB.prepare(`INSERT INTO passkey_challenges
      (flow_id, kind, challenge, payload_json, token_hash, expires_at)
      VALUES (?, 'setup', 'challenge', '{"mode":"initial","label":"Primary"}', 'old-hash',
              '2999-01-01T00:00:00Z')`)
      .bind(setupFlowId)
      .run();
    const changed = await setupVerify(
      new Request(`${BASE_URL}/setup/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: setupFlowId, response: fakeRegistrationResponse })
      }),
      appEnv({ APP_BASE_URL: BASE_URL, SETUP_TOKEN_HASH: "new-hash" })
    );
    expect(changed.status).toBe(403);

    const registrationFlowId = "00000000-0000-4000-8000-000000000011";
    await env.DB.prepare(`INSERT INTO passkey_challenges
      (flow_id, kind, challenge, payload_json, token_hash, expires_at)
      VALUES (?, 'registration', 'challenge', '{"label":"Phone"}', NULL,
              '2999-01-01T00:00:00Z')`)
      .bind(registrationFlowId)
      .run();
    const incomplete = await registrationVerify(
      new Request(`${BASE_URL}/passkeys/add/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId: registrationFlowId, response: fakeRegistrationResponse })
      }),
      appEnv({ APP_BASE_URL: BASE_URL })
    );
    expect(incomplete.status).toBe(410);
  });

  it("rejects an unknown credential after consuming an authentication challenge", async () => {
    const flowId = "00000000-0000-4000-8000-000000000012";
    await env.DB.prepare(`INSERT INTO passkey_challenges
      (flow_id, kind, challenge, payload_json, expires_at)
      VALUES (?, 'web', 'challenge', '{"kind":"web","options":{}}',
              '2999-01-01T00:00:00Z')`)
      .bind(flowId)
      .run();
    const result = await verifyPasskeyAuthorization(
      new Request(`${BASE_URL}/auth/passkey/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId, response: fakeAuthenticationResponse })
      }),
      appEnv({ APP_BASE_URL: BASE_URL })
    );
    expect(result.status).toBe(403);
    await expect(result.json()).resolves.toEqual({ error: "Unknown passkey." });
  });
});
