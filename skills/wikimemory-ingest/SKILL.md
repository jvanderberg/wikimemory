---
name: wikimemory-ingest
description: Store durable decisions, findings, project status, and reusable technical context in a Wikimemory MCP after meaningful work or when the user asks to remember something.
---

# Wikimemory Ingest

Store conclusions that will help a future session. Do not store scratch work, routine command output, chat transcripts, credentials, access tokens, private keys, or suspected secrets.

## Workflow

1. Use `recall` before writing to find an existing document and avoid duplicates.
   For a source with a canonical URL, call exact `sourceUrl` recall before text recall.
2. Choose a stable lowercase slug. Prefer updating the canonical project, decision, research, source, or system page over creating a near-duplicate.
3. For an update, call `get`, preserve relevant content, and pass its current revision ID as `expectedRevisionId`.
4. Call `ingest` with a fresh unique operation ID and a specific reason. Use a UUID when readily available, but any stable caller-generated string up to 200 characters is valid. Supply the optional agent label only as provenance, never as identity.
5. If the service reports a conflict, reread the current revision, merge deliberately, and retry with a new operation ID. Never overwrite blindly.
6. Report the saved slug and revision to the user.

If this workflow created the wrong page, use `archive` with that page's current
revision ID and a fresh operation ID. Archive preserves content and history; it is
not permanent deletion.

Keep summaries compact and metadata structured. Put custom scalar fields such as
`author` and `published` in `singletonMetadata`; use `tags` for multivalued tags. Use
links for explicit relationships. Record uncertain claims as uncertain and preserve
source attribution. A repeated call with the same operation ID must contain the
identical request; otherwise create a new operation ID.
