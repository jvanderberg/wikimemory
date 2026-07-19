import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;
  APP_ENV: "local" | "production";
  APP_BASE_URL?: string;
  SETUP_TOKEN_HASH?: string;
}

export function validateEnvironment(env: Env): void {
  if (env.APP_ENV === "production") {
    if (!env.APP_BASE_URL?.startsWith("https://"))
      throw new Error("production APP_BASE_URL must use HTTPS");
    if (!/^[a-f0-9]{64}$/u.test(env.SETUP_TOKEN_HASH ?? ""))
      throw new Error("production SETUP_TOKEN_HASH must be a SHA-256 hex digest");
  }
}
