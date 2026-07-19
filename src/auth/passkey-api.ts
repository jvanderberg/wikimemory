import type { TokenSummary } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { DomainError } from "../domain/errors";
import type { Env } from "../env";
import { revokeProductionSessionsForCredentialBestEffort } from "./passkey";
import {
  createRegistrationToken,
  listPasskeys,
  PASSKEY_OWNER_ID,
  requireRecentPasskeyAuthentication,
  revokePasskey
} from "./passkey-management";
import { canonicalMcpResource } from "./resource";

const PROPS_SCHEMA = z.object({
  workspaceId: z.string(),
  principalId: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  authenticatedAt: z.string(),
  credentialId: z.string()
});
const LABEL_SCHEMA = z.object({ label: z.string().trim().min(1).max(80) });
const REVOKE_SCHEMA = z.object({ credentialRef: z.string().regex(/^[a-f0-9]{64}$/u) });

type TokenUnwrapper = (token: string) => Promise<TokenSummary<unknown> | null>;

async function authorize(
  request: Request,
  env: Env,
  unwrapToken: TokenUnwrapper
): Promise<{ authenticatedAt: string; credentialId: string }> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  if (match?.[1] === undefined) throw new DomainError("forbidden", "A bearer token is required");
  const token = await unwrapToken(match[1]);
  if (
    token === null ||
    token.userId !== PASSKEY_OWNER_ID ||
    !token.scope.includes("memory:admin")
  ) {
    throw new DomainError("forbidden", "An owner administrative token is required");
  }
  const props = PROPS_SCHEMA.safeParse(token.grant.props);
  if (!props.success || props.data.principalId !== PASSKEY_OWNER_ID)
    throw new DomainError("forbidden", "The token owner is invalid");
  const expectedAudience = canonicalMcpResource(env.APP_BASE_URL);
  const audiences =
    token.audience === undefined
      ? []
      : Array.isArray(token.audience)
        ? token.audience
        : [token.audience];
  if (!audiences.includes(expectedAudience))
    throw new DomainError("forbidden", "The token audience is invalid");
  const credential = await env.DB.prepare(
    "SELECT 1 AS present FROM passkey_credentials WHERE credential_id = ? AND principal_id = ?"
  )
    .bind(props.data.credentialId, props.data.principalId)
    .first<{ present: number }>();
  if (credential === null)
    throw new DomainError("forbidden", "The authorizing passkey is no longer valid");
  requireRecentPasskeyAuthentication(props.data.authenticatedAt);
  return {
    authenticatedAt: props.data.authenticatedAt,
    credentialId: props.data.credentialId
  };
}

export async function handlePasskeyApi(
  request: Request,
  env: Env,
  unwrapToken: TokenUnwrapper = async (token) =>
    await env.OAUTH_PROVIDER.unwrapToken<unknown>(token)
): Promise<Response> {
  const authorization = await authorize(request, env, unwrapToken);
  if (request.method === "GET") return Response.json({ passkeys: await listPasskeys(env.DB) });
  if (request.method === "POST") {
    const { label } = LABEL_SCHEMA.parse(await request.json());
    const token = await createRegistrationToken(env.DB, label, authorization.credentialId);
    return Response.json({
      registrationUrl: `${new URL("/passkeys/add", request.url).toString()}#${encodeURIComponent(token.rawToken)}`,
      expiresAt: token.expiresAt
    });
  }
  if (request.method === "DELETE") {
    const { credentialRef } = REVOKE_SCHEMA.parse(await request.json());
    const credentialId = await revokePasskey(env.DB, credentialRef);
    const sessionCleanupComplete = await revokeProductionSessionsForCredentialBestEffort(
      env,
      PASSKEY_OWNER_ID,
      credentialId
    );
    return Response.json({ revoked: credentialRef, sessionCleanupComplete });
  }
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { allow: "GET, POST, DELETE" } }
  );
}
