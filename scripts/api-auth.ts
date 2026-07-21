import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { openBrowser } from "./browse.ts";
import { readDeploymentRecord } from "./deployment-record.ts";

const storedSchema = z
  .object({
    origin: z.url(),
    savedAt: z.string().optional(),
    clientInformation: z.record(z.string(), z.unknown()),
    tokens: z.looseObject({
      access_token: z.string(),
      token_type: z.string(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      refresh_token: z.string().optional(),
      id_token: z.string().optional()
    })
  })
  .strict();

type StoredAuthorization = z.infer<typeof storedSchema>;

async function storeAuthorization(
  stateDirectory: string,
  authorization: StoredAuthorization
): Promise<void> {
  const target = join(stateDirectory, "api-auth.json");
  const temporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(authorization, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function refreshAccessToken(
  stateDirectory: string,
  stored: StoredAuthorization
): Promise<string> {
  const clientId = stored.clientInformation["client_id"];
  const refreshToken = stored.tokens.refresh_token;
  if (typeof clientId !== "string" || refreshToken === undefined)
    throw new Error("API authorization expired. Run `wikimemory api login` again");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource: `${stored.origin}/api/v1`
  });
  const response = await fetch(`${stored.origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error("API authorization expired. Run `wikimemory api login` again");
  const tokens = storedSchema.shape.tokens.parse(value);
  const refreshed: StoredAuthorization = {
    ...stored,
    savedAt: new Date().toISOString(),
    tokens: { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken }
  };
  await storeAuthorization(stateDirectory, refreshed);
  return refreshed.tokens.access_token;
}

export async function accessToken(stateDirectory: string): Promise<string> {
  const override = process.env["WIKIMEMORY_ACCESS_TOKEN"];
  if (override !== undefined && override !== "") return override;
  try {
    const stored = storedSchema.parse(
      JSON.parse(await readFile(join(stateDirectory, "api-auth.json"), "utf8"))
    );
    const savedAt = stored.savedAt === undefined ? Number.NaN : Date.parse(stored.savedAt);
    const expiresIn = stored.tokens.expires_in;
    if (
      expiresIn !== undefined &&
      Number.isFinite(savedAt) &&
      Date.now() < savedAt + Math.max(0, expiresIn - 60) * 1000
    )
      return stored.tokens.access_token;
    return await refreshAccessToken(stateDirectory, stored);
  } catch {
    throw new Error("Run `wikimemory api login` first, or set WIKIMEMORY_ACCESS_TOKEN");
  }
}

export async function loginApi(deploymentRecord: string, stateDirectory: string): Promise<void> {
  const deployment = await readDeploymentRecord(deploymentRecord);
  const callback = await new Promise<{
    redirectUrl: URL;
    wait: Promise<string>;
    state: string;
    close: () => void;
  }>((resolve, reject) => {
    let complete: ((code: string) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const wait = new Promise<string>((done, nope) => {
      complete = done;
      fail = nope;
    });
    const state = randomBytes(24).toString("hex");
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400).end("Invalid OAuth state");
        fail?.(new Error("OAuth state did not match"));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null) {
        response.writeHead(400).end("Authorization failed");
        fail?.(new Error(url.searchParams.get("error") ?? "Authorization failed"));
        return;
      }
      response
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("Wikimemory CLI authorized. You can close this window.");
      complete?.(code);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not start OAuth callback"));
        return;
      }
      resolve({
        redirectUrl: new URL(`http://127.0.0.1:${address.port}/callback`),
        wait,
        state,
        close: () => server.close()
      });
    });
  });
  let clientInformation: OAuthClientInformationMixed | undefined;
  let tokens: OAuthTokens | undefined;
  let verifier = "";
  const provider: OAuthClientProvider = {
    redirectUrl: callback.redirectUrl,
    clientMetadata: {
      redirect_uris: [callback.redirectUrl.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Wikimemory CLI",
      scope: "memory:read memory:admin"
    } satisfies OAuthClientMetadata,
    state: () => callback.state,
    clientInformation: () => clientInformation,
    saveClientInformation: (value) => {
      clientInformation = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    redirectToAuthorization: (url) => {
      console.log("Opening the owner authorization page…");
      openBrowser(url.toString());
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier
  };
  try {
    const first = await auth(provider, {
      serverUrl: `${deployment.origin}/api/v1`,
      scope: "memory:read memory:admin"
    });
    if (first !== "REDIRECT") throw new Error("OAuth authorization did not require owner approval");
    const code = await callback.wait;
    const final = await auth(provider, {
      serverUrl: `${deployment.origin}/api/v1`,
      authorizationCode: code,
      scope: "memory:read memory:admin"
    });
    if (final !== "AUTHORIZED" || clientInformation === undefined || tokens === undefined)
      throw new Error("OAuth authorization did not complete");
    await storeAuthorization(stateDirectory, {
      origin: deployment.origin,
      savedAt: new Date().toISOString(),
      clientInformation,
      tokens
    });
    console.log(`Authorized the Wikimemory CLI for ${deployment.origin}`);
  } finally {
    callback.close();
  }
}
