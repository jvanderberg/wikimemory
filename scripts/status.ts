import { z } from "zod";
import { deploymentRecordPath, readDeploymentRecord } from "./deployment-record.ts";
import { isReactApplicationShell } from "./web-shell.ts";

const HEALTH_SCHEMA = z.object({
  status: z.literal("ok"),
  service: z.literal("wikimemory"),
  version: z.string()
});
const READY_SCHEMA = z.object({
  status: z.literal("ready"),
  service: z.literal("wikimemory"),
  version: z.string(),
  schemaVersion: z.string()
});
const DISCOVERY_SCHEMA = z.object({ resource: z.url() });

export interface StatusResult {
  deployment: string;
  accountId: string;
  workerName: string;
  database: string;
  kvNamespace: string;
  origin: string;
  recordedVersion: string;
  runningVersion: string;
  schemaVersion: string;
}

export async function deploymentStatus(deployment: string): Promise<StatusResult> {
  const record = await readDeploymentRecord(deploymentRecordPath(deployment));
  const [healthResponse, readyResponse, discoveryResponse, appResponse] = await Promise.all([
    fetch(`${record.origin}/health`, { redirect: "error" }),
    fetch(`${record.origin}/ready`, { redirect: "error" }),
    fetch(`${record.origin}/.well-known/oauth-protected-resource/mcp`, { redirect: "error" }),
    fetch(`${record.origin}/app`, { redirect: "error" })
  ]);
  if (!healthResponse.ok || !readyResponse.ok || !discoveryResponse.ok || !appResponse.ok)
    throw new Error("One or more Wikimemory deployment checks failed");
  const health = HEALTH_SCHEMA.parse(await healthResponse.json());
  const ready = READY_SCHEMA.parse(await readyResponse.json());
  const discovery = DISCOVERY_SCHEMA.parse(await discoveryResponse.json());
  if (health.version !== ready.version) throw new Error("Health and schema versions disagree");
  if (discovery.resource !== `${record.origin}/mcp`)
    throw new Error("OAuth discovery reports an unexpected MCP resource");
  if (!isReactApplicationShell(await appResponse.text()))
    throw new Error("React application shell verification failed");
  return {
    deployment,
    accountId: record.accountId,
    workerName: record.workerName,
    database: `${record.databaseName} (${record.databaseId})`,
    kvNamespace: `${record.kvName} (${record.kvId})`,
    origin: record.origin,
    recordedVersion: record.installedVersion,
    runningVersion: health.version,
    schemaVersion: ready.schemaVersion
  };
}

export async function runStatus(deployment: string): Promise<void> {
  const status = await deploymentStatus(deployment);
  console.log(statusSummary(status));
}

export function statusSummary(status: StatusResult): string {
  const webApp = new URL("/", status.origin).toString();
  const mcpEndpoint = new URL("/mcp", status.origin).toString();
  const mismatch =
    status.recordedVersion === status.runningVersion
      ? ""
      : `\nLocal record: ${status.recordedVersion} (run wikimemory upgrade to reconcile)`;
  return `Wikimemory ${status.deployment}: ready\nWeb app: ${webApp}\nMCP endpoint: ${mcpEndpoint}\nVersion: ${status.runningVersion}\nDatabase: up to date.${mismatch}`;
}
