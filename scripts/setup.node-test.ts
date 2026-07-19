import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import {
  bindingProperty,
  configuredOrigin,
  deployedOrigin,
  deploymentListIndicatesExisting,
  handoff,
  initialConfig,
  migrationBundle,
  parseOptions,
  runSetup,
  withWebAssets,
  workersDevRegistrationRequired
} from "./setup.ts";
import { parseUninstallOptions, resolveUninstallTargets, runUninstall } from "./uninstall.ts";

const productionConfig = `${JSON.stringify({
  name: "my-memory",
  account_id: "account",
  vars: { APP_BASE_URL: "https://my-memory.owner.workers.dev" },
  d1_databases: [{ binding: "DB", database_name: "db", database_id: "db-id" }],
  kv_namespaces: [{ binding: "OAUTH_KV", id: "kv-id" }]
})}\n`;

async function inTemporaryDirectory(run: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "wikimemory-cli-test-"));
  try {
    process.chdir(directory);
    await run();
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

await describe("guided installer", async () => {
  await it("parses account, resume, and resource options strictly", () => {
    const options = parseOptions([
      "--resume",
      "--yes",
      "--account-id",
      "abc123",
      "--worker-name",
      "my-memory"
    ]);
    assert.equal(options.resume, true);
    assert.equal(options.yes, true);
    assert.equal(options.accountId, "abc123");
    assert.equal(options.workerName, "my-memory");
    assert.throws(() => parseOptions(["--recover", "--resume"]));
    assert.throws(() => parseOptions(["--worker-name", "Not_Valid"]));
  });

  await it("pins the selected account in generated production config", () => {
    const options = parseOptions([]);
    const config = initialConfig(options, { id: "account-123", name: "Personal" });
    assert.match(config, /"account_id": "account-123"/u);
    assert.equal(configuredOrigin(config), "https://bootstrap.invalid");
    assert.match(config, /"binding": "ASSETS"/u);
  });

  await it("upgrades resumable production configs with the React asset binding", () => {
    const config = withWebAssets(
      '{"name":"wikimemory","main":"src/index.ts","vars":{"APP_BASE_URL":"https://memory.example"}}\n'
    );
    const parsed: unknown = JSON.parse(config);
    assert.deepEqual(parsed, {
      name: "wikimemory",
      main: "src/index.ts",
      vars: { APP_BASE_URL: "https://memory.example" },
      assets: {
        directory: "./dist/web",
        binding: "ASSETS",
        not_found_handling: "single-page-application"
      }
    });
  });

  await it("discovers only workers.dev deployment origins", () => {
    assert.equal(
      deployedOrigin("Deployed https://wikimemory.owner.workers.dev"),
      "https://wikimemory.owner.workers.dev"
    );
    assert.equal(deployedOrigin("https://example.com"), null);
  });

  await it("recognizes the first-Worker subdomain onboarding requirement", () => {
    assert.equal(
      workersDevRegistrationRequired({
        stdout: "",
        stderr:
          "You can either deploy to routes, or register a workers.dev subdomain here: https://dash.cloudflare.com/account/workers/onboarding",
        exitCode: 1
      }),
      true
    );
    assert.equal(
      workersDevRegistrationRequired({
        stdout: "",
        stderr: "unrelated deployment failure",
        exitCode: 1
      }),
      false
    );
  });

  await it("distinguishes a missing Worker from an existing version-only Worker", () => {
    assert.equal(
      deploymentListIndicatesExisting({
        stdout: "",
        stderr: "This Worker does not exist [code: 10007]",
        exitCode: 1
      }),
      false
    );
    assert.equal(deploymentListIndicatesExisting({ stdout: "[]", stderr: "", exitCode: 0 }), true);
    assert.throws(() =>
      deploymentListIndicatesExisting({ stdout: "", stderr: "network failure", exitCode: 1 })
    );
  });

  await it("recovers the configured D1 name for resumable migrations", () => {
    const config = `{"d1_databases":[{"binding":"DB","database_name":"custom-memory","database_id":"id"}]}`;
    assert.equal(bindingProperty(config, "DB", "database_name"), "custom-memory");
    assert.equal(bindingProperty(config, "OAUTH_KV", "id"), null);
  });

  await it("bundles each compound migration with its atomic migration record", () => {
    const bundle = migrationBundle(
      "CREATE TRIGGER example AFTER INSERT ON items BEGIN SELECT 1; END;\n",
      "0001_owner's.sql"
    );
    assert.match(bundle, /CREATE TRIGGER[\s\S]+BEGIN SELECT 1; END;/u);
    assert.match(bundle, /INSERT INTO d1_migrations\(name\) VALUES \('0001_owner''s.sql'\);/u);
  });

  await it("prints complete read-write client handoff without exposing the hash", () => {
    const text = handoff("https://wikimemory.owner.workers.dev", "raw-token");
    assert.match(text, /codex mcp login wikimemory --scopes memory:read,memory:write/u);
    assert.match(text, /claude mcp add --transport http --scope user/u);
    assert.match(text, /\/setup#raw-token/u);
    assert.doesNotMatch(text, /SETUP_TOKEN_HASH/u);
  });

  await it("keeps uninstall in preview mode unless explicitly applied", () => {
    assert.deepEqual(parseUninstallOptions([]), { apply: false, confirmation: null, help: false });
    assert.deepEqual(parseUninstallOptions(["--apply", "--confirm", "my-memory"]), {
      apply: true,
      confirmation: "my-memory",
      help: false
    });
    assert.throws(() => parseUninstallOptions(["--confirm", "my-memory"]));
  });

  await it("resolves uninstall targets only from recorded bindings", () => {
    const config = `{"name":"my-memory","account_id":"account","d1_databases":[{"binding":"DB","database_name":"db","database_id":"db-id"}],"kv_namespaces":[{"binding":"OAUTH_KV","id":"kv-id"}]}`;
    assert.deepEqual(resolveUninstallTargets(config), {
      accountId: "account",
      workerName: "my-memory",
      databaseName: "db",
      databaseId: "db-id",
      kvNamespaceId: "kv-id"
    });
    assert.throws(() => resolveUninstallTargets(`{"name":"my-memory"}`));
  });

  await it("runs setup help and fails closed for incomplete lifecycle state", async () => {
    await runSetup(["--help"]);
    await inTemporaryDirectory(async () => {
      await assert.rejects(runSetup(["--resume", "--yes"]), /required for --resume/u);
      await assert.rejects(runSetup(["--recover", "--yes"]), /required for recovery/u);
      await writeFile("wrangler.production.jsonc", "{}\n", "utf8");
      await assert.rejects(runSetup(["--yes"]), /already exists/u);
    });
  });

  await it("runs uninstall help, preview, and exact-name protection without cloud changes", async () => {
    await runUninstall(["--help"]);
    await inTemporaryDirectory(async () => {
      await writeFile("wrangler.production.jsonc", productionConfig, "utf8");
      await runUninstall([]);
      await assert.rejects(
        runUninstall(["--apply", "--confirm", "wrong-worker"]),
        /Confirmation did not exactly match/u
      );
    });
  });

  await it("executes the exact uninstall sequence and removes only installer state", async () => {
    await inTemporaryDirectory(async () => {
      await writeFile("wrangler.production.jsonc", productionConfig, "utf8");
      await writeFile(".wikimemory-installer.json", "{}\n", "utf8");
      await writeFile("preserve-me.txt", "user data\n", "utf8");
      const commands: string[][] = [];
      await runUninstall(["--apply", "--confirm", "my-memory"], (args) => {
        commands.push(args);
        return Promise.resolve({
          stdout: args[1] === "deployments" ? "[]" : "",
          stderr: "",
          exitCode: 0
        });
      });
      assert.deepEqual(
        commands.map((args) => args.slice(0, 4)),
        [
          ["wrangler", "deployments", "list", "--name"],
          ["wrangler", "delete", "my-memory", "--force"],
          ["wrangler", "kv", "namespace", "delete"],
          ["wrangler", "d1", "delete", "db"]
        ]
      );
      await assert.rejects(access("wrangler.production.jsonc"));
      await assert.rejects(access(".wikimemory-installer.json"));
      await assert.rejects(access(".wikimemory-uninstall.json"));
      assert.equal(await readFile("preserve-me.txt", "utf8"), "user data\n");
    });
  });
});
