import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deploymentRecordPath, readDeploymentRecord } from "./deployment-record.ts";
import { commandFailureMessage, runCommand } from "./subprocess.ts";

type Client = "codex" | "claude";
const SKILL_NAMES = [
  "wikimemory-recall",
  "wikimemory-ingest",
  "wikimemory-lint",
  "wikimemory-install"
] as const;

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

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return Reflect.get(error, "code");
}

async function moveIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function replaceSkillDirectories(
  packageRoot: string,
  destinationRoot: string,
  names: readonly string[]
): Promise<void> {
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(join(destinationRoot, ".wikimemory-install-"));
  const incomingRoot = join(stagingRoot, "incoming");
  const replacedRoot = join(stagingRoot, "replaced");
  const installed: Array<{ destination: string; backup: string; hadExisting: boolean }> = [];
  try {
    await mkdir(incomingRoot);
    await mkdir(replacedRoot);
    for (const name of names) {
      if (!/^wikimemory-[a-z0-9-]+$/u.test(name)) throw new Error(`Invalid skill name: ${name}`);
      await cp(join(packageRoot, "skills", name), join(incomingRoot, name), {
        recursive: true,
        force: false,
        errorOnExist: true
      });
    }
    try {
      for (const name of names) {
        const destination = join(destinationRoot, name);
        const backup = join(replacedRoot, name);
        const hadExisting = await moveIfPresent(destination, backup);
        try {
          await rename(join(incomingRoot, name), destination);
        } catch (error) {
          if (hadExisting) await rename(backup, destination);
          throw error;
        }
        installed.push({ destination, backup, hadExisting });
      }
    } catch (error) {
      for (const item of installed.reverse()) {
        await rm(item.destination, { recursive: true, force: true });
        if (item.hadExisting) await rename(item.backup, item.destination);
      }
      throw error;
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
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
  await replaceSkillDirectories(packageRoot, destinationRoot, SKILL_NAMES);
  console.log(
    `Installed ${SKILL_NAMES.length} Wikimemory skills for ${target}. Restart the client.`
  );
}
