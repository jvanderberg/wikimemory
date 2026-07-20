# Export formats

Exports are owner-only web downloads under **Manage**. They are generated from one
authenticated workspace, are never cached, and have no corresponding import route.

## Lossless JSONL

`/api/app/export.jsonl` returns newline-delimited JSON with `schemaVersion: 1`. Records
are emitted in this order:

1. manifest and workspace;
2. sanitized principal, membership, and client projections;
3. immutable document identities and every surviving revision;
4. versioned metadata and links;
5. sanitized audit events; and
6. content-free purge operation tombstones.

Revision bodies, summaries, reasons, hashes, parent relationships, restoration
relationships, and server timestamps are preserved. Real provider subjects, email
addresses, passkey credential material, registered OAuth client IDs, tokens, browser
sessions, completed-operation replay records, and purge authorizations are excluded.
Actors and clients use deterministic archive-local aliases such as `actor-1` and
`client-1`.

Each record kind is capped at 10,000 rows. Export fails rather than silently
truncating a category. The archive is designed for custody and future reviewed
recovery tooling; accepting it back into Wikimemory is deliberately unsupported.

## Current Markdown

`/api/app/export.md` returns a generated index followed by every current page. It omits
historical revisions and audit data and is intended for reading, search, and simple
manual recovery—not as a lossless backup.

## Handling

Both formats contain private memory content. Store them with protections appropriate
for the underlying information. Cloudflare credentials and OAuth material are never
needed to read an export.
