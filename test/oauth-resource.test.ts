import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { bindAuthorizationResource } from "../src/auth/resource";

function request(resource?: string | string[]): AuthRequest {
  return {
    responseType: "code",
    clientId: "client",
    redirectUri: "http://127.0.0.1/callback",
    scope: ["memory:read"],
    state: "state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    ...(resource === undefined ? {} : { resource })
  };
}

describe("OAuth resource binding", () => {
  const canonical = "https://memory.example/mcp";

  it("injects the canonical audience when a client omits resource", () => {
    expect(bindAuthorizationResource(request(), canonical).resource).toBe(canonical);
  });

  it("accepts only the exact canonical resource", () => {
    expect(bindAuthorizationResource(request(canonical), canonical).resource).toBe(canonical);
    expect(bindAuthorizationResource(request([canonical]), canonical).resource).toBe(canonical);
    expect(() =>
      bindAuthorizationResource(request("https://other.example/mcp"), canonical)
    ).toThrow();
    expect(() =>
      bindAuthorizationResource(request([canonical, "https://other.example/mcp"]), canonical)
    ).toThrow();
  });
});
