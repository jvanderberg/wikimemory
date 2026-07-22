import type { Env } from "../env";

export function restoreConfirmation(env: Env, requestUrl: string): string {
  if (env.APP_ENV === "local") return "wikimemory-local";
  const hostname = new URL(env.APP_BASE_URL ?? requestUrl).hostname;
  return hostname.split(".")[0] ?? hostname;
}
