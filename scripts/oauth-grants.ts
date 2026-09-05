import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type CommandResult, commandFailureMessage } from "./subprocess.ts";
import { runWrangler } from "./wrangler.ts";

const GRANT_PREFIX = "grant:";
const CLIENT_PREFIX = "client:";
const KEY_LIST_SCHEMA = z.array(
  z.object({ name: z.string(), expiration: z.number().int().optional() })
);
const RECORD_SCHEMA = z.record(z.string(), z.unknown());

export type WranglerRunner = (args: string[]) => Promise<CommandResult>;

export type StoredKey = z.infer<typeof KEY_LIST_SCHEMA>[number];

export interface KeptRecords {
  grants: number;
  clients: number;
}

/**
 * Returns the JSON to store so that an OAuth grant or dynamically registered
 * client lasts until revocation, or null when the record already does. Grants
 * carry their expiry inside the value as well as on the KV key; clients only on
 * the key.
 */
export function persistentRecord(key: StoredKey, value: string): string | null {
  const parsed = RECORD_SCHEMA.safeParse(JSON.parse(value));
  if (!parsed.success) throw new Error(`Unrecognized OAuth record: ${key.name}`);
  const record = { ...parsed.data };
  const grant = key.name.startsWith(GRANT_PREFIX);
  const timedValue = grant && record["expiresAt"] !== undefined;
  if (!timedValue && key.expiration === undefined) return null;
  if (grant) delete record["expiresAt"];
  return JSON.stringify(record);
}

export function parseStoredKeys(stdout: string): StoredKey[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end < start) throw new Error("Wrangler did not return a KV key list");
  return KEY_LIST_SCHEMA.parse(JSON.parse(stdout.slice(start, end + 1)));
}

function storedValue(stdout: string): string {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("Wrangler did not return a KV record");
  return stdout.slice(start, end + 1);
}

async function wrangler(run: WranglerRunner, operation: string, args: string[]): Promise<string> {
  const result = await run(args);
  if (result.exitCode !== 0) throw new Error(commandFailureMessage(operation, result));
  return result.stdout;
}

/**
 * Rewrites every existing MCP grant and dynamically registered client in the
 * production OAuth namespace without a time-based expiry. Records created before
 * Wikimemory dropped the 30-day refresh-grant and 90-day client timers keep the
 * expiry they were stored with; this makes them last until revocation instead.
 */
export async function keepOAuthGrants(
  common: string[],
  run: WranglerRunner = runWrangler
): Promise<KeptRecords> {
  const kept: KeptRecords = { grants: 0, clients: 0 };
  const namespace = ["--binding", "OAUTH_KV", "--remote", ...common];
  const temporary = await mkdtemp(join(tmpdir(), "wikimemory-oauth-"));
  try {
    for (const prefix of [GRANT_PREFIX, CLIENT_PREFIX]) {
      const keys = parseStoredKeys(
        await wrangler(run, "OAuth record listing", [
          "kv",
          "key",
          "list",
          "--prefix",
          prefix,
          ...namespace
        ])
      );
      for (const [index, key] of keys.entries()) {
        if (prefix === CLIENT_PREFIX && key.expiration === undefined) continue;
        const value = storedValue(
          await wrangler(run, "OAuth record read", [
            "kv",
            "key",
            "get",
            key.name,
            "--text",
            ...namespace
          ])
        );
        const persistent = persistentRecord(key, value);
        if (persistent === null) continue;
        const path = join(temporary, `${prefix.slice(0, -1)}-${index}.json`);
        await writeFile(path, persistent, "utf8");
        await wrangler(run, "OAuth record update", [
          "kv",
          "key",
          "put",
          key.name,
          "--path",
          path,
          ...namespace
        ]);
        if (prefix === GRANT_PREFIX) kept.grants += 1;
        else kept.clients += 1;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return kept;
}

export function keptSummary(kept: KeptRecords): string {
  if (kept.grants === 0 && kept.clients === 0)
    return "Existing MCP connections already last until revocation.";
  return `Kept ${kept.grants} MCP connection${kept.grants === 1 ? "" : "s"} and ${kept.clients} client registration${kept.clients === 1 ? "" : "s"} until revocation.`;
}
