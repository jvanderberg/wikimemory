import { env, exports } from "cloudflare:workers";
import { setupOptions } from "../src/auth/passkey";
import { sha256 } from "../src/domain/crypto";

describe("passkey boundaries", () => {
  it("reports the deployed application version", async () => {
    const response = await exports.default.fetch(new Request("https://example.test/health"));
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "wikimemory",
      version: "0.2.0"
    });
  });

  it("reports D1-backed readiness after passkey migrations", async () => {
    const response = await exports.default.fetch(new Request("https://example.test/ready"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      service: "wikimemory",
      version: "0.2.0",
      schemaVersion: "0004_credential_bound_registration_tokens.sql"
    });
  });

  it("serves the React setup shell without embedding setup material", async () => {
    const response = await exports.default.fetch(new Request("https://example.test/setup"));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toContain('<div id="root"></div>');
    expect(body).toMatch(/<script[^>]+src="\/assets\//u);
    expect(body).not.toContain("Primary passkey");
    expect(body).not.toContain("Google");
  });

  it("rejects setup without the production bootstrap secret", async () => {
    const response = await exports.default.fetch(
      new Request("https://example.test/setup/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "a".repeat(32), label: "Primary passkey" })
      })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This setup link is invalid or expired."
    });
  });

  it("enforces one-use bootstrap hashes and atomic challenge consumption", async () => {
    await env.DB.prepare(
      "INSERT INTO passkey_bootstrap(used_token_hash, completed_at) VALUES ('hash-one', '2026-07-18T00:00:00Z')"
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO passkey_bootstrap(used_token_hash, completed_at) VALUES ('hash-one', '2026-07-18T00:00:01Z')"
      ).run()
    ).rejects.toThrow(/UNIQUE/u);

    await env.DB.prepare(`INSERT INTO passkey_challenges(flow_id, kind, challenge, expires_at)
      VALUES ('flow-one', 'web', 'challenge-one', '2999-01-01T00:00:00Z')`).run();
    const first = await env.DB.prepare(`DELETE FROM passkey_challenges WHERE flow_id = 'flow-one'
      RETURNING challenge`).first<{ challenge: string }>();
    const second = await env.DB.prepare(`DELETE FROM passkey_challenges WHERE flow_id = 'flow-one'
      RETURNING challenge`).first<{ challenge: string }>();
    expect(first).toEqual({ challenge: "challenge-one" });
    expect(second).toBeNull();
  });

  it("generates origin-bound, user-verifying registration options for the current bootstrap", async () => {
    const token = "registration-token-with-at-least-32-characters";
    const tokenHash = await sha256(token);
    const response = await setupOptions(
      new Request("https://memory.example/setup/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, label: "Primary passkey" })
      }),
      { DB: env.DB, APP_BASE_URL: "https://memory.example", SETUP_TOKEN_HASH: tokenHash }
    );
    const body = await response.json<{
      options: { rp: { id: string }; authenticatorSelection: { userVerification: string } };
    }>();
    expect(response.status).toBe(200);
    expect(body.options.rp.id).toBe("memory.example");
    expect(body.options.authenticatorSelection.userVerification).toBe("required");
  });
});
