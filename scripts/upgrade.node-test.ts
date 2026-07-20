import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deploymentArguments, installArguments } from "./cli-options.ts";
import {
  deploymentPaths,
  deploymentRecordFromConfig,
  requireInstalledDeployment
} from "./deployment-record.ts";
import { DEPLOYMENT_VERIFY_ATTEMPTS, deploymentVerifyDelay } from "./deployment-wait.ts";
import { localConfig } from "./dev.ts";
import { statusSummary } from "./status.ts";
import { boundedOutputChunk, conciseDiagnostic, conciseError, runCommand } from "./subprocess.ts";
import type { ReleaseManifest } from "./upgrade.ts";
import {
  compareSemanticVersions,
  deploymentIsCurrent,
  parseProductionUpgradeConfig,
  parseUpgradeOptions,
  planMigrations,
  productionUpgradeConfig,
  readySummary,
  upgradeSummary,
  validateReleaseManifest,
  validateRemoteTargets,
  verifyRelease
} from "./upgrade.ts";
import { isReactApplicationShell } from "./web-shell.ts";

const manifest = {
  version: "0.2.0",
  schemaVersion: "0002_second.sql",
  migrations: [
    { name: "0001_first.sql", sha256: "a".repeat(64) },
    { name: "0002_second.sql", sha256: "b".repeat(64) }
  ]
} satisfies ReleaseManifest;

const record = {
  formatVersion: 1,
  accountId: "account-id",
  workerName: "my-memory",
  databaseName: "my-memory-db",
  databaseId: "database-id",
  kvName: "my-memory-oauth",
  kvId: "kv-id",
  origin: "https://my-memory.example.workers.dev",
  installedVersion: "0.1.0"
} as const;

const populatedReactShell = `<!doctype html><div id="root"><p>Loading…</p></div><script type="module" crossorigin src="/assets/index-new.js"></script>`;

await describe("packaged upgrade", async () => {
  await it("parses only the documented upgrade options", () => {
    assert.deepEqual(parseUpgradeOptions(["--deployment", "personal", "--yes"]), {
      deployment: "personal",
      recordPath: null,
      yes: true,
      help: false
    });
    assert.deepEqual(parseUpgradeOptions(["--record", "/tmp/record.json", "--help"]), {
      deployment: "wikimemory",
      recordPath: "/tmp/record.json",
      yes: false,
      help: true
    });
    assert.throws(() => parseUpgradeOptions(["--unknown"]), /Unknown option/u);
    assert.throws(() => parseUpgradeOptions(["--deployment", "../escape"]), /deployment/u);
  });

  await it("accepts only an immutable, ordered release manifest", () => {
    assert.deepEqual(validateReleaseManifest(manifest), manifest);
    assert.throws(
      () => validateReleaseManifest({ ...manifest, schemaVersion: "0001_first.sql" }),
      /schemaVersion/u
    );
    assert.throws(
      () =>
        validateReleaseManifest({
          ...manifest,
          migrations: [manifest.migrations[1], manifest.migrations[0]]
        }),
      /strictly ordered/u
    );
  });

  await it("runs only the exact missing suffix and rejects drift or downgrade", () => {
    assert.deepEqual(planMigrations(manifest, ["0001_first.sql"]), [manifest.migrations[1]]);
    assert.deepEqual(
      planMigrations(
        manifest,
        manifest.migrations.map((item) => item.name)
      ),
      []
    );
    assert.throws(() => planMigrations(manifest, ["unknown.sql"]), /does not match/u);
    assert.throws(
      () => planMigrations(manifest, ["0001_first.sql", "0002_second.sql", "0003_future.sql"]),
      /newer than/u
    );
  });

  await it("compares application versions independently of schema versions", () => {
    assert.equal(compareSemanticVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareSemanticVersions("1.10.0", "1.9.9"), 1);
    assert.equal(compareSemanticVersions("0.9.9", "1.0.0"), -1);
    assert.throws(() => compareSemanticVersions("latest", "1.0.0"));
  });

  await it("recognizes a fully current deployment without redeploying", () => {
    const pendingMigration = manifest.migrations.at(1);
    assert.ok(pendingMigration);
    assert.equal(deploymentIsCurrent(manifest.version, manifest, []), true);
    assert.equal(deploymentIsCurrent("0.1.0", manifest, []), false);
    assert.equal(deploymentIsCurrent(manifest.version, manifest, [pendingMigration]), false);
  });

  await it("accepts a populated React root and still requires the module asset", () => {
    assert.equal(isReactApplicationShell(populatedReactShell), true);
    assert.equal(isReactApplicationShell('<div id="root"><p>Loading…</p></div>'), false);
    assert.equal(
      isReactApplicationShell('<script type="module" src="/assets/index.js"></script>'),
      false
    );
  });

  await it("uses concise, user-facing upgrade and status summaries", () => {
    const upgrade = upgradeSummary(record, "0.2.10", "0.2.11", 0);
    assert.match(upgrade, /Database updates: none/u);
    assert.doesNotMatch(upgrade, /account-id|database-id|kv-id|\.sql/u);
    assert.ok(upgrade.length < 200);
    assert.equal(readySummary("0.2.11"), "Wikimemory 0.2.11 is ready.\nDatabase: up to date.");
    assert.equal(
      readySummary("0.2.11", true),
      "Wikimemory 0.2.11 is already ready.\nDatabase: up to date."
    );
    const status = statusSummary({
      deployment: "scratch",
      accountId: "account-id",
      workerName: "scratch",
      database: "scratch (database-id)",
      kvNamespace: "scratch-oauth (kv-id)",
      origin: record.origin,
      recordedVersion: "0.2.11",
      runningVersion: "0.2.11",
      schemaVersion: "0004_internal_name.sql"
    });
    assert.equal(
      status,
      `Wikimemory scratch: ready\nWeb app: ${record.origin}/\nMCP endpoint: ${record.origin}/mcp\nVersion: 0.2.11\nDatabase: up to date.`
    );
    assert.doesNotMatch(status, /\nURL:/u);
    assert.doesNotMatch(status, /account-id|database-id|kv-id|\.sql/u);
  });

  await it("captures subprocess chatter and bounds failure diagnostics", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(2000)); process.stderr.write('useful failure')"
    ]);
    assert.equal(result.stdout.length, 2000);
    assert.equal(result.stderr, "useful failure");
    assert.equal(result.exitCode, 0);
    assert.equal(conciseDiagnostic(result, 20), "useful failure");
    assert.equal(conciseError(new Error("x".repeat(100)), 20), `${"x".repeat(17)}...`);
    assert.deepEqual(boundedOutputChunk("small", 10), {
      visible: "small",
      remaining: 5,
      truncated: false
    });
    assert.deepEqual(boundedOutputChunk("too much output", 3), {
      visible: "too",
      remaining: 0,
      truncated: true
    });
  });

  await it("retries post-deploy verification while Cloudflare propagates a new version", async () => {
    let healthAttempts = 0;
    const delays: number[] = [];
    await verifyRelease(
      record.origin,
      manifest,
      (input) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        if (url.endsWith("/health")) {
          healthAttempts += 1;
          return Promise.resolve(
            Response.json({
              status: "ok",
              service: "wikimemory",
              version: healthAttempts === 1 ? "0.1.0" : manifest.version
            })
          );
        }
        if (url.endsWith("/ready")) {
          return Promise.resolve(
            Response.json({
              status: "ready",
              service: "wikimemory",
              version: manifest.version,
              schemaVersion: manifest.schemaVersion
            })
          );
        }
        if (url.includes("/.well-known/oauth-protected-resource/mcp")) {
          return Promise.resolve(Response.json({ resource: `${record.origin}/mcp` }));
        }
        return Promise.resolve(new Response(populatedReactShell));
      },
      (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      }
    );
    assert.equal(healthAttempts, 2);
    assert.deepEqual(delays, [1000]);
  });

  await it("allows Cloudflare edge propagation for roughly two minutes", () => {
    assert.equal(DEPLOYMENT_VERIFY_ATTEMPTS, 25);
    assert.deepEqual([0, 1, 2, 3, 20].map(deploymentVerifyDelay), [1000, 2000, 4000, 5000, 5000]);
    const totalWait = Array.from({ length: DEPLOYMENT_VERIFY_ATTEMPTS - 1 }, (_, index) =>
      deploymentVerifyDelay(index)
    ).reduce((total, delay) => total + delay, 0);
    assert.equal(totalWait, 112_000);
  });

  await it("accepts a release that appears after the old retry window", async () => {
    let healthAttempts = 0;
    await verifyRelease(
      record.origin,
      manifest,
      (input) => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.href : input;
        if (url.endsWith("/health")) {
          healthAttempts += 1;
          return Promise.resolve(
            Response.json({
              status: "ok",
              service: "wikimemory",
              version: healthAttempts < 12 ? "0.1.0" : manifest.version
            })
          );
        }
        if (url.endsWith("/ready")) {
          return Promise.resolve(
            Response.json({
              status: "ready",
              service: "wikimemory",
              version: manifest.version,
              schemaVersion: manifest.schemaVersion
            })
          );
        }
        if (url.includes("/.well-known/oauth-protected-resource/mcp"))
          return Promise.resolve(Response.json({ resource: `${record.origin}/mcp` }));
        return Promise.resolve(new Response(populatedReactShell));
      },
      () => Promise.resolve()
    );
    assert.equal(healthAttempts, 12);
  });

  await it("pins the package entrypoint, assets, account, and immutable resource IDs", () => {
    const config = parseProductionUpgradeConfig(
      JSON.parse(productionUpgradeConfig(record, "/package"))
    );
    assert.equal(config.name, "my-memory");
    assert.equal(config.account_id, "account-id");
    assert.equal(config.main, "/package/src/index.ts");
    assert.equal(config.assets.directory, "/package/dist/web");
    assert.equal(config.assets.run_worker_first, true);
    const database = config.d1_databases.at(0);
    const namespace = config.kv_namespaces.at(0);
    assert.ok(database);
    assert.ok(namespace);
    assert.equal(database.database_id, "database-id");
    assert.equal(namespace.id, "kv-id");
    assert.equal(config.vars.APP_BASE_URL, record.origin);
  });

  await it("rejects authenticated-account and resource target mismatches", () => {
    const remote = {
      accounts: [{ id: "account-id" }],
      databases: [{ uuid: "database-id", name: "my-memory-db" }],
      namespaces: [{ id: "kv-id", title: "my-memory-oauth" }]
    };
    assert.doesNotThrow(() => {
      validateRemoteTargets(record, remote);
    });
    assert.throws(() => {
      validateRemoteTargets(record, { ...remote, databases: [] });
    }, /D1 database/u);
    assert.throws(() => {
      validateRemoteTargets(record, { ...remote, accounts: [{ id: "other" }] });
    }, /Cloudflare account/u);
  });

  await it("records custom resource names from an installed production config", () => {
    const config = productionUpgradeConfig(record, "/package");
    assert.deepEqual(deploymentRecordFromConfig(config, "0.2.0", "custom-kv"), {
      ...record,
      kvName: "custom-kv",
      installedVersion: "0.2.0"
    });
  });

  await it("keeps every lifecycle file inside one deployment directory", () => {
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = "/config";
    try {
      assert.deepEqual(deploymentPaths("personal"), {
        directory: "/config/wikimemory/deployments/personal",
        record: "/config/wikimemory/deployments/personal/deployment.json",
        config: "/config/wikimemory/deployments/personal/wrangler.jsonc",
        installProgress: "/config/wikimemory/deployments/personal/install-progress.json",
        uninstallProgress: "/config/wikimemory/deployments/personal/uninstall-progress.json",
        passkeyClient: "/config/wikimemory/deployments/personal/passkey-client.json"
      });
    } finally {
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
    }
  });

  await it("replaces missing deployment file errors with actionable guidance", async () => {
    const previous = process.env["XDG_CONFIG_HOME"];
    const temporary = await mkdtemp(join(tmpdir(), "wikimemory-missing-deployment-test-"));
    process.env["XDG_CONFIG_HOME"] = temporary;
    try {
      await assert.rejects(
        requireInstalledDeployment("wikimemory"),
        /No deployment named “wikimemory”\. Run wikimemory install first\./u
      );
      const scratch = join(temporary, "wikimemory", "deployments", "scratch");
      await mkdir(scratch, { recursive: true });
      await writeFile(join(scratch, "deployment.json"), "{}\n", "utf8");
      await assert.rejects(
        requireInstalledDeployment("wikimemory"),
        /Installed: scratch\. Use --deployment NAME\./u
      );
      await assert.doesNotReject(requireInstalledDeployment("scratch"));
    } finally {
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("routes deployment options without leaking them into subcommands", () => {
    assert.deepEqual(deploymentArguments(["--yes", "--deployment", "scratch"]), {
      deployment: "scratch",
      remaining: ["--yes"]
    });
    assert.deepEqual(installArguments("scratch", ["--yes"]), [
      "--yes",
      "--worker-name",
      "scratch",
      "--database-name",
      "scratch",
      "--kv-name",
      "scratch-oauth"
    ]);
    assert.throws(() => deploymentArguments(["--deployment", "../escape"]));
  });

  await it("generates a package-owned persistent local development config", () => {
    const config = localConfig("/package");
    assert.match(config, /"main": "\/package\/src\/index\.ts"/u);
    assert.match(config, /"directory": "\/package\/dist\/web"/u);
    assert.match(config, /"run_worker_first": true/u);
    assert.match(config, /"APP_ENV": "local"/u);
  });
});
