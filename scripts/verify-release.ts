import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { LATEST_SCHEMA_VERSION, WIKIMEMORY_VERSION } from "../src/version.ts";
import { validateReleaseManifest } from "./upgrade.ts";

const PACKAGE_SCHEMA = z.object({ version: z.string() });

async function verifyRelease(): Promise<void> {
  const root = join(import.meta.dirname, "..");
  const packageJson = PACKAGE_SCHEMA.parse(
    JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  );
  const manifest = validateReleaseManifest(
    JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8"))
  );
  if (packageJson.version !== WIKIMEMORY_VERSION || manifest.version !== WIKIMEMORY_VERSION)
    throw new Error("package.json, release manifest, and Worker versions must match");
  if (manifest.schemaVersion !== LATEST_SCHEMA_VERSION)
    throw new Error("Release manifest and Worker schema versions must match");

  const migrationNames = (await readdir(join(root, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const manifestNames = manifest.migrations.map((migration) => migration.name);
  if (JSON.stringify(migrationNames) !== JSON.stringify(manifestNames))
    throw new Error("Release manifest must include every migration exactly once");

  for (const migration of manifest.migrations) {
    const sql = await readFile(join(root, "migrations", migration.name), "utf8");
    const digest = createHash("sha256").update(sql, "utf8").digest("hex");
    if (digest !== migration.sha256)
      throw new Error(`Migration checksum mismatch: ${migration.name}`);
  }
  console.log(
    `Verified Wikimemory ${manifest.version} release with ${manifest.migrations.length} migrations.`
  );
}

await verifyRelease();
