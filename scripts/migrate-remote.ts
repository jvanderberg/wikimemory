import { readFile } from "node:fs/promises";
import { applyRemoteMigrations, bindingProperty } from "./setup.ts";

const config = await readFile("wrangler.production.jsonc", "utf8");
const databaseName = bindingProperty(config, "DB", "database_name");
if (databaseName === null)
  throw new Error("wrangler.production.jsonc has no bound D1 database name");
await applyRemoteMigrations(databaseName);
