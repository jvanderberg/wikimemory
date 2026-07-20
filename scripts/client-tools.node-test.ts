import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { replaceSkillDirectories } from "./client-tools.ts";

async function fixture(): Promise<{
  destinationRoot: string;
  packageRoot: string;
  skillName: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "wikimemory-client-tools-"));
  const packageRoot = join(root, "package");
  const destinationRoot = join(root, "client", "skills");
  const skillName = "wikimemory-recall";
  await mkdir(join(packageRoot, "skills", skillName), { recursive: true });
  await mkdir(destinationRoot, { recursive: true });
  await writeFile(join(packageRoot, "skills", skillName, "SKILL.md"), "current\n");
  return { destinationRoot, packageRoot, skillName };
}

await describe("client skill installation", async () => {
  await it("replaces a development symlink without changing its source", async () => {
    const { destinationRoot, packageRoot, skillName } = await fixture();
    const linkedSource = join(packageRoot, "linked-source");
    await mkdir(linkedSource);
    await writeFile(join(linkedSource, "SKILL.md"), "development\n");
    const destination = join(destinationRoot, skillName);
    await symlink(linkedSource, destination);

    await replaceSkillDirectories(packageRoot, destinationRoot, [skillName]);

    assert.equal((await lstat(destination)).isSymbolicLink(), false);
    assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), "current\n");
    assert.equal(await readFile(join(linkedSource, "SKILL.md"), "utf8"), "development\n");
  });

  await it("replaces an existing directory instead of retaining stale files", async () => {
    const { destinationRoot, packageRoot, skillName } = await fixture();
    const destination = join(destinationRoot, skillName);
    await mkdir(destination);
    await writeFile(join(destination, "obsolete.md"), "stale\n");

    await replaceSkillDirectories(packageRoot, destinationRoot, [skillName]);

    assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), "current\n");
    await assert.rejects(readFile(join(destination, "obsolete.md"), "utf8"), {
      code: "ENOENT"
    });
  });

  await it("leaves an existing skill intact when staging the replacement fails", async () => {
    const { destinationRoot, packageRoot, skillName } = await fixture();
    const destination = join(destinationRoot, skillName);
    await mkdir(destination);
    await writeFile(join(destination, "SKILL.md"), "installed\n");

    await assert.rejects(
      replaceSkillDirectories(packageRoot, destinationRoot, [skillName, "wikimemory-missing"]),
      /ENOENT/u
    );

    assert.equal(await readFile(join(destination, "SKILL.md"), "utf8"), "installed\n");
  });
});
