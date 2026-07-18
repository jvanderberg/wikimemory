import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { OAuthError } from "@cloudflare/workers-oauth-provider";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  WebAuthnCredential
} from "@simplewebauthn/server";
import { z } from "zod";
import { sha256 } from "../domain/crypto";
import { DomainError } from "../domain/errors";
import { isMemoryScope } from "../domain/guards";
import { MemoryService } from "../domain/memory-service";
import type { ActorContext, MemoryScope, OwnerContext } from "../domain/types";
import type { Env } from "../env";
import { renderPasskeyAuthorizationPage, renderPasskeySetupPage } from "../web/passkey-pages";
import { bindAuthorizationResource } from "./resource";

const PRINCIPAL_ID = "passkey-owner";
const WORKSPACE_ID = "primary-workspace";
const SESSION_PREFIX = "web-session:";
const FLOW_TTL_SECONDS = 300;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TRANSPORT_SCHEMA = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const ATTACHMENT_SCHEMA = z.enum(["cross-platform", "platform"]);
const AUTH_REQUEST_SCHEMA = z.object({
  responseType: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  scope: z.array(z.string()),
  state: z.string(),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.string().optional(),
  resource: z.union([z.string(), z.array(z.string())]).optional()
});
const REGISTRATION_RESPONSE_SCHEMA = z.object({
  id: z.string().regex(BASE64URL),
  rawId: z.string().regex(BASE64URL),
  response: z.object({
    clientDataJSON: z.string().regex(BASE64URL),
    attestationObject: z.string().regex(BASE64URL),
    authenticatorData: z.string().regex(BASE64URL).optional(),
    transports: z.array(TRANSPORT_SCHEMA).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: z.string().regex(BASE64URL).optional()
  }),
  authenticatorAttachment: ATTACHMENT_SCHEMA.optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  type: z.literal("public-key")
});
const AUTHENTICATION_RESPONSE_SCHEMA = z.object({
  id: z.string().regex(BASE64URL),
  rawId: z.string().regex(BASE64URL),
  response: z.object({
    clientDataJSON: z.string().regex(BASE64URL),
    authenticatorData: z.string().regex(BASE64URL),
    signature: z.string().regex(BASE64URL),
    userHandle: z.string().regex(BASE64URL).optional()
  }),
  authenticatorAttachment: ATTACHMENT_SCHEMA.optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  type: z.literal("public-key")
});
const SETUP_REQUEST_SCHEMA = z.object({ token: z.string().min(32).max(512) });
const SETUP_VERIFY_SCHEMA = z.object({ flowId: z.uuid(), response: REGISTRATION_RESPONSE_SCHEMA });
const AUTH_VERIFY_SCHEMA = z.object({ flowId: z.uuid(), response: AUTHENTICATION_RESPONSE_SCHEMA });
const TRANSPORTS_SCHEMA = z.array(TRANSPORT_SCHEMA);

interface CredentialRow {
  credential_id: string;
  public_key: string;
  counter: number;
  transports_json: string;
  device_type: "singleDevice" | "multiDevice";
  backed_up: number;
}

interface SessionRecord {
  principalId: string;
  workspaceId: string;
  authenticatedAt: string;
  createdAt: string;
}

interface ChallengeRow {
  challenge: string;
  payload_json: string | null;
  token_hash: string | null;
}

export interface WebSessionSummary {
  sessionRef: string;
  authenticatedAt: string;
  createdAt: string;
  current: boolean;
}

type RelyingPartyEnv = Pick<Env, "APP_BASE_URL">;
type SetupEnv = Pick<Env, "DB" | "APP_BASE_URL" | "SETUP_TOKEN_HASH">;
type DatabaseEnv = Pick<Env, "DB">;

function relyingParty(env: RelyingPartyEnv): { origin: string; rpID: string } {
  if (env.APP_BASE_URL === undefined) throw new Error("APP_BASE_URL is required");
  const url = new URL(env.APP_BASE_URL);
  return { origin: url.origin, rpID: url.hostname };
}

function mcpResource(env: Env): string {
  return new URL("/mcp", relyingParty(env).origin).toString();
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) throw new DomainError("validation_failed", "Invalid passkey encoding");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function scopes(auth: AuthRequest): MemoryScope[] {
  const requested = auth.scope.length === 0 ? ["memory:read", "memory:write"] : auth.scope;
  if (!requested.every((scope): scope is MemoryScope => isMemoryScope(scope))) {
    throw new OAuthError("invalid_scope", { description: "Unsupported Wikimemory scope" });
  }
  return requested;
}

function actor(clientId = "wikimemory-web"): ActorContext {
  return {
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    clientId,
    scopes: new Set(["memory:read", "memory:write", "memory:admin"]),
    requestId: crypto.randomUUID()
  };
}

async function ensureOwner(env: DatabaseEnv): Promise<void> {
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO principals
      (id, provider, provider_subject, email, email_verified, display_name, created_at)
      VALUES (?, 'passkey', ?, NULL, 0, 'Wikimemory Owner', ?)`).bind(PRINCIPAL_ID, PRINCIPAL_ID, createdAt),
    env.DB.prepare("INSERT OR IGNORE INTO workspaces(id, name, created_at) VALUES (?, 'Wikimemory', ?)").bind(WORKSPACE_ID, createdAt),
    env.DB.prepare(`INSERT OR IGNORE INTO memberships(workspace_id, principal_id, role, created_at)
      VALUES (?, ?, 'owner', ?)`).bind(WORKSPACE_ID, PRINCIPAL_ID, createdAt)
  ]);
  const service = new MemoryService(env.DB);
  const owner = actor("wikimemory-passkey-seed");
  await service.ingest(owner, {
    operationId: "seed-home-v1", reason: "seed orientation", slug: "home", type: "system",
    title: "Wikimemory home", summary: "Standard orientation page.",
    body: "# Wikimemory\n\nThe database is authoritative. See [[now]] for current focus."
  });
  await service.ingest(owner, {
    operationId: "seed-now-v1", reason: "seed current focus", slug: "now", type: "system",
    title: "Now", summary: "Current focus and active threads.",
    body: "# Now\n\n_(No active work has been recorded yet.)_"
  });
}

export function setupPage(): Response {
  return renderPasskeySetupPage();
}

async function credentialRows(env: DatabaseEnv): Promise<CredentialRow[]> {
  const result = await env.DB.prepare(`SELECT credential_id, public_key, counter, transports_json, device_type, backed_up
    FROM passkey_credentials WHERE principal_id = ? ORDER BY created_at`).bind(PRINCIPAL_ID).all<CredentialRow>();
  return result.results;
}

function transports(value: string): AuthenticatorTransportFuture[] {
  return TRANSPORTS_SCHEMA.parse(JSON.parse(value));
}

function expiry(): string {
  return new Date(Date.now() + FLOW_TTL_SECONDS * 1000).toISOString();
}

function passkeyUserId(): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(PRINCIPAL_ID);
  const copied = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copied.set(encoded);
  return copied;
}

async function consumeChallenge(env: DatabaseEnv, flowId: string, kind: "setup" | "mcp" | "web"): Promise<ChallengeRow | null> {
  return await env.DB.prepare(`DELETE FROM passkey_challenges
    WHERE flow_id = ? AND kind = ? AND expires_at > ?
    RETURNING challenge, payload_json, token_hash`).bind(flowId, kind, new Date().toISOString()).first<ChallengeRow>();
}

function authRequest(value: z.infer<typeof AUTH_REQUEST_SCHEMA>): AuthRequest {
  return {
    responseType: value.responseType,
    clientId: value.clientId,
    redirectUri: value.redirectUri,
    scope: value.scope,
    state: value.state,
    ...(value.codeChallenge === undefined ? {} : { codeChallenge: value.codeChallenge }),
    ...(value.codeChallengeMethod === undefined ? {} : { codeChallengeMethod: value.codeChallengeMethod }),
    ...(value.resource === undefined ? {} : { resource: value.resource })
  };
}

function registrationResponseJson(value: z.infer<typeof REGISTRATION_RESPONSE_SCHEMA>): RegistrationResponseJSON {
  return {
    id: value.id,
    rawId: value.rawId,
    type: value.type,
    clientExtensionResults: value.clientExtensionResults,
    ...(value.authenticatorAttachment === undefined ? {} : { authenticatorAttachment: value.authenticatorAttachment }),
    response: {
      clientDataJSON: value.response.clientDataJSON,
      attestationObject: value.response.attestationObject,
      ...(value.response.authenticatorData === undefined ? {} : { authenticatorData: value.response.authenticatorData }),
      ...(value.response.transports === undefined ? {} : { transports: value.response.transports }),
      ...(value.response.publicKeyAlgorithm === undefined ? {} : { publicKeyAlgorithm: value.response.publicKeyAlgorithm }),
      ...(value.response.publicKey === undefined ? {} : { publicKey: value.response.publicKey })
    }
  };
}

function authenticationResponseJson(value: z.infer<typeof AUTHENTICATION_RESPONSE_SCHEMA>): AuthenticationResponseJSON {
  return {
    id: value.id,
    rawId: value.rawId,
    type: value.type,
    clientExtensionResults: value.clientExtensionResults,
    ...(value.authenticatorAttachment === undefined ? {} : { authenticatorAttachment: value.authenticatorAttachment }),
    response: {
      clientDataJSON: value.response.clientDataJSON,
      authenticatorData: value.response.authenticatorData,
      signature: value.response.signature,
      ...(value.response.userHandle === undefined ? {} : { userHandle: value.response.userHandle })
    }
  };
}

export async function setupOptions(request: Request, env: SetupEnv): Promise<Response> {
  const body = SETUP_REQUEST_SCHEMA.parse(await request.json());
  const tokenHash = await sha256(body.token);
  if (env.SETUP_TOKEN_HASH === undefined || tokenHash !== env.SETUP_TOKEN_HASH) {
    return Response.json({ error: "This setup link is invalid or expired." }, { status: 403 });
  }
  const used = await env.DB.prepare("SELECT 1 AS present FROM passkey_bootstrap WHERE used_token_hash = ?").bind(tokenHash).first<{ present: number }>();
  if (used !== null) return Response.json({ error: "This setup link has already been used." }, { status: 409 });
  const existing = await credentialRows(env);
  const { rpID } = relyingParty(env);
  const options = await generateRegistrationOptions({
    rpName: "Wikimemory",
    rpID,
    userName: "owner",
    userID: passkeyUserId(),
    userDisplayName: "Wikimemory Owner",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: transports(row.transports_json) }))
  });
  const flowId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM passkey_challenges WHERE expires_at <= ?").bind(new Date().toISOString()),
    env.DB.prepare(`INSERT INTO passkey_challenges(flow_id, kind, challenge, token_hash, expires_at)
      VALUES (?, 'setup', ?, ?, ?)`).bind(flowId, options.challenge, tokenHash, expiry())
  ]);
  return Response.json({ flowId, options });
}

export async function setupVerify(request: Request, env: SetupEnv): Promise<Response> {
  const body = SETUP_VERIFY_SCHEMA.parse(await request.json());
  const flow = await consumeChallenge(env, body.flowId, "setup");
  if (flow === null) return Response.json({ error: "This setup attempt expired or was already used." }, { status: 410 });
  if (env.SETUP_TOKEN_HASH === undefined || flow.token_hash !== env.SETUP_TOKEN_HASH) {
    return Response.json({ error: "This setup link expired after a configuration change." }, { status: 403 });
  }
  const used = await env.DB.prepare("SELECT 1 AS present FROM passkey_bootstrap WHERE used_token_hash = ?").bind(flow.token_hash).first<{ present: number }>();
  if (used !== null) return Response.json({ error: "This setup link has already been used." }, { status: 409 });
  const { origin, rpID } = relyingParty(env);
  const registrationResponse = registrationResponseJson(body.response);
  const verification = await verifyRegistrationResponse({
    response: registrationResponse,
    expectedChallenge: flow.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257]
  });
  if (!verification.verified) return Response.json({ error: "Passkey verification failed." }, { status: 403 });
  await ensureOwner(env);
  const now = new Date().toISOString();
  const credential = verification.registrationInfo.credential;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO passkey_credentials
        (credential_id, principal_id, public_key, counter, transports_json, device_type, backed_up, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          credential.id, PRINCIPAL_ID, base64UrlEncode(credential.publicKey), credential.counter,
          JSON.stringify(credential.transports ?? []), verification.registrationInfo.credentialDeviceType,
          verification.registrationInfo.credentialBackedUp ? 1 : 0, now
        ),
      env.DB.prepare("INSERT INTO passkey_bootstrap(used_token_hash, completed_at) VALUES (?, ?)").bind(flow.token_hash, now)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("passkey_bootstrap.used_token_hash")) {
      return Response.json({ error: "This setup link has already been used." }, { status: 409 });
    }
    throw error;
  }
  return Response.json({ ok: true });
}

export async function beginPasskeyAuthorization(request: Request, env: Env, kind: "mcp" | "web"): Promise<Response> {
  const parsedAuth = kind === "mcp" ? await env.OAUTH_PROVIDER.parseAuthRequest(request) : undefined;
  const auth = parsedAuth === undefined ? undefined : bindAuthorizationResource(parsedAuth, mcpResource(env));
  const requestedScopes = auth === undefined ? undefined : scopes(auth);
  const client = auth === undefined ? null : await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
  const credentials = await credentialRows(env);
  if (credentials.length === 0) return new Response("Wikimemory has not been set up. Use the one-time setup URL from the installer.", { status: 503 });
  const { rpID } = relyingParty(env);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: credentials.map((row) => ({ id: row.credential_id, transports: transports(row.transports_json) }))
  });
  const flowId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM passkey_challenges WHERE expires_at <= ?").bind(new Date().toISOString()),
    env.DB.prepare(`INSERT INTO passkey_challenges(flow_id, kind, challenge, payload_json, expires_at)
      VALUES (?, ?, ?, ?, ?)`).bind(flowId, kind, options.challenge, auth === undefined ? null : JSON.stringify(auth), expiry())
  ]);
  return renderPasskeyAuthorizationPage({
    flowId,
    options,
    kind,
    ...(client?.clientName === undefined && client?.clientId === undefined ? {} : { clientName: client.clientName ?? client.clientId }),
    ...(requestedScopes === undefined ? {} : { requestedScopes })
  });
}

export async function verifyPasskeyAuthorization(request: Request, env: Env): Promise<Response> {
  const body = AUTH_VERIFY_SCHEMA.parse(await request.json());
  const mcpFlow = await consumeChallenge(env, body.flowId, "mcp");
  const flowKind = mcpFlow === null ? "web" : "mcp";
  const flow = mcpFlow ?? await consumeChallenge(env, body.flowId, "web");
  if (flow === null) return Response.json({ error: "This authentication attempt expired or was already used." }, { status: 410 });
  const row = await env.DB.prepare(`SELECT credential_id, public_key, counter, transports_json, device_type, backed_up
    FROM passkey_credentials WHERE credential_id = ? AND principal_id = ?`).bind(body.response.id, PRINCIPAL_ID).first<CredentialRow>();
  if (row === null) return Response.json({ error: "Unknown passkey." }, { status: 403 });
  const credential: WebAuthnCredential = {
    id: row.credential_id,
    publicKey: base64UrlDecode(row.public_key),
    counter: row.counter,
    transports: transports(row.transports_json)
  };
  const { origin, rpID } = relyingParty(env);
  const authenticationResponse = authenticationResponseJson(body.response);
  const verification = await verifyAuthenticationResponse({
    response: authenticationResponse,
    expectedChallenge: flow.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: true
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified) return Response.json({ error: "Passkey verification failed." }, { status: 403 });
  const authenticatedAt = new Date().toISOString();
  const updated = await env.DB.prepare(`UPDATE passkey_credentials SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ?
    WHERE credential_id = ? AND counter = ?`).bind(
      verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialDeviceType,
      verification.authenticationInfo.credentialBackedUp ? 1 : 0, authenticatedAt, row.credential_id, row.counter
    ).run();
  if (updated.meta.changes !== 1) return Response.json({ error: "This passkey assertion was already used." }, { status: 409 });
  if (flowKind === "mcp") {
    if (flow.payload_json === null) throw new OAuthError("invalid_request", { description: "MCP authorization state is missing" });
    const auth = bindAuthorizationResource(authRequest(AUTH_REQUEST_SCHEMA.parse(JSON.parse(flow.payload_json))), mcpResource(env));
    const granted = scopes(auth);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: auth,
      userId: PRINCIPAL_ID,
      metadata: { identity: "passkey" },
      scope: granted,
      props: { workspaceId: WORKSPACE_ID, principalId: PRINCIPAL_ID, clientId: auth.clientId, scopes: granted }
    });
    return Response.json({ redirectTo });
  }
  const sessionId = crypto.randomUUID();
  const session = { principalId: PRINCIPAL_ID, workspaceId: WORKSPACE_ID, authenticatedAt, createdAt: authenticatedAt } satisfies SessionRecord;
  await env.OAUTH_KV.put(await sessionStorageKey(sessionId), JSON.stringify(session), { expirationTtl: 86_400 });
  return Response.json({ redirectTo: "/app" }, { headers: { "set-cookie": `wm_web_session=${sessionId}; HttpOnly; Secure; Path=/app; SameSite=Lax; Max-Age=86400` } });
}

async function sessionStorageKey(sessionId: string): Promise<string> {
  return `${SESSION_PREFIX}${await sha256(sessionId)}`;
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie === undefined ? null : cookie.slice(name.length + 1);
}

export async function productionWebOwner(request: Request, env: Env): Promise<OwnerContext | null> {
  const sessionId = cookieValue(request, "wm_web_session");
  if (sessionId === null) return null;
  const raw = await env.OAUTH_KV.get(await sessionStorageKey(sessionId), "json");
  const parsed = z.object({ principalId: z.string(), workspaceId: z.string(), authenticatedAt: z.string(), createdAt: z.string() }).safeParse(raw);
  if (!parsed.success || parsed.data.principalId !== PRINCIPAL_ID || parsed.data.workspaceId !== WORKSPACE_ID) return null;
  return { ...actor(), role: "owner", reauthenticatedAt: parsed.data.authenticatedAt };
}

export async function endProductionWebSession(request: Request, env: Env): Promise<void> {
  const sessionId = cookieValue(request, "wm_web_session");
  if (sessionId !== null) await env.OAUTH_KV.delete(await sessionStorageKey(sessionId));
}

export async function listProductionWebSessions(request: Request, env: Env, principalId: string): Promise<WebSessionSummary[]> {
  const currentId = cookieValue(request, "wm_web_session");
  const currentKey = currentId === null ? null : await sessionStorageKey(currentId);
  const keys = await env.OAUTH_KV.list({ prefix: SESSION_PREFIX, limit: 100 });
  const sessions = await Promise.all(keys.keys.map(async ({ name }) => {
    const raw = await env.OAUTH_KV.get(name, "json");
    const parsed = z.object({ principalId: z.string(), workspaceId: z.string(), authenticatedAt: z.string(), createdAt: z.string() }).safeParse(raw);
    if (!parsed.success || parsed.data.principalId !== principalId) return null;
    return { sessionRef: name.slice(SESSION_PREFIX.length), authenticatedAt: parsed.data.authenticatedAt, createdAt: parsed.data.createdAt, current: name === currentKey } satisfies WebSessionSummary;
  }));
  return sessions.filter((session): session is WebSessionSummary => session !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeProductionWebSession(env: Env, principalId: string, sessionRef: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(sessionRef)) throw new DomainError("validation_failed", "Invalid session reference");
  const key = `${SESSION_PREFIX}${sessionRef}`;
  const raw = await env.OAUTH_KV.get(key, "json");
  const parsed = z.object({ principalId: z.string() }).safeParse(raw);
  if (!parsed.success || parsed.data.principalId !== principalId) throw new DomainError("not_found", "Browser session not found");
  await env.OAUTH_KV.delete(key);
}
