import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { keepOAuthGrants, keptSummary, parseStoredKeys, persistentRecord } from "./oauth-grants.ts";
import type { CommandResult } from "./subprocess.ts";

function result(stdout: string, exitCode = 0): CommandResult {
  return { exitCode, stdout, stderr: "", signal: null } as CommandResult;
}

await describe("keeping OAuth grants until revocation", async () => {
  await it("strips value and key expiries only where they exist", () => {
    assert.equal(
      persistentRecord(
        { name: "grant:owner:g1", expiration: 1_800_000_000 },
        JSON.stringify({ id: "g1", expiresAt: 1_800_000_000, refreshTokenId: "r1" })
      ),
      JSON.stringify({ id: "g1", refreshTokenId: "r1" })
    );
    assert.equal(
      persistentRecord({ name: "grant:owner:g2" }, JSON.stringify({ id: "g2", expiresAt: 1 })),
      JSON.stringify({ id: "g2" })
    );
    assert.equal(persistentRecord({ name: "grant:owner:g3" }, JSON.stringify({ id: "g3" })), null);
    assert.equal(
      persistentRecord(
        { name: "client:c1", expiration: 1_800_000_000 },
        JSON.stringify({ clientId: "c1", registrationDate: 5 })
      ),
      JSON.stringify({ clientId: "c1", registrationDate: 5 })
    );
    assert.equal(persistentRecord({ name: "client:c2" }, JSON.stringify({ clientId: "c2" })), null);
    assert.throws(() => persistentRecord({ name: "grant:owner:bad" }, "[1]"), /Unrecognized/u);
  });

  await it("tolerates Wrangler chatter around the key listing", () => {
    assert.deepEqual(
      parseStoredKeys('\n ⛅️ wrangler\n[{"name":"grant:a","expiration":7},{"name":"grant:b"}]\n'),
      [{ name: "grant:a", expiration: 7 }, { name: "grant:b" }]
    );
    assert.throws(() => parseStoredKeys("no keys"), /key list/u);
  });

  await it("rewrites only timed records and reports the counts", async () => {
    const stored = new Map<string, { value: string; expiration?: number }>([
      [
        "grant:owner:timed",
        { value: JSON.stringify({ id: "timed", expiresAt: 9 }), expiration: 9 }
      ],
      ["grant:owner:kept", { value: JSON.stringify({ id: "kept" }) }],
      ["client:timed", { value: JSON.stringify({ clientId: "timed" }), expiration: 9 }],
      ["client:kept", { value: JSON.stringify({ clientId: "kept" }) }]
    ]);
    const puts: string[] = [];
    const run = async (args: string[]): Promise<CommandResult> => {
      assert.deepEqual(args.slice(-5), [
        "--binding",
        "OAUTH_KV",
        "--remote",
        "--config",
        "w.jsonc"
      ]);
      if (args[2] === "list") {
        const prefix = args[4] ?? "";
        return result(
          JSON.stringify(
            [...stored.entries()]
              .filter(([name]) => name.startsWith(prefix))
              .map(([name, entry]) =>
                entry.expiration === undefined ? { name } : { name, expiration: entry.expiration }
              )
          )
        );
      }
      if (args[2] === "get") return result(`${stored.get(args[3] ?? "")?.value ?? ""}\n`);
      if (args[2] === "put") {
        puts.push(`${args[3]}=${await readFile(args[5] ?? "", "utf8")}`);
        return result("");
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    };

    const kept = await keepOAuthGrants(["--config", "w.jsonc"], run);

    assert.deepEqual(kept, { grants: 1, clients: 1 });
    assert.deepEqual(puts, [
      'grant:owner:timed={"id":"timed"}',
      'client:timed={"clientId":"timed"}'
    ]);
    assert.equal(
      keptSummary(kept),
      "Kept 1 MCP connection and 1 client registration until revocation."
    );
    assert.equal(
      keptSummary({ grants: 0, clients: 0 }),
      "Existing MCP connections already last until revocation."
    );
  });

  await it("surfaces Wrangler failures with the operation name", async () => {
    await assert.rejects(
      keepOAuthGrants([], () => Promise.resolve(result("denied", 1))),
      /OAuth record listing/u
    );
  });
});
