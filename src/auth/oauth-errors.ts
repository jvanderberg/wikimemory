export interface OAuthErrorDetails {
  code: string;
  description: string;
  status: number;
  headers: Record<string, string>;
}

const RECOVERABLE_AUTH_CODES = new Set(["invalid_token", "invalid_grant", "invalid_client"]);

export const AUTH_RECOVERY_DESCRIPTION =
  "Wikimemory authentication is unavailable. Tell the user to reauthorize the Wikimemory MCP connection, then retry the original request; repeated retries without reauthorization will not fix it.";

function actionableChallenge(challenge: string): string {
  const withoutDescription = challenge.replace(/,\s*error_description="[^"]*"/gu, "");
  return `${withoutDescription}, error_description="${AUTH_RECOVERY_DESCRIPTION}"`;
}

export function wikimemoryOAuthErrorResponse(error: OAuthErrorDetails): Response | undefined {
  if (!RECOVERABLE_AUTH_CODES.has(error.code)) return undefined;

  const headers = new Headers(error.headers);
  headers.set("content-type", "application/json");
  const challenge = headers.get("www-authenticate");
  if (challenge !== null) headers.set("www-authenticate", actionableChallenge(challenge));

  return Response.json(
    {
      error: error.code,
      error_description: AUTH_RECOVERY_DESCRIPTION,
      recovery: {
        action: "reauthorize",
        retry: "after_reauthorization",
        userMessage: "Reconnect Wikimemory, then ask the agent to retry the original request.",
        defaultClientCommands: {
          codex: [
            "codex mcp logout wikimemory",
            "codex mcp login wikimemory --scopes memory:read,memory:write"
          ],
          claudeCode: ["claude mcp logout wikimemory", "claude mcp login wikimemory"]
        },
        hostedClients: "Reconnect Wikimemory in the client's connector settings."
      }
    },
    { status: error.status, headers }
  );
}
