import { accessToken } from "./api-auth.ts";
import { WikimemoryClient } from "./api-client.ts";
import {
  deploymentPaths,
  readDeploymentRecord,
  requireInstalledDeployment
} from "./deployment-record.ts";

export async function localWikimemoryClient(deployment = "wikimemory"): Promise<WikimemoryClient> {
  await requireInstalledDeployment(deployment);
  const paths = deploymentPaths(deployment);
  const record = await readDeploymentRecord(paths.record);
  return new WikimemoryClient(record.origin, await accessToken(paths.directory));
}
