import { join } from "node:path";
import { deploymentRecordPath } from "./deployment-record.ts";

const packaged = process.env["WIKIMEMORY_PACKAGED"] === "1";
const stateRoot = process.env["WIKIMEMORY_STATE_DIR"] ?? ".";

export const packageRoot = process.env["WIKIMEMORY_PACKAGE_ROOT"] ?? ".";

export const setupRuntime = {
  packaged,
  executable: packaged ? "wikimemory install" : "npm run setup --",
  config: join(stateRoot, packaged ? "wrangler.jsonc" : "wrangler.production.jsonc"),
  progress: join(stateRoot, packaged ? "install-progress.json" : ".wikimemory-installer.json")
};

export const uninstallRuntime = {
  packaged,
  executable: packaged ? "wikimemory uninstall" : "npm run uninstall --",
  config: setupRuntime.config,
  installProgress: setupRuntime.progress,
  uninstallProgress: join(
    stateRoot,
    packaged ? "uninstall-progress.json" : ".wikimemory-uninstall.json"
  ),
  record: join(stateRoot, "deployment.json")
};

export const passkeyRuntime = {
  config: setupRuntime.config,
  client: join(stateRoot, packaged ? "passkey-client.json" : ".wikimemory-cli.json")
};

export function installedRecordPath(workerName: string): string {
  return packaged ? join(stateRoot, "deployment.json") : deploymentRecordPath(workerName);
}

export async function removePackagedDeploymentRecord(): Promise<void> {
  if (!packaged) return;
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(uninstallRuntime.record);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
