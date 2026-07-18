import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { bindingProperty, configValue } from "./setup.ts";

const CONFIG_PATH = "wrangler.production.jsonc";
const STATE_PATH = ".wikimemory-installer.json";
const UNINSTALL_STATE_PATH = ".wikimemory-uninstall.json";

export interface UninstallOptions {
  apply: boolean;
  confirmation: string | null;
  help: boolean;
}

export interface UninstallTargets {
  accountId: string;
  workerName: string;
  databaseName: string;
  databaseId: string;
  kvNamespaceId: string;
}

interface UninstallProgress {
  targets: UninstallTargets;
  workerDeleted: boolean;
  kvDeleted: boolean;
  databaseDeleted: boolean;
}

export function parseUninstallOptions(args: string[]): UninstallOptions {
  let apply = false;
  let confirmation: string | null = null;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") apply = true;
    else if (argument === "--help") help = true;
    else if (argument === "--confirm") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--confirm requires the exact Worker name");
      confirmation = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument ?? ""}`);
  }
  if (confirmation !== null && !apply) throw new Error("--confirm is valid only with --apply");
  return { apply, confirmation, help };
}

export function resolveUninstallTargets(config: string): UninstallTargets {
  const accountId = configValue(config, "account_id");
  const workerName = configValue(config, "name");
  const databaseName = bindingProperty(config, "DB", "database_name");
  const databaseId = bindingProperty(config, "DB", "database_id");
  const kvNamespaceId = bindingProperty(config, "OAUTH_KV", "id");
  if (accountId === null || workerName === null || databaseName === null || databaseId === null || kvNamespaceId === null) {
    throw new Error(`${CONFIG_PATH} does not identify one exact Worker, D1 database, and KV namespace`);
  }
  return { accountId, workerName, databaseName, databaseId, kvNamespaceId };
}

function summary(targets: UninstallTargets): string {
  return `Cloudflare uninstall targets:\n  Account ID: ${targets.accountId}\n  Worker: ${targets.workerName}\n  D1 database: ${targets.databaseName} (${targets.databaseId})\n  KV namespace ID: ${targets.kvNamespaceId}`;
}

async function run(args: string[]): Promise<void> {
  console.log(`\n> npx ${args.join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npx exited with status ${code ?? "unknown"}`));
    });
  });
}

async function requireExactName(workerName: string, supplied: string | null): Promise<void> {
  let answer = supplied;
  if (answer === null) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    answer = await prompt.question(`Type the Worker name ${workerName} to permanently delete all listed cloud resources: `);
    prompt.close();
  }
  if (answer !== workerName) throw new Error("Confirmation did not exactly match the Worker name");
}

async function loadProgress(targets: UninstallTargets): Promise<UninstallProgress> {
  try {
    const parsed: unknown = JSON.parse(await readFile(UNINSTALL_STATE_PATH, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("targets" in parsed) || !("workerDeleted" in parsed) || !("kvDeleted" in parsed) || !("databaseDeleted" in parsed)) {
      throw new Error("Invalid uninstall progress state");
    }
    const savedTargets = parsed.targets;
    if (typeof savedTargets !== "object" || savedTargets === null || JSON.stringify(savedTargets) !== JSON.stringify(targets)) {
      throw new Error("Uninstall progress does not match the current production config");
    }
    if (typeof parsed.workerDeleted !== "boolean" || typeof parsed.kvDeleted !== "boolean" || typeof parsed.databaseDeleted !== "boolean") {
      throw new Error("Invalid uninstall progress flags");
    }
    return { targets, workerDeleted: parsed.workerDeleted, kvDeleted: parsed.kvDeleted, databaseDeleted: parsed.databaseDeleted };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { targets, workerDeleted: false, kvDeleted: false, databaseDeleted: false };
    }
    throw error;
  }
}

async function saveProgress(progress: UninstallProgress): Promise<void> {
  await writeFile(UNINSTALL_STATE_PATH, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const options = parseUninstallOptions(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run uninstall                 # preview only\n       npm run uninstall -- --apply       # prompt for exact Worker name\n       npm run uninstall -- --apply --confirm WORKER_NAME");
    return;
  }
  const targets = resolveUninstallTargets(await readFile(CONFIG_PATH, "utf8"));
  console.log(`${summary(targets)}\n\nThis permanently deletes the remote memory database and cannot be undone.`);
  if (!options.apply) {
    console.log("\nPreview only. Rerun with --apply to perform this uninstall.");
    return;
  }
  await requireExactName(targets.workerName, options.confirmation);
  const progress = await loadProgress(targets);
  await saveProgress(progress);
  if (!progress.workerDeleted) {
    await run(["wrangler", "delete", targets.workerName, "--force", "--config", CONFIG_PATH]);
    progress.workerDeleted = true;
    await saveProgress(progress);
  }
  if (!progress.kvDeleted) {
    await run(["wrangler", "kv", "namespace", "delete", "--namespace-id", targets.kvNamespaceId, "--skip-confirmation", "--config", CONFIG_PATH]);
    progress.kvDeleted = true;
    await saveProgress(progress);
  }
  if (!progress.databaseDeleted) {
    await run(["wrangler", "d1", "delete", targets.databaseName, "--skip-confirmation", "--config", CONFIG_PATH]);
    progress.databaseDeleted = true;
    await saveProgress(progress);
  }
  await unlink(CONFIG_PATH);
  try {
    await unlink(STATE_PATH);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await unlink(UNINSTALL_STATE_PATH);
  console.log(`\nRemoved the Worker, KV namespace, D1 database, and local production config. The remote data is not recoverable.`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(`\nUninstall failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  });
}
