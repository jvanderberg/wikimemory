import { deploymentPaths } from "./deployment-record.ts";

export function deploymentArguments(args: string[]): {
  deployment: string;
  local: boolean;
  remaining: string[];
} {
  let deployment = "wikimemory";
  let local = false;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--deployment") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error("--deployment requires a value");
      deploymentPaths(value);
      deployment = value;
      index += 1;
    } else if (argument === "--local") {
      local = true;
    } else if (argument !== undefined) remaining.push(argument);
  }
  if (local && deployment !== "wikimemory")
    throw new Error("--local cannot be combined with --deployment");
  return { deployment, local, remaining };
}

export function installArguments(deployment: string, args: string[]): string[] {
  const result = [...args];
  if (!result.includes("--worker-name")) result.push("--worker-name", deployment);
  if (!result.includes("--database-name")) result.push("--database-name", deployment);
  if (!result.includes("--kv-name")) result.push("--kv-name", `${deployment}-oauth`);
  return result;
}
