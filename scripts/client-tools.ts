import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deploymentRecordPath, readDeploymentRecord } from "./deployment-record.ts";
import { commandFailureMessage, runCommand } from "./subprocess.ts";

type Client = "codex" | "claude";

function client(value: string | undefined): Client {
  if (value === "codex" || value === "claude") return value;
  throw new Error("Client must be codex or claude");
}

async function run(command: string, args: string[], interactive = false): Promise<void> {
  const result = await runCommand(command, args, {
    ...(interactive ? { forwardLimitBytes: 4000, inheritStdin: true } : {})
  });
  if (result.exitCode !== 0)
    throw new Error(commandFailureMessage(`${command} client configuration`, result));
}

export async function connectClient(
  deployment: string,
  selected: string | undefined
): Promise<void> {
  const target = client(selected);
  const record = await readDeploymentRecord(deploymentRecordPath(deployment));
  const endpoint = `${record.origin}/mcp`;
  if (target === "codex") {
    await run("codex", ["mcp", "add", deployment, "--url", endpoint]);
    console.log("Complete authorization in your browser…");
    await run("codex", ["mcp", "login", deployment, "--scopes", "memory:read,memory:write"], true);
  } else {
    await run("claude", [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      deployment,
      endpoint
    ]);
    console.log("Complete authorization in your browser…");
    await run("claude", ["mcp", "login", deployment], true);
  }
  console.log(`Connected ${target} to ${deployment}.`);
}

export async function installSkills(
  packageRoot: string,
  selected: string | undefined
): Promise<void> {
  const target = client(selected);
  const destinationRoot = join(homedir(), target === "codex" ? ".codex" : ".claude", "skills");
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const names = ["wikimemory-recall", "wikimemory-ingest", "wikimemory-lint", "wikimemory-install"];
  for (const name of names) {
    await cp(join(packageRoot, "skills", name), join(destinationRoot, name), {
      recursive: true,
      force: true
    });
  }
  console.log(`Installed ${names.length} Wikimemory skills for ${target}. Restart the client.`);
}
