import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
