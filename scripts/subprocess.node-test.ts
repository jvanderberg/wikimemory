import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { runCommand } from "./subprocess.ts";

await describe("cross-platform subprocesses", async () => {
  await it("preserves arguments without shell interpretation", async () => {
    const expected = ["space value", "literal&operator", "$(not-a-command)"];
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...expected
    ]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  });

  await it("executes npx, Claude, and Codex Windows command shims", {
    skip: process.platform !== "win32"
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "wikimemory-windows-shims-"));
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const previousPath = process.env[pathKey];
    const expected = ["mcp", "space value", "literal&operator", "$(not-a-command)"];
    try {
      const script = join(directory, "capture-arguments.js");
      await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      for (const name of ["npx", "claude", "codex"]) {
        await writeFile(
          join(directory, `${name}.cmd`),
          `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`
        );
      }
      process.env[pathKey] = `${directory}${delimiter}${previousPath ?? ""}`;
      for (const name of ["npx", "claude", "codex"]) {
        const result = await runCommand(name, expected);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), expected);
      }
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, pathKey);
      else process.env[pathKey] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
