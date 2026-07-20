#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { WIKIMEMORY_VERSION } from "../src/version.ts";
import { deploymentArguments, installArguments } from "./cli-options.ts";
import { deploymentPaths, requireInstalledDeployment } from "./deployment-record.ts";
import { packageRoot } from "./package-root.ts";
import { conciseError } from "./subprocess.ts";

const [command, ...args] = process.argv.slice(2);

function usage(): string {
  return `Wikimemory ${WIKIMEMORY_VERSION}\nPersonal, passkey-protected memory for Claude, Codex, and other MCP clients.\n\nUsage: wikimemory COMMAND [OPTIONS]\n\nStart a personal Cloudflare-hosted instance:\n  npx --yes wikimemory install\n\nTry it locally without a Cloudflare deployment:\n  npx --yes wikimemory dev\n\nCommands:\n  wikimemory install [--deployment NAME] [installer options]\n  wikimemory recover [--deployment NAME]\n  wikimemory dev [wrangler dev options]\n  wikimemory status [--deployment NAME]\n  wikimemory upgrade [--deployment NAME] [--yes]\n  wikimemory passkeys [--deployment NAME] list|add|revoke\n  wikimemory connect [--deployment NAME] codex|claude\n  wikimemory skills install codex|claude\n  wikimemory uninstall [--deployment NAME] [--apply]\n  wikimemory --version\n\nUse \`wikimemory COMMAND --help\` for command-specific options.`;
}

async function main(): Promise<void> {
  if (command === undefined || command === "--help" || command === "help") {
    console.log(usage());
    return;
  }
  if (command === "--version" || command === "version") {
    console.log(WIKIMEMORY_VERSION);
    return;
  }
  const root = packageRoot();
  if (command === "dev") {
    const { runDev } = await import("./dev.ts");
    await runDev(root, args);
    return;
  }
  if (command === "skills") {
    if (args[0] !== "install" || args.length !== 2)
      throw new Error("Usage: wikimemory skills install codex|claude");
    const { installSkills } = await import("./client-tools.ts");
    await installSkills(root, args[1]);
    return;
  }
  const parsed = deploymentArguments(args);
  const paths = deploymentPaths(parsed.deployment);
  const requiresInstalledDeployment =
    !parsed.remaining.includes("--help") &&
    (command === "recover" ||
      command === "status" ||
      command === "passkeys" ||
      command === "connect" ||
      command === "uninstall" ||
      (command === "upgrade" && !parsed.remaining.includes("--record")));
  if (requiresInstalledDeployment) {
    const requirement =
      command === "recover" || command === "passkeys" || command === "uninstall"
        ? "config"
        : "record";
    await requireInstalledDeployment(parsed.deployment, requirement);
  }
  if (command === "install" || command === "recover") {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    process.env["WIKIMEMORY_PACKAGE_ROOT"] = root;
    process.env["WIKIMEMORY_STATE_DIR"] = paths.directory;
    process.env["WIKIMEMORY_PACKAGED"] = "1";
    const { runSetup } = await import("./setup.ts");
    const setupArguments = installArguments(parsed.deployment, parsed.remaining);
    await runSetup(command === "recover" ? ["--recover", ...setupArguments] : setupArguments);
  } else if (command === "upgrade") {
    const { runUpgrade } = await import("./upgrade.ts");
    await runUpgrade(["--deployment", parsed.deployment, ...parsed.remaining]);
  } else if (command === "status") {
    if (parsed.remaining.length !== 0)
      throw new Error("Usage: wikimemory status [--deployment NAME]");
    const { runStatus } = await import("./status.ts");
    await runStatus(parsed.deployment);
  } else if (command === "passkeys") {
    process.env["WIKIMEMORY_STATE_DIR"] = paths.directory;
    process.env["WIKIMEMORY_PACKAGED"] = "1";
    const { runPasskeys } = await import("./passkeys.ts");
    await runPasskeys(parsed.remaining);
  } else if (command === "connect") {
    if (parsed.remaining.length !== 1)
      throw new Error("Usage: wikimemory connect [--deployment NAME] codex|claude");
    const { connectClient } = await import("./client-tools.ts");
    await connectClient(parsed.deployment, parsed.remaining[0]);
  } else if (command === "uninstall") {
    process.env["WIKIMEMORY_STATE_DIR"] = paths.directory;
    process.env["WIKIMEMORY_PACKAGED"] = "1";
    const { runUninstall } = await import("./uninstall.ts");
    await runUninstall(parsed.remaining);
  } else throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(`Wikimemory failed: ${conciseError(error)}`);
  process.exitCode = 1;
});
