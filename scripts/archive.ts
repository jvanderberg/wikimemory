import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createArchive, readArchive } from "../src/archive/format.ts";
import { restoreArchive } from "../src/archive/restore.ts";
import type { DocumentSnapshot } from "../src/domain/types.ts";
import { LATEST_SCHEMA_VERSION } from "../src/version.ts";
import { accessToken } from "./api-auth.ts";
import { WikimemoryClient } from "./api-client.ts";
import { readDeploymentRecord } from "./deployment-record.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function restoreOptions(args: string[]): { file: string; replace: boolean; confirm?: string } {
  let file: string | undefined;
  let replace = false;
  let confirm: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--replace") replace = true;
    else if (argument === "--confirm") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error("--confirm requires a value");
      confirm = value;
      index += 1;
    } else if (argument?.startsWith("--")) throw new Error(`Unknown restore option: ${argument}`);
    else if (argument !== undefined && file === undefined) file = argument;
    else if (argument !== undefined) throw new Error(`Unexpected restore argument: ${argument}`);
  }
  if (file === undefined) throw new Error("Restore requires an archive file");
  return { file, replace, ...(confirm === undefined ? {} : { confirm }) };
}
async function client(origin: string, stateDirectory: string): Promise<WikimemoryClient> {
  return new WikimemoryClient(origin, await accessToken(stateDirectory));
}
export async function createBackup(
  deploymentRecord: string,
  stateDirectory: string,
  args: string[]
): Promise<void> {
  const record = await readDeploymentRecord(deploymentRecord);
  const api = await client(record.origin, stateDirectory);
  const documents = await api.listDocuments();
  const revisions: DocumentSnapshot[] = [];
  for (let offset = 0; offset < documents.length; offset += 8) {
    const histories = await Promise.all(
      documents.slice(offset, offset + 8).map((document) => api.listRevisions(document.slug))
    );
    revisions.push(...histories.flat());
  }
  const bytes = await createArchive(documents, revisions, LATEST_SCHEMA_VERSION);
  const date = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/u, "Z");
  const output = resolve(option(args, "--output") ?? `wikimemory-${date}.wmem.zip`);
  await writeFile(output, bytes, { mode: 0o600, flag: "wx" });
  console.log(
    `Created ${output}\n  Documents: ${documents.length}\n  Revisions: ${revisions.length}`
  );
}
export async function inspectBackup(file: string): Promise<void> {
  const archive = await readArchive(await readFile(resolve(file)));
  console.log(
    `${basename(file)}\n  Format: ${archive.manifest.formatVersion}\n  Created by: Wikimemory ${archive.manifest.createdBy.wikimemoryVersion}\n  Documents: ${archive.documents.length}\n  Revisions: ${archive.revisions.length}\n  Checksums: valid`
  );
}
export type { ArchiveApi } from "../src/archive/restore.ts";
export { restoreArchive } from "../src/archive/restore.ts";
export async function restoreBackup(
  deploymentRecord: string,
  stateDirectory: string,
  args: string[]
): Promise<void> {
  const { file, replace, confirm } = restoreOptions(args);
  if (!replace && confirm !== undefined)
    throw new Error("--confirm can only be used with --replace");
  const record = await readDeploymentRecord(deploymentRecord);
  const archive = await readArchive(await readFile(resolve(file)));
  if (replace && confirm !== record.workerName) {
    if (!process.stdin.isTTY)
      throw new Error(`Replacement requires --confirm ${record.workerName}`);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(
      `This permanently deletes every document in “${record.workerName}” before restore. Type ${record.workerName} to continue: `
    );
    prompt.close();
    if (answer.trim() !== record.workerName) throw new Error("Restore cancelled");
  }
  const api = await client(record.origin, stateDirectory);
  const imported = await restoreArchive(api, archive, replace);
  console.log(
    `Restored ${basename(file)}\n  Documents: ${archive.documents.length}\n  New revisions: ${imported}`
  );
}
