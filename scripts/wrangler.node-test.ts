import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { runWrangler, wranglerCliPath, wranglerInvocation } from "./wrangler.ts";

await describe("pinned Wrangler execution", async () => {
  await it("uses Node and the installed Wrangler CLI without npx or PATH lookup", async () => {
    const invocation = wranglerInvocation(["whoami", "--json"]);

    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], wranglerCliPath());
    assert.deepEqual(invocation.args.slice(1), ["whoami", "--json"]);
    assert.doesNotMatch(invocation.command, /npx/u);
    await access(wranglerCliPath());
  });

  await it("runs the pinned Wrangler binary successfully", async () => {
    const result = await runWrangler(["--version"]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /4\.112\.0/u);
  });

  await it("resolves Wrangler relative to its package metadata", () => {
    const resolved = wranglerCliPath(
      () => "file:///tmp/example/node_modules/wrangler/package.json"
    );

    assert.equal(resolved, "/tmp/example/node_modules/wrangler/bin/wrangler.js");
  });

  await it("keeps every Cloudflare lifecycle free of nested npx execution", async () => {
    for (const name of ["dev.ts", "setup.ts", "uninstall.ts", "upgrade.ts"]) {
      const source = await readFile(join(import.meta.dirname, name), "utf8");
      assert.doesNotMatch(source, /(?:runCommand|spawn|command)\(\s*["']npx["']/u, name);
    }
  });
});
