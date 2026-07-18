import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindingProperty, configuredOrigin, deployedOrigin, deploymentListIndicatesExisting, handoff, initialConfig, parseOptions } from "./setup.ts";
import { parseUninstallOptions, resolveUninstallTargets } from "./uninstall.ts";

await describe("guided installer", async () => {
  await it("parses account, resume, and resource options strictly", () => {
    const options = parseOptions(["--resume", "--yes", "--account-id", "abc123", "--worker-name", "my-memory"]);
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
  });

  await it("discovers only workers.dev deployment origins", () => {
    assert.equal(deployedOrigin("Deployed https://wikimemory.owner.workers.dev"), "https://wikimemory.owner.workers.dev");
    assert.equal(deployedOrigin("https://example.com"), null);
  });

  await it("distinguishes a missing Worker from an existing version-only Worker", () => {
    assert.equal(deploymentListIndicatesExisting({ stdout: "", stderr: "This Worker does not exist [code: 10007]", exitCode: 1 }), false);
    assert.equal(deploymentListIndicatesExisting({ stdout: "[]", stderr: "", exitCode: 0 }), true);
    assert.throws(() => deploymentListIndicatesExisting({ stdout: "", stderr: "network failure", exitCode: 1 }));
  });

  await it("recovers the configured D1 name for resumable migrations", () => {
    const config = `{"d1_databases":[{"binding":"DB","database_name":"custom-memory","database_id":"id"}]}`;
    assert.equal(bindingProperty(config, "DB", "database_name"), "custom-memory");
    assert.equal(bindingProperty(config, "OAUTH_KV", "id"), null);
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
    assert.deepEqual(parseUninstallOptions(["--apply", "--confirm", "my-memory"]), { apply: true, confirmation: "my-memory", help: false });
    assert.throws(() => parseUninstallOptions(["--confirm", "my-memory"]));
  });

  await it("resolves uninstall targets only from recorded bindings", () => {
    const config = `{"name":"my-memory","account_id":"account","d1_databases":[{"binding":"DB","database_name":"db","database_id":"db-id"}],"kv_namespaces":[{"binding":"OAUTH_KV","id":"kv-id"}]}`;
    assert.deepEqual(resolveUninstallTargets(config), {
      accountId: "account", workerName: "my-memory", databaseName: "db", databaseId: "db-id", kvNamespaceId: "kv-id"
    });
    assert.throws(() => resolveUninstallTargets(`{"name":"my-memory"}`));
  });
});
