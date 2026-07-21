import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { accessToken } from "./api-auth.ts";

function authorization(savedAt: string, accessTokenValue: string): object {
  return {
    origin: "https://memory.example",
    savedAt,
    clientInformation: { client_id: "cli-client" },
    tokens: {
      access_token: accessTokenValue,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-one"
    }
  };
}

await describe("API authorization storage", async () => {
  await it("uses a fresh stored access token without a network request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wikimemory-api-auth-"));
    const originalFetch = globalThis.fetch;
    try {
      await writeFile(
        join(directory, "api-auth.json"),
        JSON.stringify(authorization(new Date().toISOString(), "fresh-token"))
      );
      const failFetch: typeof fetch = () => Promise.reject(new Error("unexpected fetch"));
      globalThis.fetch = failFetch;
      assert.equal(await accessToken(directory), "fresh-token");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("refreshes expired credentials and persists rotated tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wikimemory-api-auth-"));
    const originalFetch = globalThis.fetch;
    try {
      await writeFile(
        join(directory, "api-auth.json"),
        JSON.stringify(authorization("2025-01-01T00:00:00Z", "expired-token"))
      );
      const refreshFetch: typeof fetch = (input, init) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        assert.equal(url, "https://memory.example/oauth/token");
        assert.equal(init?.method, "POST");
        assert.ok(init.body instanceof URLSearchParams);
        const body = init.body;
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("client_id"), "cli-client");
        assert.equal(body.get("resource"), "https://memory.example/api/v1");
        return Promise.resolve(
          Response.json({
            access_token: "refreshed-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-two"
          })
        );
      };
      globalThis.fetch = refreshFetch;
      assert.equal(await accessToken(directory), "refreshed-token");
      const stored: unknown = JSON.parse(await readFile(join(directory, "api-auth.json"), "utf8"));
      assert.equal(
        typeof stored === "object" &&
          stored !== null &&
          "tokens" in stored &&
          typeof stored.tokens === "object" &&
          stored.tokens !== null &&
          "refresh_token" in stored.tokens
          ? stored.tokens.refresh_token
          : null,
        "refresh-two"
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
