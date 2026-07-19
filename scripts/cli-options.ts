import { deploymentPaths } from "./deployment-record.ts";

export function deploymentArguments(args: string[]): { deployment: string; remaining: string[] } {
  let deployment = "wikimemory";
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
    } else if (argument !== undefined) remaining.push(argument);
  }
  return { deployment, remaining };
}

export function installArguments(deployment: string, args: string[]): string[] {
  const result = [...args];
  if (!result.includes("--worker-name")) result.push("--worker-name", deployment);
  if (!result.includes("--database-name")) result.push("--database-name", deployment);
  if (!result.includes("--kv-name")) result.push("--kv-name", `${deployment}-oauth`);
  return result;
}
