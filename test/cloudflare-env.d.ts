import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type * as WorkerModule from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      OAUTH_KV: KVNamespace;
      ASSETS: Fetcher;
      OAUTH_PROVIDER: OAuthHelpers;
      APP_ENV: "local" | "production";
      APP_BASE_URL?: string;
      SETUP_TOKEN_HASH?: string;
      TEST_MIGRATIONS: D1Migration[];
    }

    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}

export {};
