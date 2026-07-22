import process from "node:process";
import { fileURLToPath } from "node:url";
import type { CommandOptions, CommandResult } from "./subprocess.ts";
import { runAttachedCommand, runCommand } from "./subprocess.ts";

export interface WranglerInvocation {
  command: string;
  args: string[];
}

export function wranglerCliPath(
  resolveModule: (specifier: string) => string = (specifier) => import.meta.resolve(specifier)
): string {
  const packageJson = resolveModule("wrangler/package.json");
  return fileURLToPath(new URL("bin/wrangler.js", packageJson));
}

export function wranglerInvocation(args: string[]): WranglerInvocation {
  return {
    command: process.execPath,
    args: [wranglerCliPath(), ...args]
  };
}

export async function runWrangler(
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const invocation = wranglerInvocation(args);
  return await runCommand(invocation.command, invocation.args, options);
}

export async function runAttachedWrangler(args: string[]): Promise<CommandResult> {
  const invocation = wranglerInvocation(args);
  return await runAttachedCommand(invocation.command, invocation.args);
}
