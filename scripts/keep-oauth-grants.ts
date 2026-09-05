import { setupRuntime } from "./lifecycle-runtime.ts";
import { keepOAuthGrants, keptSummary } from "./oauth-grants.ts";

const kept = await keepOAuthGrants(["--config", setupRuntime.config]);
console.log(keptSummary(kept));
