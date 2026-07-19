import type {
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult
} from "@cloudflare/workers-oauth-provider";
import { getMcpAuthContext } from "agents/mcp";
import { z } from "zod";
import { DomainError } from "../domain/errors";
import { isMemoryScope } from "../domain/guards";
import type { ActorContext, MemoryScope } from "../domain/types";
import type { Env } from "../env";

export interface AuthProps extends Record<string, unknown> {
  workspaceId: string;
  principalId: string;
  clientId: string;
  agentLabel?: string;
  authenticatedAt?: string;
  credentialId?: string;
  scopes: MemoryScope[];
}

const AUTH_PROPS_SCHEMA = z.object({
  workspaceId: z.string(),
  principalId: z.string(),
  clientId: z.string(),
  agentLabel: z.string().optional(),
  authenticatedAt: z.string().optional(),
  credentialId: z.string().optional(),
  scopes: z.array(z.enum(["memory:read", "memory:write", "memory:admin"]))
});

export function downscopeAccessToken(
  options: TokenExchangeCallbackOptions
): TokenExchangeCallbackResult {
  const props = AUTH_PROPS_SCHEMA.parse(options.props);
  const requestedScopes = z
    .array(z.enum(["memory:read", "memory:write", "memory:admin"]))
    .parse(options.requestedScope);
  const accessTokenProps: AuthProps = {
    workspaceId: props.workspaceId,
    principalId: props.principalId,
    clientId: props.clientId,
    scopes: requestedScopes,
    ...(props.agentLabel === undefined ? {} : { agentLabel: props.agentLabel }),
    ...(props.authenticatedAt === undefined ? {} : { authenticatedAt: props.authenticatedAt }),
    ...(props.credentialId === undefined ? {} : { credentialId: props.credentialId })
  };
  return {
    accessTokenProps,
    accessTokenScope: requestedScopes
  };
}

export async function actorFromAuthorization(
  props: Record<string, unknown> | undefined,
  env: Pick<Env, "APP_ENV" | "DB">
): Promise<ActorContext> {
  if (
    props === undefined ||
    typeof props["workspaceId"] !== "string" ||
    typeof props["principalId"] !== "string" ||
    typeof props["clientId"] !== "string" ||
    !Array.isArray(props["scopes"]) ||
    !props["scopes"].every(
      (scope): scope is MemoryScope => typeof scope === "string" && isMemoryScope(scope)
    )
  ) {
    throw new DomainError("forbidden", "Missing or invalid MCP authorization context");
  }
  if (env.APP_ENV === "production") {
    const credentialId = props["credentialId"];
    if (typeof credentialId !== "string")
      throw new DomainError("forbidden", "The authorizing passkey is no longer valid");
    const credential = await env.DB.prepare(
      "SELECT 1 AS present FROM passkey_credentials WHERE credential_id = ? AND principal_id = ?"
    )
      .bind(credentialId, props["principalId"])
      .first<{ present: number }>();
    if (credential === null)
      throw new DomainError("forbidden", "The authorizing passkey is no longer valid");
  }
  const scopes = new Set(props["scopes"]);
  const agentLabel = typeof props["agentLabel"] === "string" ? props["agentLabel"] : undefined;
  return {
    workspaceId: props["workspaceId"],
    principalId: props["principalId"],
    clientId: props["clientId"],
    ...(agentLabel === undefined ? {} : { agentLabel }),
    scopes,
    requestId: crypto.randomUUID()
  };
}

export async function actorFromMcp(env: Pick<Env, "APP_ENV" | "DB">): Promise<ActorContext> {
  return await actorFromAuthorization(getMcpAuthContext()?.props, env);
}
