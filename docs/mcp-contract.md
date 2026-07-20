# MCP contract

## Transport and authorization

The endpoint and canonical resource URI are `https://<worker-host>/mcp` using
Streamable HTTP. It supports the current MCP protocol version selected by the pinned
SDK and rejects unsupported versions cleanly. An unauthenticated request returns 401
with `WWW-Authenticate` pointing to protected-resource metadata. Authorization and
token requests validate an exact RFC 8707 `resource` value matching that URI.

Wikimemory supports Dynamic Client Registration and explicitly pre-registered client
IDs. Client ID Metadata Documents are deferred until their SSRF-safe fetch behavior
is verified on the chosen Cloudflare library/runtime. Codex and Claude acceptance
checks cover automatic DCR plus their supported explicit-client configuration.

Normal agent connections request `memory:read memory:write`. An administrative MCP
connection explicitly requests `memory:read memory:write memory:admin`; Wikimemory
does not rely on incremental scope challenges.

All tools return a short human-readable content item plus equivalent structured
content. Read tools never copy stored titles, bodies, summaries, snippets, or
revision reasons into the free-form text item. Stored prose appears only in named
structured fields, and read envelopes containing it carry
`storedContentTrust: "untrusted"`. Error results contain a stable `code`, a safe
message, and code-specific fields. They never echo secret candidates or OAuth
material.

## Tools

### `orient` — `memory:read`, read-only

Returns the current `now` page, active project summaries, recent revision summaries,
and lint counts in a bounded response.

Input: none.

### `recall` — `memory:read`, read-only

Searches current content. Input provides exactly one of a text `query` or a canonical
`sourceUrl`, plus an optional limit. Exact source-URL lookup uses indexed current
metadata and is the preferred duplicate check before ingesting a source. Common
tracking parameters, fragments, default ports, and non-root trailing slashes are
normalized on write and lookup. Output includes ranked slug/type/title/summary
snippets, revision ID, and a normalized 0–1 relevance score. The response marks all
stored result fields as untrusted.
Text queries are safe tokenized plain text: quotes, `OR`, and leading minus have no
operator meaning. Exact titles and contiguous token phrases receive deterministic
boosts over repetitive term frequency. Symbol-only queries use a bounded literal
fallback so stored emoji can be recalled. Results use deterministic document-ID
tie-breaking within one response.

### `get` — `memory:read`, read-only

Gets one current or historical revision. Input: slug, optional revision ID, opaque
cursor, and maximum characters (up to 32,768 Unicode code points). Output separates
trusted server metadata from the requested Markdown chunk and includes an opaque
continuation cursor. Chunks are Unicode code-point safe and prefer a nearby
whitespace boundary; an unbroken token may still be split to preserve the hard
response bound. Link target
slugs are immutable revision data, while a previously unresolved `targetDocumentId`
is resolved dynamically when the target now exists. The output explicitly reports
`linkResolution: "current_workspace_state"`; this means historical link IDs are not
a point-in-time snapshot even though the stored target slugs are.

### `index` — `memory:read`, read-only

Lists current document summaries with an optional document-type filter and cursor
pagination.

### `history` — `memory:read`, read-only

Lists revision headers for one slug: revision ID/number, time, authenticated actor,
client, agent label, reason, restoration source, and request hash. Bodies are not
returned.

### `lint` — `memory:read`, read-only

Reports bounded groups: unresolved references, non-system orphans, missing summaries,
and stale active projects. Archived documents are omitted.

### `ingest` — `memory:write`, mutating

Creates or revises a document. Required common fields: operation ID and reason.
Operation IDs are unique opaque caller-generated strings of 1–200 characters, not
necessarily UUIDs. Their purpose is idempotent replay, not identity or ordering.

Create input requires type, slug, title, and body and has no expected revision.
Update input requires slug and expected revision ID, plus a patch for snapshot fields,
metadata, and links. Agent label is optional and untrusted provenance.

Success returns document and revision IDs/numbers plus warnings. Conflict returns the
current revision ID/number and no content.

`singletonMetadata` accepts standard or custom lowercase keys and declares
set/remove singleton behavior. `tags` is the simplified multivalued `tag` field.
Once a custom key has stored values, its cardinality cannot be changed implicitly.
Schema descriptions and malformed-key errors enumerate the standard singleton keys,
identify `tag` as multivalued, and explain that custom snake_case keys are allowed.

### `link` — `memory:write`, mutating

Convenience mutation for one explicit link. Requires operation ID, source slug,
expected revision ID, kind, target slug, add/remove action, and reason. It creates a
full new source revision through the same ingest service.

Self-links are rejected for every relationship kind. A remove operation may remove
a legacy self-link.

### `archive` — `memory:write`, mutating

Marks a mistakenly created non-system page archived by appending a revision
whose `status` is `archived`. It requires an operation ID, reason, slug, and expected
revision ID. Content and history remain retrievable and can be restored or revised;
archive never purges data. Archived pages are omitted from lint findings.

### `restore_preview` — `memory:admin`, read-only

Compares a historical target revision with current state and returns change flags
plus bounded current/target previews for each changed field, metadata set, and link
set. It also returns the expected current revision ID needed to apply. Preview values
are stored content and are explicitly marked untrusted.

### `restore_apply` — `memory:admin`, mutating/destructive annotation

Requires operation ID, slug, target revision ID, expected current revision ID, and
reason. It appends a compensating revision. It never deletes history.

Purge, export, and session administration are intentionally not MCP tools. They
remain owner-controlled web actions.

## Tool selection guidance

Descriptions must say when not to use a tool. `recall` is preferred over `index` for
task context. `get` follows promising recall results. `ingest` is for durable outcomes,
not scratchpads or chat transcripts. `restore_apply` is used only after presenting a
preview to the user or responding to an explicit restore request.

## Compatibility tests

Contract fixtures cover MCP initialization, discovery, tool schemas,
read/write/admin scopes, OAuth challenge metadata, pagination, bounded output,
conflicts, idempotent retry, secret rejection, and structured errors. Manual release
checks cover current Codex CLI, Claude Code, Claude web, and Claude mobile.
