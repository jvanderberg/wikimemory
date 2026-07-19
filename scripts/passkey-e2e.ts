import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { z } from "zod";

const ORIGIN = "http://localhost:8792";
const TOKEN = "wikimemory-local-passkey-test-token-0001";
const CONFIG = "wrangler.passkey-test.jsonc";
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
];

async function command(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", args, { stdio: "inherit" });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npx ${args.join(" ")} exited with status ${code ?? "unknown"}`));
    });
  });
}

async function chromePath(): Promise<string> {
  for (const path of CHROME_PATHS) {
    try {
      await access(path);
      return path;
    } catch {
      // Continue to the next known Chrome path.
    }
  }
  throw new Error("Chrome or Chromium is required for the passkey E2E test");
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/ready`);
      if (response.ok) return;
    } catch {
      // Wrangler may still be starting.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error("Local passkey Worker did not become ready");
}

async function main(): Promise<void> {
  const persistence = await mkdtemp(join(tmpdir(), "wikimemory-passkey-e2e-"));
  if (!persistence.startsWith(`${tmpdir()}/wikimemory-passkey-e2e-`))
    throw new Error("Unexpected persistence path");
  let worker: ReturnType<typeof spawn> | null = null;
  try {
    await command([
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "wikimemory-passkey-test",
      "--local",
      "--persist-to",
      persistence,
      "--config",
      CONFIG
    ]);
    worker = spawn(
      "npx",
      [
        "wrangler",
        "dev",
        "--port",
        "8792",
        "--persist-to",
        persistence,
        "--config",
        CONFIG,
        "--show-interactive-dev-session=false"
      ],
      { stdio: "inherit" }
    );
    await waitUntilReady();
    const browser = await chromium.launch({ executablePath: await chromePath(), headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true
        }
      });
      await page.goto(`${ORIGIN}/setup#${TOKEN}`);
      await page.getByRole("button", { name: "Create passkey" }).click();
      await page.getByText("Passkey saved. Wikimemory is ready.").waitFor();
      await page.goto(`${ORIGIN}/test/passkey/login`);
      await page.getByRole("button", { name: "Continue with passkey" }).click();
      await page.waitForURL(`${ORIGIN}/app`);
      const identityResponse = await context.request.get(`${ORIGIN}/app/test-passkey-whoami`);
      z.object({ authenticated: z.literal(true) }).parse(JSON.parse(await identityResponse.text()));
      console.log("local WebAuthn registration + authentication E2E passed");
    } finally {
      await browser.close();
    }
  } finally {
    if (worker !== null) worker.kill("SIGTERM");
    await rm(persistence, { recursive: true, force: true });
  }
}

await main();
