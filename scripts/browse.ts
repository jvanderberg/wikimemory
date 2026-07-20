import { spawn } from "node:child_process";
import process from "node:process";
import { deploymentRecordPath, readDeploymentRecord } from "./deployment-record.ts";

interface BrowserCommand {
  executable: string;
  args: string[];
}

export function webAppUrl(origin: string): string {
  return new URL("/", origin).toString();
}

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): BrowserCommand {
  if (platform === "darwin") return { executable: "open", args: [url] };
  if (platform === "win32")
    return { executable: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { executable: "xdg-open", args: [url] };
}

export function openBrowser(url: string): void {
  const invocation = browserCommand(url);
  const child = spawn(invocation.executable, invocation.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

export async function runBrowse(deployment: string): Promise<void> {
  const record = await readDeploymentRecord(deploymentRecordPath(deployment));
  const url = webAppUrl(record.origin);
  openBrowser(url);
  console.log(`Opened Wikimemory web app:\n${url}`);
}
