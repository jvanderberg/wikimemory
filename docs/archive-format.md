# Wikimemory ZIP archive

`.wmem.zip` is a portable content backup and a normal browsable ZIP:

```text
manifest.json
documents.json
content/system/*.md
content/projects/{project}/index.md
content/projects/{project}/{notes,topics,sources}/*.md
content/unfiled/{notes,topics,sources}/*.md
history/{slug}/{revision-number}.md
```

`manifest.json` is first. `formatVersion` governs compatibility;
`createdBy.wikimemoryVersion` identifies the producer, while database schema version is
diagnostic. Every included file has a SHA-256 checksum. The manifest contract is
[`archive-manifest-v1.schema.json`](schemas/archive-manifest-v1.schema.json).

The `content` tree is the current human-readable view. Type and primary `project`
metadata determine directories; remaining metadata and links are YAML frontmatter.
`history` contains every immutable revision. `documents.json` preserves identities.

Archives exclude passkeys, OAuth tokens, sessions, provider identities, and private
principal/client IDs. Operational audit events and purge tombstones remain available
in the legacy JSONL export but are not restored by this content archive. Import rejects
unsafe paths, excessive expansion, malformed YAML, invalid history, identity/count
mismatches, and checksum failures.

```sh
npx wikimemory api login --deployment NAME
npx wikimemory backup create --deployment NAME --output backup.wmem.zip
npx wikimemory backup inspect backup.wmem.zip
npx wikimemory backup verify backup.wmem.zip
npx wikimemory restore --deployment NAME backup.wmem.zip
```

Restore is resumable and idempotent when existing identities and revisions match. It
stops on conflict rather than rewriting history.

A newly installed instance already contains starter documents. To replace everything
in a target with the archive, use `restore FILE --replace`. Wikimemory asks you to type
the Worker name before permanently deleting the target's existing documents. For a
non-interactive restore, also pass `--confirm WORKER_NAME`.
