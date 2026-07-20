import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const ROOT = join(import.meta.dirname, "..");
const PACKAGE_SCHEMA = z.object({ scripts: z.record(z.string(), z.string()) });
const FORBIDDEN = [
  { pattern: /\bnpx --yes\b/u, message: "use the normal npx command in user-facing text" },
  { pattern: /\bV1\b/u, message: "describe the current product without internal V1 framing" },
  { pattern: /docs\/v1-spec\.md/u, message: "use docs/product-spec.md" },
  { pattern: /docs\/implementation-plan\.md/u, message: "use docs/implementation-history.md" }
];

async function markdownFiles(): Promise<string[]> {
  const docs = (await readdir(join(ROOT, "docs")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("docs", name));
  const skills: string[] = [];
  for (const directory of await readdir(join(ROOT, "skills"))) {
    const path = join("skills", directory, "SKILL.md");
    try {
      await readFile(join(ROOT, path), "utf8");
      skills.push(path);
    } catch {
      // A skill directory without Markdown has no documentation to audit.
    }
  }
  return ["README.md", "AGENTS.md", "CLAUDE.md", ...docs, ...skills];
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function check(): Promise<void> {
  const packageJson = PACKAGE_SCHEMA.parse(
    JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"))
  );
  const failures: string[] = [];
  for (const relativePath of await markdownFiles()) {
    const content = await readFile(join(ROOT, relativePath), "utf8");
    for (const forbidden of FORBIDDEN) {
      if (forbidden.pattern.test(content)) failures.push(`${relativePath}: ${forbidden.message}`);
    }
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const destination = match[1];
      if (
        destination === undefined ||
        destination.startsWith("#") ||
        /^(?:https?:|mailto:)/u.test(destination)
      )
        continue;
      const localPath = destination.split("#", 1)[0];
      if (
        localPath !== undefined &&
        !(await exists(resolve(ROOT, dirname(relativePath), localPath)))
      )
        failures.push(`${relativePath}: broken link ${destination}`);
    }
    for (const match of content.matchAll(/`(docs\/[^`]+\.md)`/gu)) {
      const destination = match[1];
      if (destination !== undefined && !(await exists(resolve(ROOT, destination))))
        failures.push(`${relativePath}: missing referenced file ${destination}`);
    }
    for (const match of content.matchAll(/\bnpm run ([a-z0-9:-]+)/gu)) {
      const script = match[1];
      if (script !== undefined && packageJson.scripts[script] === undefined)
        failures.push(`${relativePath}: unknown npm script ${script}`);
    }
  }
  if (failures.length > 0) throw new Error(`Documentation check failed:\n${failures.join("\n")}`);
  console.log("Documentation links, commands, and terminology are current.");
}

await check();
