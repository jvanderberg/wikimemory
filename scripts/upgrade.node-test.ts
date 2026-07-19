import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deploymentArguments, installArguments } from "./cli-options.ts";
import { deploymentPaths, deploymentRecordFromConfig } from "./deployment-record.ts";
import { localConfig } from "./dev.ts";
import type { ReleaseManifest } from "./upgrade.ts";
import {
  compareSemanticVersions,
  parseProductionUpgradeConfig,
  parseUpgradeOptions,
  planMigrations,
  productionUpgradeConfig,
  validateReleaseManifest,
  validateRemoteTargets
} from "./upgrade.ts";

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
