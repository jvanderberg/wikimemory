import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type * as WorkerModule from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }

    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}

export {};
