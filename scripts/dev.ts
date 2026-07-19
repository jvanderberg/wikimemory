import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export function localConfig(packageRoot: string): string {
  return `${JSON.stringify(
    {
      $schema: join(packageRoot, "node_modules", "wrangler", "config-schema.json"),
      name: "wikimemory-local",
      main: join(packageRoot, "src", "index.ts"),
      compatibility_date: "2026-07-18",
      compatibility_flags: ["nodejs_compat"],
      assets: {
        directory: join(packageRoot, "dist", "web"),
        binding: "ASSETS",
        not_found_handling: "single-page-application",
        run_worker_first: true
      },
      vars: { APP_ENV: "local" },
      d1_databases: [
        {
          binding: "DB",
          database_name: "wikimemory",
          database_id: "00000000-0000-0000-0000-000000000001",
          migrations_dir: join(packageRoot, "migrations")
        }
      ],
      kv_namespaces: [{ binding: "OAUTH_KV", id: "00000000000000000000000000000001" }]
    },
    null,
    2
  )}\n`;
}

async function runWrangler(args: string[], inherited = false): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      stdio: inherited ? "inherit" : ["ignore", "inherit", "inherit"]
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Wrangler exited with status ${code ?? "unknown"}`));
    });
  });
}

export async function runDev(packageRoot: string, args: string[]): Promise<void> {
  const stateDirectory = resolve(".wikimemory", "dev");
  await mkdir(stateDirectory, { recursive: true });
  const configPath = join(stateDirectory, "wrangler.jsonc");
  await writeFile(configPath, localConfig(packageRoot), "utf8");
  await runWrangler(["d1", "migrations", "apply", "wikimemory", "--local", "--config", configPath]);
  await runWrangler(["dev", "--config", configPath, ...args], true);
}
