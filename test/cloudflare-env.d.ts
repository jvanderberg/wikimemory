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
      TEST_MIGRATIONS: D1Migration[];
    }

    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}

export {};
