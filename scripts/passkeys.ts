import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { passkeyRuntime } from "./lifecycle-runtime.ts";
import { configuredOrigin } from "./setup.ts";

const PRODUCTION_CONFIG = passkeyRuntime.config;
const CLI_STATE = passkeyRuntime.client;
const CALLBACK = "http://127.0.0.1:45831/callback";
const CLIENT_SCHEMA = z.object({ clientId: z.string().min(1) });
const DCR_SCHEMA = z.object({ client_id: z.string().min(1) });
const TOKEN_SCHEMA = z.object({ access_token: z.string().min(1), token_type: z.string() });
const PASSKEY_SCHEMA = z.object({
  credentialRef: z.string(),
  label: z.string(),
  deviceType: z.enum(["singleDevice", "multiDevice"]),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable()
});
const LIST_SCHEMA = z.object({ passkeys: z.array(PASSKEY_SCHEMA) });
const ADD_SCHEMA = z.object({ registrationUrl: z.url(), expiresAt: z.string() });
const REVOKE_SCHEMA = z.object({
  revoked: z.string(),
  sessionCleanupComplete: z.boolean()
});

type Command =
  | { kind: "list" }
  | { kind: "add"; label: string }
  | { kind: "revoke"; credentialRef: string };

function command(args: string[]): Command {
  if (args[0] === "list" && args.length === 1) return { kind: "list" };
  if (args[0] === "add" && args[1] === "--name" && args[2] !== undefined && args.length === 3)
    return { kind: "add", label: args[2] };
  if (
    args[0] === "revoke" &&
    args[1] !== undefined &&
    args.length === 2 &&
    /^[a-f0-9]{64}$/u.test(args[1])
  )
    return { kind: "revoke", credentialRef: args[1] };
  const executable = passkeyRuntime.config.endsWith("wrangler.jsonc")
    ? "wikimemory passkeys"
    : "npm run passkeys --";
  throw new Error(
    `Usage: ${executable} list\n       ${executable} add --name "Backup key"\n       ${executable} revoke CREDENTIAL_REF`
  );
}

async function clientId(origin: string): Promise<string> {
  try {
    return CLIENT_SCHEMA.parse(JSON.parse(await readFile(CLI_STATE, "utf8"))).clientId;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const response = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Wikimemory owner CLI",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  if (!response.ok)
    throw new Error(`OAuth client registration failed with HTTP ${response.status}`);
  const registered = DCR_SCHEMA.parse(await response.json());
  await writeFile(CLI_STATE, `${JSON.stringify({ clientId: registered.client_id }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  return registered.client_id;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const executable = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(executable, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function authorizationCode(authorizeUrl: string, expectedState: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", CALLBACK);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (state !== expectedState || code === null || error !== null) {
        response
          .writeHead(400, { "content-type": "text/plain; charset=utf-8" })
          .end("Wikimemory CLI authorization failed. Return to the terminal.");
        server.close();
        reject(new Error(error ?? "OAuth callback validation failed"));
        return;
      }
      response
        .writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        })
        .end("Wikimemory CLI authorized. You can close this tab.");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(45831, "127.0.0.1", () => {
      openBrowser(authorizeUrl);
    });
  });
}

async function accessToken(origin: string, client: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const resource = `${origin}/mcp`;
  const authorize = new URL(`${origin}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: CALLBACK,
    scope: "memory:admin",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource
  }).toString();
  console.log("Opening your browser for passkey authorization…");
  const code = await authorizationCode(authorize.toString(), state);
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client,
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      resource
    })
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed with HTTP ${response.status}`);
  return TOKEN_SCHEMA.parse(await response.json()).access_token;
}

export async function runPasskeys(args: string[]): Promise<void> {
  const selected = command(args);
  const origin = configuredOrigin(await readFile(PRODUCTION_CONFIG, "utf8"));
  if (origin === null || origin === "https://bootstrap.invalid")
    throw new Error("A deployed wrangler.production.jsonc is required");
  const token = await accessToken(origin, await clientId(origin));
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (selected.kind === "list") {
    const response = await fetch(`${origin}/api/passkeys`, { headers });
    if (!response.ok) throw new Error(`Passkey listing failed with HTTP ${response.status}`);
    const result = LIST_SCHEMA.parse(await response.json());
    for (const passkey of result.passkeys) {
      console.log(
        `${passkey.credentialRef}  ${passkey.label}\n  ${passkey.deviceType}, ${passkey.backedUp ? "backed up" : "not backed up"}, created ${passkey.createdAt}${passkey.lastUsedAt === null ? "" : `, last used ${passkey.lastUsedAt}`}`
      );
    }
  } else if (selected.kind === "add") {
    const response = await fetch(`${origin}/api/passkeys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: selected.label })
    });
    if (!response.ok) throw new Error(`Passkey registration failed with HTTP ${response.status}`);
    const result = ADD_SCHEMA.parse(await response.json());
    console.log(`Opening the one-use registration page (expires ${result.expiresAt})…`);
    openBrowser(result.registrationUrl);
  } else {
    const response = await fetch(`${origin}/api/passkeys`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ credentialRef: selected.credentialRef })
    });
    if (!response.ok)
      throw new Error(
        `Passkey revocation failed with HTTP ${response.status}: ${await response.text()}`
      );
    const result = REVOKE_SCHEMA.parse(await response.json());
    console.log(`Revoked ${result.revoked}.`);
    console.log(
      result.sessionCleanupComplete
        ? "Sessions created by that credential were also removed."
        : "Session cleanup could not be confirmed, but those sessions are blocked because the passkey no longer exists."
    );
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runPasskeys(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `Passkey command failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exitCode = 1;
  });
}
