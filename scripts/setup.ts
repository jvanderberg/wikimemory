import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const CONFIG_PATH = "wrangler.production.jsonc";
const STATE_PATH = ".wikimemory-installer.json";
const BOOTSTRAP_ORIGIN = "https://bootstrap.invalid";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const WHOAMI_SCHEMA = z.discriminatedUnion("loggedIn", [
  z.object({ loggedIn: z.literal(false) }),
  z.object({
    loggedIn: z.literal(true),
    email: z.string().nullable().optional(),
    accounts: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
  })
]);
const STATE_SCHEMA = z.object({
  preflightComplete: z.literal(true),
  accountId: z.string(),
  workerName: z.string(),
  databaseName: z.string(),
  kvName: z.string()
});
const D1_QUERY_SCHEMA = z.array(z.object({ results: z.array(z.object({ name: z.string() })) }));

export interface Options {
  recover: boolean;
  resume: boolean;
  yes: boolean;
  help: boolean;
  workerName: string;
  databaseName: string;
  kvName: string;
  accountId: string | null;
}

interface Account {
  id: string;
  name: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function parseOptions(args: string[]): Options {
  let recover = false;
  let resume = false;
  let yes = false;
  let help = false;
  let workerName = "wikimemory";
  let databaseName = "wikimemory";
  let kvName = "wikimemory-oauth";
  let accountId: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--recover") recover = true;
    else if (argument === "--resume") resume = true;
    else if (argument === "--yes") yes = true;
    else if (argument === "--help") help = true;
    else if (argument === "--worker-name" || argument === "--database-name" || argument === "--kv-name" || argument === "--account-id") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--account-id") accountId = value;
      else {
        if (!NAME_PATTERN.test(value)) throw new Error(`${argument} must contain only lowercase letters, digits, and hyphens`);
        if (argument === "--worker-name") workerName = value;
        else if (argument === "--database-name") databaseName = value;
        else kvName = value;
      }
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument ?? ""}`);
    }
  }
  if (recover && resume) throw new Error("--recover and --resume cannot be combined");
  return { recover, resume, yes, help, workerName, databaseName, kvName, accountId };
}

function usage(): string {
  return "Usage: npm run setup -- [--account-id ID] [--yes] [--worker-name NAME] [--database-name NAME] [--kv-name NAME]\n       npm run setup -- --resume [--yes]\n       npm run setup -- --recover [--yes]";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command: string, args: string[], input?: string, allowFailure = false): Promise<CommandResult> {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(input === undefined ? undefined : `${input}\n`);
  });
  if (result.exitCode !== 0 && !allowFailure) throw new Error(`${command} exited with status ${result.exitCode}`);
  return result;
}

async function runInteractive(command: string, args: string[]): Promise<void> {
  console.log(`\n> ${command} ${args.join(" ")}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
    });
  });
}

export function initialConfig(options: Options, account: Account): string {
  return `${JSON.stringify({
    $schema: "node_modules/wrangler/config-schema.json",
    name: options.workerName,
    account_id: account.id,
    main: "src/index.ts",
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    vars: { APP_ENV: "production", APP_BASE_URL: BOOTSTRAP_ORIGIN }
  }, null, 2)}\n`;
}

export function deployedOrigin(output: string): string | null {
  const match = output.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/u);
  return match?.[0] ?? null;
}

export function configuredOrigin(config: string): string | null {
  const match = config.match(/"APP_BASE_URL"\s*:\s*"(https:\/\/[^"/]+)"/u);
  return match?.[1] ?? null;
}

export function configValue(config: string, key: string): string | null {
  const match = config.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "u"));
  return match?.[1] ?? null;
}

function hasBinding(config: string, binding: "DB" | "OAUTH_KV"): boolean {
  return new RegExp(`"binding"\\s*:\\s*"${binding}"`, "u").test(config);
}

export function bindingProperty(config: string, binding: "DB" | "OAUTH_KV", property: string): string | null {
  const objects = config.match(/\{[^{}]*\}/gu) ?? [];
  const object = objects.find((candidate) => new RegExp(`"binding"\\s*:\\s*"${binding}"`, "u").test(candidate));
  return object === undefined ? null : configValue(object, property);
}

export function migrationBundle(sql: string, migrationName: string): string {
  const escapedName = migrationName.replaceAll("'", "''");
  return `${sql.trimEnd()}\n\nINSERT INTO d1_migrations(name) VALUES ('${escapedName}');\n`;
}

export async function applyRemoteMigrations(databaseName: string): Promise<void> {
  await run("npx", ["wrangler", "d1", "execute", databaseName, "--remote", "--config", CONFIG_PATH, "--command", "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"]);
  const listed = await run("npx", ["wrangler", "d1", "execute", databaseName, "--remote", "--config", CONFIG_PATH, "--json", "--command", "SELECT name FROM d1_migrations ORDER BY id"]);
  const applied = new Set(D1_QUERY_SCHEMA.parse(JSON.parse(listed.stdout)).flatMap((result) => result.results.map((row) => row.name)));
  const migrations = (await readdir("migrations")).filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
  for (const migration of migrations) {
    if (applied.has(migration)) continue;
    const temporary = await mkdtemp(join(tmpdir(), "wikimemory-d1-migration-"));
    if (!temporary.startsWith(`${tmpdir()}/wikimemory-d1-migration-`)) throw new Error("Unexpected migration temporary path");
    try {
      const bundlePath = join(temporary, migration);
      await writeFile(bundlePath, migrationBundle(await readFile(join("migrations", migration), "utf8"), migration), "utf8");
      await run("npx", ["wrangler", "d1", "execute", databaseName, "--remote", "--config", CONFIG_PATH, "--file", bundlePath]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function question(text: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(text);
  prompt.close();
  return answer;
}

async function confirm(text: string, automatic: boolean): Promise<void> {
  if (automatic) return;
  const answer = (await question(`${text} [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new Error("Cancelled");
}

async function selectAccount(options: Options): Promise<{ account: Account; identity: string }> {
  const result = await run("npx", ["wrangler", "whoami", "--json"], undefined, true);
  let whoami: z.infer<typeof WHOAMI_SCHEMA>;
  try {
    whoami = WHOAMI_SCHEMA.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error("Wrangler authentication could not be determined. Run npx wrangler login first.");
  }
  if (!whoami.loggedIn) throw new Error("Wrangler is not authenticated. Run npx wrangler login first.");
  if (result.exitCode !== 0) throw new Error("Wrangler could not read the authenticated Cloudflare identity.");
  if (whoami.accounts.length === 0) throw new Error("The authenticated Cloudflare identity has no accounts.");
  let account: Account | undefined;
  if (options.accountId !== null) account = whoami.accounts.find((candidate) => candidate.id === options.accountId);
  else if (whoami.accounts.length === 1) account = whoami.accounts[0];
  else if (options.yes) throw new Error("Multiple Cloudflare accounts are available; pass --account-id with the intended account ID.");
  else {
    console.log("\nCloudflare accounts:");
    whoami.accounts.forEach((candidate, index) => {
      console.log(`  ${index + 1}. ${candidate.name} (${candidate.id})`);
    });
    const selected = Number.parseInt(await question("Select an account number: "), 10);
    account = whoami.accounts[selected - 1];
  }
  if (account === undefined) throw new Error("The requested Cloudflare account was not found.");
  return { account, identity: whoami.email ?? "authenticated token" };
}

function bootstrapSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  return { raw, hash };
}

async function verifyEndpoint(origin: string, path: "/health" | "/ready", expectedStatus: "ok" | "ready"): Promise<void> {
  const response = await fetch(`${origin}${path}`, { redirect: "error" });
  if (!response.ok) throw new Error(`Deployment ${path} check failed with HTTP ${response.status}`);
  const parsed = z.object({ status: z.literal(expectedStatus), service: z.literal("wikimemory") }).safeParse(await response.json());
  if (!parsed.success) throw new Error(`Deployment ${path} returned an unexpected response.`);
}

export function handoff(origin: string, rawToken: string): string {
  const endpoint = `${origin}/mcp`;
  return `Wikimemory is ready for owner setup.\n\nOpen this one-time URL on a device that can create a passkey:\n${origin}/setup#${encodeURIComponent(rawToken)}\n\nAfter setup, connect clients with:\n  codex mcp add wikimemory --url ${endpoint}\n  codex mcp login wikimemory --scopes memory:read,memory:write\n  claude mcp add --transport http --scope user wikimemory ${endpoint}\n\nThe setup token was not written to disk. This is the only time it will be printed.`;
}

async function remoteWorkerExists(workerName: string): Promise<boolean> {
  const result = await run("npx", ["wrangler", "deployments", "list", "--name", workerName, "--json", "--config", CONFIG_PATH], undefined, true);
  return deploymentListIndicatesExisting(result);
}

export function deploymentListIndicatesExisting(result: CommandResult): boolean {
  if (result.exitCode === 0) {
    const parsed = z.array(z.unknown()).safeParse(JSON.parse(result.stdout));
    if (!parsed.success) throw new Error("Wrangler returned an unexpected deployment-list response.");
    return true;
  }
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (diagnostic.includes("code: 10007") || diagnostic.includes("code: 10090")) return false;
  throw new Error("Could not verify whether the target Worker already exists.");
}

export function workersDevRegistrationRequired(result: CommandResult): boolean {
  const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return diagnostic.includes("register a workers.dev subdomain") ||
    diagnostic.includes("workers/onboarding");
}

async function existingResourceNames(): Promise<{ databases: Set<string>; namespaces: Set<string> }> {
  const [d1, kv] = await Promise.all([
    run("npx", ["wrangler", "d1", "list", "--json", "--config", CONFIG_PATH]),
    run("npx", ["wrangler", "kv", "namespace", "list", "--config", CONFIG_PATH])
  ]);
  const databases = z.array(z.looseObject({ name: z.string() })).parse(JSON.parse(d1.stdout));
  const namespaces = z.array(z.looseObject({ title: z.string() })).parse(JSON.parse(kv.stdout));
  return {
    databases: new Set(databases.map((database) => database.name)),
    namespaces: new Set(namespaces.map((namespace) => namespace.title))
  };
}

async function ensureResources(options: Options): Promise<void> {
  let config = await readFile(CONFIG_PATH, "utf8");
  if (!hasBinding(config, "DB")) {
    await run("npx", ["wrangler", "d1", "create", options.databaseName, "--update-config", "--binding", "DB", "--config", CONFIG_PATH]);
    config = await readFile(CONFIG_PATH, "utf8");
  }
  if (!hasBinding(config, "OAUTH_KV")) {
    await run("npx", ["wrangler", "kv", "namespace", "create", options.kvName, "--update-config", "--binding", "OAUTH_KV", "--config", CONFIG_PATH]);
  }
}

async function finalizeDeployment(options: Options): Promise<void> {
  let config = await readFile(CONFIG_PATH, "utf8");
  let origin = configuredOrigin(config);
  if (origin === null) throw new Error(`${CONFIG_PATH} has no valid APP_BASE_URL.`);
  if (origin === BOOTSTRAP_ORIGIN) {
    const deployArgs = ["wrangler", "deploy", "--strict", "--config", CONFIG_PATH];
    let firstDeploy = await run("npx", deployArgs, undefined, true);
    if (firstDeploy.exitCode !== 0 && workersDevRegistrationRequired(firstDeploy)) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("This Cloudflare account needs a workers.dev subdomain before its first Worker can be deployed. Rerun setup in an interactive terminal so Wrangler can register it.");
      }
      console.log("\nCloudflare needs a one-time account subdomain. Continuing interactively with Wrangler; choose an available workers.dev name when prompted.");
      await runInteractive("npx", deployArgs);
      firstDeploy = await run("npx", deployArgs, undefined, true);
    }
    if (firstDeploy.exitCode !== 0) {
      throw new Error(`npx exited with status ${firstDeploy.exitCode}`);
    }
    origin = deployedOrigin(`${firstDeploy.stdout}\n${firstDeploy.stderr}`);
    if (origin === null) throw new Error(`Could not discover the workers.dev URL. Put the exact origin in APP_BASE_URL inside ${CONFIG_PATH}, then rerun with --resume.`);
    config = await readFile(CONFIG_PATH, "utf8");
    if (!config.includes(BOOTSTRAP_ORIGIN)) throw new Error(`Could not safely update APP_BASE_URL in ${CONFIG_PATH}.`);
    await writeFile(CONFIG_PATH, config.replace(BOOTSTRAP_ORIGIN, origin), "utf8");
  }
  await ensureResources(options);
  config = await readFile(CONFIG_PATH, "utf8");
  const boundDatabaseName = bindingProperty(config, "DB", "database_name");
  if (boundDatabaseName === null) throw new Error(`${CONFIG_PATH} has a DB binding without a database_name.`);
  await applyRemoteMigrations(boundDatabaseName);
  const secret = bootstrapSecret();
  await run("npx", ["wrangler", "deploy", "--strict", "--config", CONFIG_PATH]);
  await run("npx", ["wrangler", "secret", "put", "SETUP_TOKEN_HASH", "--config", CONFIG_PATH], secret.hash);
  await verifyEndpoint(origin, "/health", "ok");
  await verifyEndpoint(origin, "/ready", "ready");
  console.log(`\n${handoff(origin, secret.raw)}`);
}

async function freshDeployment(options: Options): Promise<void> {
  if (await exists(CONFIG_PATH)) throw new Error(`${CONFIG_PATH} already exists. Use --resume to finish provisioning or --recover to add a passkey.`);
  const selected = await selectAccount(options);
  console.log(`\nPlanned Cloudflare resources:\n  Account: ${selected.account.name} (${selected.account.id})\n  Worker: ${options.workerName}\n  D1 database: ${options.databaseName}\n  KV namespace: ${options.kvName}\n  Identity: ${selected.identity}`);
  await confirm("Create these resources and deploy Wikimemory?", options.yes);
  await writeFile(CONFIG_PATH, initialConfig(options, selected.account), { encoding: "utf8", flag: "wx" });
  let workerExists: boolean;
  let resources: { databases: Set<string>; namespaces: Set<string> };
  try {
    [workerExists, resources] = await Promise.all([
      remoteWorkerExists(options.workerName),
      existingResourceNames()
    ]);
  } catch (error) {
    await unlink(CONFIG_PATH);
    throw error;
  }
  const collisions = [
    ...(workerExists ? [`Worker ${options.workerName}`] : []),
    ...(resources.databases.has(options.databaseName) ? [`D1 database ${options.databaseName}`] : []),
    ...(resources.namespaces.has(options.kvName) ? [`KV namespace ${options.kvName}`] : [])
  ];
  if (collisions.length > 0) {
    await unlink(CONFIG_PATH);
    throw new Error(`These remote names already exist: ${collisions.join(", ")}. No resources were created or changed; choose unused names.`);
  }
  await writeFile(STATE_PATH, `${JSON.stringify({
    preflightComplete: true,
    accountId: selected.account.id,
    workerName: options.workerName,
    databaseName: options.databaseName,
    kvName: options.kvName
  } satisfies z.infer<typeof STATE_SCHEMA>, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(`\nCreated ${CONFIG_PATH}. It is ignored by git. If a later step fails, rerun with --resume.`);
  await finalizeDeployment(options);
}

async function resumeDeployment(options: Options): Promise<void> {
  if (!(await exists(CONFIG_PATH))) throw new Error(`${CONFIG_PATH} is required for --resume.`);
  if (!(await exists(STATE_PATH))) throw new Error(`${STATE_PATH} is missing, so successful collision preflight cannot be proven. Remove ${CONFIG_PATH} and start a fresh install.`);
  const config = await readFile(CONFIG_PATH, "utf8");
  const state = STATE_SCHEMA.parse(JSON.parse(await readFile(STATE_PATH, "utf8")));
  const accountId = configValue(config, "account_id");
  const workerName = configValue(config, "name");
  if (accountId === null || workerName === null) throw new Error(`${CONFIG_PATH} is missing account_id or name.`);
  if (accountId !== state.accountId || workerName !== state.workerName) throw new Error("Production config no longer matches the collision-checked installer state.");
  const resumedOptions = { ...options, databaseName: state.databaseName, kvName: state.kvName, workerName: state.workerName };
  console.log(`\nResume target:\n  Account ID: ${accountId}\n  Worker: ${workerName}\n  D1 database: ${state.databaseName}\n  KV namespace: ${state.kvName}`);
  await confirm("Resume provisioning and rotate the one-time setup credential?", options.yes);
  await finalizeDeployment(resumedOptions);
}

async function recover(options: Options): Promise<void> {
  if (!(await exists(CONFIG_PATH))) throw new Error(`${CONFIG_PATH} is required for recovery.`);
  const config = await readFile(CONFIG_PATH, "utf8");
  const origin = configuredOrigin(config);
  if (origin === null || origin === BOOTSTRAP_ORIGIN) throw new Error(`${CONFIG_PATH} does not contain a deployed APP_BASE_URL; use --resume first.`);
  await confirm(`Rotate the one-time owner setup credential for ${origin}?`, options.yes);
  const secret = bootstrapSecret();
  await run("npx", ["wrangler", "secret", "put", "SETUP_TOKEN_HASH", "--config", CONFIG_PATH], secret.hash);
  await verifyEndpoint(origin, "/health", "ok");
  await verifyEndpoint(origin, "/ready", "ready");
  console.log(`\n${handoff(origin, secret.raw)}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.recover) await recover(options);
  else if (options.resume) await resumeDeployment(options);
  else await freshDeployment(options);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(`\nSetup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  });
}
