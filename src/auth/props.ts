import { getMcpAuthContext } from "agents/mcp";
import { DomainError } from "../domain/errors";
import { isMemoryScope } from "../domain/guards";
import type { ActorContext, MemoryScope } from "../domain/types";

export interface AuthProps extends Record<string, unknown> {
  workspaceId: string;
  principalId: string;
  clientId: string;
  agentLabel?: string;
  scopes: MemoryScope[];
}

export function actorFromMcp(): ActorContext {
  const context = getMcpAuthContext();
  const props = context?.props;
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
