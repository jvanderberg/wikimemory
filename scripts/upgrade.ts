import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import {
  type DeploymentRecord,
  deploymentRecordPath,
  readDeploymentRecord,
  writeDeploymentRecord
} from "./deployment-record.ts";
import { packageRoot } from "./package-root.ts";

const PACKAGE_ROOT = packageRoot();
const DEPLOYMENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const RELEASE_MANIFEST_SCHEMA = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    schemaVersion: z.string().regex(MIGRATION_NAME),
    migrations: z.array(
      z
        .object({ name: z.string().regex(MIGRATION_NAME), sha256: z.string().regex(SHA256) })
        .strict()
    )
  })
  .strict();

export type ReleaseManifest = z.infer<typeof RELEASE_MANIFEST_SCHEMA>;

export interface UpgradeOptions {
  deployment: string;
  recordPath: string | null;
  yes: boolean;
  help: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RemoteTargets {
  accounts: Array<{ id: string }>;
  databases: Array<{ uuid: string; name: string }>;
  namespaces: Array<{ id: string; title: string }>;
}

export function parseUpgradeOptions(args: string[]): UpgradeOptions {
  let deployment = "wikimemory";
  let recordPath: string | null = null;
  let yes = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--yes") yes = true;
    else if (argument === "--help") help = true;
    else if (argument === "--deployment" || argument === "--record") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${argument} requires a value`);
      if (argument === "--deployment") {
        if (!DEPLOYMENT_NAME.test(value)) throw new Error("Invalid deployment name");
        deployment = value;
      } else recordPath = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument ?? ""}`);
  }
  return { deployment, recordPath, yes, help };
}

export function validateReleaseManifest(value: unknown): ReleaseManifest {
  const manifest = RELEASE_MANIFEST_SCHEMA.parse(value);
  const names = manifest.migrations.map((item) => item.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name, index) => index > 0 && name <= (names[index - 1] ?? ""))
  )
    throw new Error("Release migrations must be unique and strictly ordered");
  if (names.at(-1) !== manifest.schemaVersion)
    throw new Error("Release schemaVersion must equal the final migration");
  return manifest;
}

export function planMigrations(
  manifest: ReleaseManifest,
  appliedNames: string[]
): ReleaseManifest["migrations"] {
  if (appliedNames.length > manifest.migrations.length)
    throw new Error("Installed schema is newer than this Wikimemory release");
  for (const [index, applied] of appliedNames.entries()) {
    if (manifest.migrations[index]?.name !== applied)
      throw new Error("Installed migration history does not match this release");
  }
  return manifest.migrations.slice(appliedNames.length);
}

export function compareSemanticVersions(left: string, right: string): number {
  const version = z.string().regex(/^\d+\.\d+\.\d+$/u);
  const leftParts = version.parse(left).split(".").map(Number);
  const rightParts = version.parse(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function productionUpgradeConfig(record: DeploymentRecord, packageRoot: string): string {
  return `${JSON.stringify(
    {
      $schema: join(packageRoot, "node_modules", "wrangler", "config-schema.json"),
      name: record.workerName,
      account_id: record.accountId,
      main: join(packageRoot, "src", "index.ts"),
      compatibility_date: "2026-07-18",
      compatibility_flags: ["nodejs_compat"],
      assets: {
        directory: join(packageRoot, "dist", "web"),
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: true
      },
      vars: { APP_ENV: "production", APP_BASE_URL: record.origin },
      d1_databases: [
        {
          binding: "DB",
          database_name: record.databaseName,
          database_id: record.databaseId,
          migrations_dir: join(packageRoot, "migrations")
        }
      ],
      kv_namespaces: [{ binding: "OAUTH_KV", id: record.kvId }]
    },
    null,
    2
  )}\n`;
}

const PRODUCTION_UPGRADE_CONFIG_SCHEMA = z.object({
  name: z.string(),
  account_id: z.string(),
  main: z.string(),
  assets: z.object({ directory: z.string(), run_worker_first: z.literal(true) }),
  vars: z.object({ APP_BASE_URL: z.string() }),
  d1_databases: z.array(z.object({ database_id: z.string() })),
  kv_namespaces: z.array(z.object({ id: z.string() }))
});

export function parseProductionUpgradeConfig(
  value: unknown
): z.infer<typeof PRODUCTION_UPGRADE_CONFIG_SCHEMA> {
  return PRODUCTION_UPGRADE_CONFIG_SCHEMA.parse(value);
}

export function validateRemoteTargets(record: DeploymentRecord, remote: RemoteTargets): void {
  if (!remote.accounts.some((account) => account.id === record.accountId))
    throw new Error("Authenticated identity cannot access the recorded Cloudflare account");
  if (
    !remote.databases.some(
      (database) => database.uuid === record.databaseId && database.name === record.databaseName
    )
  )
    throw new Error("Recorded D1 database ID and name do not match Cloudflare");
  if (
    !remote.namespaces.some(
      (namespace) => namespace.id === record.kvId && namespace.title === record.kvName
    )
  )
    throw new Error("Recorded KV namespace ID and name do not match Cloudflare");
}

function migrationBundle(sql: string, migration: ReleaseManifest["migrations"][number]): string {
  const name = migration.name.replaceAll("'", "''");
  return `${sql.trimEnd()}\n\nINSERT INTO d1_migrations(name) VALUES ('${name}');\n`;
}

async function command(commandName: string, args: string[]): Promise<CommandResult> {
  const { spawn } = await import("node:child_process");
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(commandName, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function parsedJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

async function confirmUpgrade(summary: string, automatic: boolean): Promise<void> {
  console.log(summary);
  if (automatic) return;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question("Apply this upgrade? [y/N] ")).trim().toLowerCase();
  prompt.close();
  if (answer !== "y" && answer !== "yes") throw new Error("Cancelled");
}

async function verifyRelease(origin: string, manifest: ReleaseManifest): Promise<void> {
  const health = await fetch(`${origin}/health`, { redirect: "error" });
  const healthBody = z
    .object({ status: z.literal("ok"), service: z.literal("wikimemory"), version: z.string() })
    .parse(await health.json());
  if (!health.ok || healthBody.version !== manifest.version)
    throw new Error("Deployed Worker version verification failed");
  const ready = await fetch(`${origin}/ready`, { redirect: "error" });
  const readyBody = z
    .object({
      status: z.literal("ready"),
      service: z.literal("wikimemory"),
      version: z.string(),
      schemaVersion: z.string()
    })
    .parse(await ready.json());
  if (
    !ready.ok ||
    readyBody.version !== manifest.version ||
    readyBody.schemaVersion !== manifest.schemaVersion
  )
    throw new Error("Deployed schema version verification failed");
  const discovery = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, {
    redirect: "error"
  });
  if (!discovery.ok) throw new Error("OAuth protected-resource discovery verification failed");
  const app = await fetch(`${origin}/app`, { redirect: "error" });
  if (!app.ok || !(await app.text()).includes('<div id="root"></div>'))
    throw new Error("React application verification failed");
}

export async function runUpgrade(args: string[]): Promise<void> {
  const options = parseUpgradeOptions(args);
  if (options.help) {
    console.log("Usage: wikimemory upgrade [--deployment NAME | --record PATH] [--yes]");
    return;
  }
  const recordPath = options.recordPath ?? deploymentRecordPath(options.deployment);
  const record = await readDeploymentRecord(recordPath);
  const manifest = validateReleaseManifest(
    parsedJson(await readFile(join(PACKAGE_ROOT, "release-manifest.json"), "utf8"))
  );
  for (const migration of manifest.migrations) {
    const sql = await readFile(join(PACKAGE_ROOT, "migrations", migration.name), "utf8");
    const digest = createHash("sha256").update(sql, "utf8").digest("hex");
    if (digest !== migration.sha256)
      throw new Error(`Packaged migration checksum mismatch: ${migration.name}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "wikimemory-upgrade-"));
  try {
    const configPath = join(temporary, "wrangler.jsonc");
    await writeFile(configPath, productionUpgradeConfig(record, PACKAGE_ROOT), "utf8");
    const common = ["--config", configPath];
    const [whoami, deployments, d1, kv] = await Promise.all([
      command("npx", ["wrangler", "whoami", "--json"]),
      command("npx", [
        "wrangler",
        "deployments",
        "list",
        "--name",
        record.workerName,
        "--json",
        ...common
      ]),
      command("npx", ["wrangler", "d1", "list", "--json", ...common]),
      command("npx", ["wrangler", "kv", "namespace", "list", ...common])
    ]);
    if ([whoami, deployments, d1, kv].some((result) => result.exitCode !== 0))
      throw new Error("Cloudflare target preflight failed");
    const whoamiBody = z
      .object({ accounts: z.array(z.object({ id: z.string() })) })
      .parse(parsedJson(whoami.stdout));
    const deploymentBody = z.array(z.unknown()).parse(parsedJson(deployments.stdout));
    if (deploymentBody.length === 0) throw new Error("Recorded Worker does not exist");
    validateRemoteTargets(record, {
      accounts: whoamiBody.accounts,
      databases: z
        .array(z.object({ uuid: z.string(), name: z.string() }))
        .parse(parsedJson(d1.stdout)),
      namespaces: z
        .array(z.object({ id: z.string(), title: z.string() }))
        .parse(parsedJson(kv.stdout))
    });
    const listed = await command("npx", [
      "wrangler",
      "d1",
      "execute",
      record.databaseId,
      "--remote",
      "--json",
      ...common,
      "--command",
      "SELECT name FROM d1_migrations ORDER BY id"
    ]);
    if (listed.exitCode !== 0) throw new Error("Could not read installed migrations");
    const query = z
      .array(z.object({ results: z.array(z.object({ name: z.string() })) }))
      .parse(parsedJson(listed.stdout));
    const applied = query.flatMap((result) => result.results.map((row) => row.name));
    const pending = planMigrations(manifest, applied);
    const health = await fetch(`${record.origin}/health`, { redirect: "error" });
    const current =
      z.object({ version: z.string().optional() }).parse(await health.json()).version ??
      record.installedVersion;
    if (!health.ok) throw new Error("Current deployment health check failed");
    if (compareSemanticVersions(current, manifest.version) > 0)
      throw new Error(`Refusing to downgrade Wikimemory from ${current} to ${manifest.version}`);
    await confirmUpgrade(
      `\nWikimemory upgrade\n  Account: ${record.accountId}\n  Worker: ${record.workerName}\n  D1: ${record.databaseName} (${record.databaseId})\n  KV: ${record.kvName} (${record.kvId})\n  Origin: ${record.origin}\n  Version: ${current} -> ${manifest.version}\n  Migrations: ${pending.map((item) => item.name).join(", ") || "none"}`,
      options.yes
    );
    for (const migration of pending) {
      const bundlePath = join(temporary, migration.name);
      const sql = await readFile(join(PACKAGE_ROOT, "migrations", migration.name), "utf8");
      await writeFile(bundlePath, migrationBundle(sql, migration), "utf8");
      const result = await command("npx", [
        "wrangler",
        "d1",
        "execute",
        record.databaseId,
        "--remote",
        ...common,
        "--file",
        bundlePath
      ]);
      if (result.exitCode !== 0) throw new Error(`Migration failed: ${migration.name}`);
    }
    const deployed = await command("npx", ["wrangler", "deploy", "--strict", ...common]);
    if (deployed.exitCode !== 0) throw new Error("Worker deployment failed");
    await verifyRelease(record.origin, manifest);
    await writeDeploymentRecord({ ...record, installedVersion: manifest.version }, recordPath);
    console.log(`\nWikimemory ${manifest.version} is ready. Schema: ${manifest.schemaVersion}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
