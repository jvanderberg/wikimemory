import { AdminService } from "../domain/admin-service";
import { DomainError } from "../domain/errors";
import { MemoryService } from "../domain/memory-service";
import type { OwnerContext } from "../domain/types";
import type { Env } from "../env";
import { LATEST_SCHEMA_VERSION } from "../version";
import { createArchive, readArchive, type WikimemoryArchive } from "./format";
import type { ArchiveApi } from "./restore";

export function restoreConfirmation(env: Env, requestUrl: string): string {
  if (env.APP_ENV === "local") return "wikimemory-local";
  const hostname = new URL(env.APP_BASE_URL ?? requestUrl).hostname;
  return hostname.split(".")[0] ?? hostname;
}

export function webArchiveApi(env: Env, context: OwnerContext): ArchiveApi {
  const admin = new AdminService(env.DB);
  const memory = new MemoryService(env.DB);
  return {
    async listDocuments() {
      const documents = [];
      let after: string | null = null;
      for (;;) {
        const page = await admin.listDocuments(context, after, 100);
        documents.push(...page);
        if (page.length < 100) return documents;
        after = page.at(-1)?.slug ?? null;
      }
    },
    async createDocument(input) {
      return await admin.createDocument(context, input);
    },
    async listRevisions(slug) {
      const revisions = [];
      let after = 0;
      for (;;) {
        const page = await admin.listRevisions(context, slug, after, 100);
        revisions.push(...page);
        if (page.length < 100) return revisions;
        after = page.at(-1)?.revisionNumber ?? after;
      }
    },
    async appendRevision(slug, input) {
      return await admin.appendRevision(context, slug, input);
    },
    async deleteDocument(slug) {
      const authorization = await memory.authorizePurge(context, slug, slug);
      await memory.purge(context, authorization.id, slug);
    }
  };
}

export async function archiveForOwner(env: Env, context: OwnerContext): Promise<Uint8Array> {
  const api = webArchiveApi(env, context);
  const documents = await api.listDocuments();
  const revisions = (
    await Promise.all(documents.map((item) => api.listRevisions(item.slug)))
  ).flat();
  return await createArchive(documents, revisions, LATEST_SCHEMA_VERSION);
}

export async function uploadedArchive(request: Request): Promise<{
  archive: WikimemoryArchive;
  form: FormData;
}> {
  try {
    const form = await request.formData();
    const file = form.get("backup");
    if (!(file instanceof File)) throw new DomainError("validation_failed", "Choose a backup file");
    return { archive: await readArchive(new Uint8Array(await file.arrayBuffer())), form };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const detail = error instanceof Error ? error.message.slice(0, 300) : "Unknown archive error";
    throw new DomainError("validation_failed", `Backup is invalid: ${detail}`);
  }
}
