import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIKIMEMORY_VERSION } from "../src/version.ts";

interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  configHome?: string
): Promise<Result> {
  return await new Promise<Result>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: configHome === undefined ? process.env : { ...process.env, XDG_CONFIG_HOME: configHome },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function packageSmoke(): Promise<void> {
  const root = join(import.meta.dirname, "..");
  const temporary = await mkdtemp(join(tmpdir(), "wikimemory-package-smoke-"));
  try {
    const packed = await run("npm", ["pack", "--pack-destination", temporary], root);
    if (packed.exitCode !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const builtIndex = await readFile(join(root, "dist", "web", "index.html"), "utf8");
    if (!builtIndex.includes("<p>Loading…</p>"))
      throw new Error("Packed web application has no pre-React loading fallback");
    const tarballName = (await readdir(temporary)).find((name) => name.endsWith(".tgz"));
    if (tarballName === undefined) throw new Error("npm pack did not create a tarball");
    const tarball = join(temporary, tarballName);
    const working = join(temporary, "empty");
    const configHome = join(temporary, "config");
    await mkdir(working);
    await mkdir(configHome);
    const invoke = async (args: string[]): Promise<Result> =>
      await run("npx", ["--yes", "--package", tarball, "wikimemory", ...args], working, configHome);
    const version = await invoke(["--version"]);
    if (version.exitCode !== 0 || version.stdout.trim() !== WIKIMEMORY_VERSION)
      throw new Error(`Packed version command failed: ${version.stderr}`);
    for (const args of [
      ["--help"],
      ["install", "--deployment", "scratch", "--help"],
      ["uninstall", "--deployment", "scratch", "--help"]
    ]) {
      const result = await invoke(args);
      if (result.exitCode !== 0 || !result.stdout.includes("Usage:"))
        throw new Error(`Packed command failed (${args.join(" ")}): ${result.stderr}`);
      if (args[0] === "--help") {
        if (!result.stdout.includes("Personal, passkey-protected memory"))
          throw new Error("Packed help does not explain what Wikimemory is");
        if (
          !result.stdout.includes("npx wikimemory install") ||
          result.stdout.includes("npx --yes")
        )
          throw new Error("Packed help does not present the normal npx workflow");
      }
    }
    const missing = await invoke(["status"]);
    if (
      missing.exitCode === 0 ||
      !missing.stderr.includes("No deployment named") ||
      missing.stderr.includes("ENOENT")
    )
      throw new Error(`Packed missing-deployment guidance failed: ${missing.stderr}`);
    console.log(`Verified packed Wikimemory ${version.stdout.trim()} from an empty directory.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await packageSmoke();
