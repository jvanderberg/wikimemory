import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const DEPLOYMENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export const DEPLOYMENT_RECORD_SCHEMA = z
  .object({
    formatVersion: z.literal(1),
    accountId: z.string().min(1),
    workerName: z.string().regex(DEPLOYMENT_NAME),
    databaseName: z.string().min(1),
    databaseId: z.string().min(1),
    kvName: z.string().min(1),
    kvId: z.string().min(1),
    origin: z.url().refine((value) => value.startsWith("https://")),
    installedVersion: z.string().regex(/^\d+\.\d+\.\d+$/u)
  })
  .strict();

export type DeploymentRecord = z.infer<typeof DEPLOYMENT_RECORD_SCHEMA>;

export interface DeploymentPaths {
  directory: string;
  record: string;
  config: string;
  installProgress: string;
  uninstallProgress: string;
  passkeyClient: string;
}

const PRODUCTION_CONFIG_SCHEMA = z.object({
  name: z.string(),
  account_id: z.string(),
  vars: z.object({ APP_BASE_URL: z.url() }),
  d1_databases: z.array(
    z.object({
      binding: z.literal("DB"),
      database_name: z.string(),
      database_id: z.string()
    })
  ),
  kv_namespaces: z.array(z.object({ binding: z.literal("OAUTH_KV"), id: z.string() }))
});

export function deploymentRecordPath(deployment = "wikimemory"): string {
  return deploymentPaths(deployment).record;
}

export function deploymentPaths(deployment = "wikimemory"): DeploymentPaths {
  if (!DEPLOYMENT_NAME.test(deployment)) throw new Error("Invalid deployment name");
  const configRoot = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  const directory = join(configRoot, "wikimemory", "deployments", deployment);
  return {
    directory,
    record: join(directory, "deployment.json"),
    config: join(directory, "wrangler.jsonc"),
    installProgress: join(directory, "install-progress.json"),
    uninstallProgress: join(directory, "uninstall-progress.json"),
    passkeyClient: join(directory, "passkey-client.json")
  };
}

export async function requireInstalledDeployment(
  deployment: string,
  requirement: "record" | "config" = "record"
): Promise<void> {
  const requestedPaths = deploymentPaths(deployment);
  const requested = requirement === "record" ? requestedPaths.record : requestedPaths.config;
  try {
    await access(requested);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const configRoot = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  const deploymentsRoot = join(configRoot, "wikimemory", "deployments");
  let installed: string[] = [];
  try {
    const entries = (await readdir(deploymentsRoot, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && DEPLOYMENT_NAME.test(entry.name)
    );
    const candidates = await Promise.all(
      entries.map(async (entry): Promise<string | null> => {
        try {
          await access(join(deploymentsRoot, entry.name, "deployment.json"));
          return entry.name;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      })
    );
    installed = candidates.filter((name): name is string => name !== null).sort();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (installed.length === 0)
    throw new Error(`No deployment named “${deployment}”. Run wikimemory install first.`);
  throw new Error(
    `No deployment named “${deployment}”. Installed: ${installed.join(", ")}. Use --deployment NAME.`
  );
}

export function deploymentRecordFromConfig(
  configText: string,
  installedVersion: string,
  kvName: string
): DeploymentRecord {
  const config = PRODUCTION_CONFIG_SCHEMA.parse(JSON.parse(configText));
  const database = config.d1_databases.at(0);
  const namespace = config.kv_namespaces.at(0);
  if (database === undefined || namespace === undefined)
    throw new Error("Production config is missing Wikimemory storage bindings");
  return DEPLOYMENT_RECORD_SCHEMA.parse({
    formatVersion: 1,
    accountId: config.account_id,
    workerName: config.name,
    databaseName: database.database_name,
    databaseId: database.database_id,
    kvName,
    kvId: namespace.id,
    origin: config.vars.APP_BASE_URL,
    installedVersion
  });
}

export async function readDeploymentRecord(path: string): Promise<DeploymentRecord> {
  return DEPLOYMENT_RECORD_SCHEMA.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeDeploymentRecord(
  record: DeploymentRecord,
  path = deploymentRecordPath(record.workerName)
): Promise<void> {
  const valid = DEPLOYMENT_RECORD_SCHEMA.parse(record);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
