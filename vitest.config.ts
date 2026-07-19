import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("migrations");

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            main: "./src/index.ts",
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } }
          })
        ],
        test: {
          name: "worker",
          globals: true,
          include: ["test/**/*.test.ts"],
          setupFiles: ["./test/setup.ts"]
        }
      },
      {
        plugins: [react()],
        test: {
          name: "browser",
          include: ["web/test/**/*.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                channel: "chrome"
              }
            }),
            instances: [{ browser: "chromium" }]
          }
        }
      }
    ],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts", "web/src/**/*.{ts,tsx}"],
      reporter: ["text", "json-summary", "html"],
      reportOnFailure: true,
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 88,
        lines: 85,
        "src/auth/**": {
          statements: 85,
          branches: 70,
          functions: 85,
          lines: 85
        },
        "src/domain/**": {
          statements: 85,
          branches: 78,
          functions: 95,
          lines: 87
        },
        "src/mcp/**": {
          statements: 84,
          branches: 85,
          functions: 80,
          lines: 85
        },
        "src/web/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90
        },
        "web/src/**": {
          statements: 90,
          branches: 80,
          functions: 95,
          lines: 90
        }
      }
    }
  }
});
