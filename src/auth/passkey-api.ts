import { z } from "zod";
import { DomainError } from "../domain/errors";
import type { Env } from "../env";
import { revokeProductionSessionsForCredential } from "./passkey";
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
  scopes: z.array(z.string())
});
const LABEL_SCHEMA = z.object({ label: z.string().trim().min(1).max(80) });
const REVOKE_SCHEMA = z.object({ credentialRef: z.string().regex(/^[a-f0-9]{64}$/u) });

async function authorize(request: Request, env: Env): Promise<{ authenticatedAt: string }> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  if (match?.[1] === undefined) throw new DomainError("forbidden", "A bearer token is required");
  const token = await env.OAUTH_PROVIDER.unwrapToken(match[1]);
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
  const authenticatedAt = new Date(token.createdAt * 1000).toISOString();
  requireRecentPasskeyAuthentication(authenticatedAt);
  return { authenticatedAt };
}

export async function handlePasskeyApi(request: Request, env: Env): Promise<Response> {
  await authorize(request, env);
  if (request.method === "GET") return Response.json({ passkeys: await listPasskeys(env.DB) });
  if (request.method === "POST") {
    const { label } = LABEL_SCHEMA.parse(await request.json());
    const token = await createRegistrationToken(env.DB, label);
    return Response.json({
      registrationUrl: `${new URL("/passkeys/add", request.url).toString()}#${encodeURIComponent(token.rawToken)}`,
      expiresAt: token.expiresAt
    });
  }
  if (request.method === "DELETE") {
    const { credentialRef } = REVOKE_SCHEMA.parse(await request.json());
    const credentialId = await revokePasskey(env.DB, credentialRef);
    await revokeProductionSessionsForCredential(env, PASSKEY_OWNER_ID, credentialId);
    return Response.json({ revoked: credentialRef });
  }
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { allow: "GET, POST, DELETE" } }
  );
}
