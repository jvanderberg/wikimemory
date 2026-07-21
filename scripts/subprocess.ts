import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import spawn from "cross-spawn";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  input?: string;
  forwardLimitBytes?: number;
  inheritStdin?: boolean;
}

export function attachedTerminalSpawnOptions(): { stdio: "inherit" } {
  return { stdio: "inherit" };
}

interface ForwardState {
  remaining: number;
  suppressed: boolean;
}

export function boundedOutputChunk(
  chunk: string,
  remaining: number
): { visible: string; remaining: number; truncated: boolean } {
  const visible = chunk.slice(0, remaining);
  return {
    visible,
    remaining: Math.max(0, remaining - visible.length),
    truncated: visible.length < chunk.length
  };
}

function forwardBounded(destination: NodeJS.WriteStream, chunk: string, state: ForwardState): void {
  const limited = boundedOutputChunk(chunk, state.remaining);
  if (limited.visible !== "") destination.write(limited.visible);
  state.remaining = limited.remaining;
  if (limited.truncated && !state.suppressed) {
    destination.write("\n… additional command output suppressed.\n");
    state.suppressed = true;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [options.inheritStdin === true ? "inherit" : "pipe", "pipe", "pipe"]
    });
    if (child.stdout === null || child.stderr === null) {
      child.kill();
      reject(new Error("Subprocess output pipes were not created"));
      return;
    }
    let stdout = "";
    let stderr = "";
    const stdoutForward = { remaining: options.forwardLimitBytes ?? 0, suppressed: false };
    const stderrForward = { remaining: options.forwardLimitBytes ?? 0, suppressed: false };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.forwardLimitBytes !== undefined)
        forwardBounded(process.stdout, chunk, stdoutForward);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (options.forwardLimitBytes !== undefined)
        forwardBounded(process.stderr, chunk, stderrForward);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    if (child.stdin !== null)
      child.stdin.end(options.input === undefined ? undefined : `${options.input}\n`);
  });
}

export async function runAttachedCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, attachedTerminalSpawnOptions());
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout: "", stderr: "", exitCode: code ?? -1 });
    });
  });
}

export function conciseDiagnostic(result: CommandResult, maximumLength = 600): string {
  const raw = result.stderr.trim() || result.stdout.trim();
  const plain = stripVTControlCharacters(raw).replaceAll(/\s+/gu, " ").trim();
  if (plain === "") return `process exited with status ${result.exitCode}`;
  if (plain.length <= maximumLength) return plain;
  return `${plain.slice(0, Math.max(0, maximumLength - 3))}...`;
}

export function commandFailureMessage(operation: string, result: CommandResult): string {
  return `${operation} failed: ${conciseDiagnostic(result)}`;
}

export function conciseError(error: unknown, maximumLength = 600): string {
  const raw = error instanceof Error ? error.message : "Unknown error";
  const singleLine = stripVTControlCharacters(raw).replaceAll(/\s+/gu, " ").trim();
  if (singleLine.length <= maximumLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maximumLength - 3))}...`;
}
