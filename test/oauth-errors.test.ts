import { AUTH_RECOVERY_DESCRIPTION, wikimemoryOAuthErrorResponse } from "../src/auth/oauth-errors";

describe("OAuth recovery errors", () => {
  it("adds safe reauthorization guidance to an authentication challenge", async () => {
    const response = wikimemoryOAuthErrorResponse({
      code: "invalid_token",
      description: "Access token expired",
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate":
          'Bearer realm="OAuth", resource_metadata="https://memory.example/metadata", error="invalid_token", error_description="old description"'
      }
    });

    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("www-authenticate")).not.toContain("old description");
    expect(response?.headers.get("www-authenticate")).toContain(AUTH_RECOVERY_DESCRIPTION);
    await expect(response?.json()).resolves.toMatchObject({
      error: "invalid_token",
      recovery: { action: "reauthorize", retry: "after_reauthorization" }
    });
  });

  it("handles refresh failures that do not carry a challenge header", async () => {
    const response = wikimemoryOAuthErrorResponse({
      code: "invalid_grant",
      description: "Refresh token has expired",
      status: 400,
      headers: {}
    });

    expect(response?.headers.get("www-authenticate")).toBeNull();
    await expect(response?.json()).resolves.toMatchObject({
      error: "invalid_grant",
      error_description: AUTH_RECOVERY_DESCRIPTION
    });
  });

  it("leaves unrelated OAuth errors to the provider", () => {
    expect(
      wikimemoryOAuthErrorResponse({
        code: "invalid_scope",
        description: "Unsupported scope",
        status: 400,
        headers: {}
      })
    ).toBeUndefined();
  });
});
