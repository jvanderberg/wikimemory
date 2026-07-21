import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import spawn from "cross-spawn";
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
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      reject(new Error("Package smoke subprocess output pipes were not created"));
      return;
    }
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
    const unpacked = await run("tar", ["-xzf", tarball, "-C", temporary], root);
    if (unpacked.exitCode !== 0)
      throw new Error(`Packed archive extraction failed: ${unpacked.stderr}`);
    const packedRoot = join(temporary, "package");
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"), directoryLinkType);
    const installedSkills = join(temporary, "installed-skills");
    const developmentSkill = join(temporary, "development-skill");
    await mkdir(installedSkills);
    await mkdir(developmentSkill);
    await writeFile(join(developmentSkill, "SKILL.md"), "development\n");
    await symlink(developmentSkill, join(installedSkills, "wikimemory-recall"), directoryLinkType);
    const installScript = `import { replaceSkillDirectories } from ${JSON.stringify(
      pathToFileURL(join(packedRoot, "dist", "npm-cli", "scripts", "client-tools.js")).href
    )}; await replaceSkillDirectories(${JSON.stringify(packedRoot)}, ${JSON.stringify(
      installedSkills
    )}, ["wikimemory-recall"]);`;
    const installed = await run("node", ["--input-type=module", "--eval", installScript], root);
    if (installed.exitCode !== 0)
      throw new Error(`Packed skill replacement failed: ${installed.stderr}`);
    const installedRecall = join(installedSkills, "wikimemory-recall");
    if ((await lstat(installedRecall)).isSymbolicLink())
      throw new Error("Packed skill installer retained the previous development symlink");
    if (!(await readFile(join(installedRecall, "SKILL.md"), "utf8")).includes("wikimemory-recall"))
      throw new Error("Packed skill installer did not install the release skill");
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
      ["browse", "--help"],
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
