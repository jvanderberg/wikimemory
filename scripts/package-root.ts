import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(moduleUrl = import.meta.url): string {
  let candidate = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(candidate, "release-manifest.json"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("Could not locate the Wikimemory package root");
}
