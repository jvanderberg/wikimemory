# Wikimemory product specification

Status: implementation contract

## 1. Purpose

Wikimemory is durable personal memory maintained primarily by LLM agents and
inspectable by its human owner. It prevents agents from repeatedly rediscovering
project context while keeping every ordinary change attributable, reviewable, and
reversible.

The deployment is owned by the user in their Cloudflare account. It exposes:

- a protected Streamable HTTP MCP endpoint for Claude, Codex, and compatible
  clients;
- a responsive web application for browsing, search, history, export, restoration,
  credential/session management, and permanent purge; and
- local equivalents of the Worker, D1 database, identity provider, web app, and
  MCP endpoint for development without deployment.

The service is deterministic. It does not make model API calls or create embeddings.

## 2. Product principles

1. **The database is authoritative.** Markdown and JSONL are exports.
2. **Ordinary history is append-only.** Updates and restores append full-snapshot
   revisions.
3. **One controlled write path.** MCP and web adapters call the same domain service.
4. **Recall before work; ingest after meaningful outcomes.** Distributed skills
   teach this behavior.
5. **Identity and intent are auditable.** The authenticated subject, OAuth client,
   optional agent label, reason, operation ID, and server timestamp are distinct.
6. **Portability is a feature.** A user can export lossless history without
   Cloudflare-specific tooling.
7. **Stored content is data.** Retrieved content never outranks user, system,
   repository, or skill instructions.

## 3. User experience

### Agent workflow

At the start of non-trivial work an agent calls `orient`, searches with `recall`,
and reads promising pages with `get`. After a durable decision, finding, or project
status change it recalls again to avoid duplication and calls `ingest` or `link`.
If it created a page in error, it may append an archived status with `archive`;
permanent deletion remains an owner-only browser action.

Agents do not store credentials, routine conversation, transient command output,
or information useful only within the current turn.

### Web application

The web application has four main areas:

- **Browse** — current documents with metadata, links, provenance, and history.
- **Search** — full-text search across current documents.
- **Recent** — recent revisions with links to their historical snapshots.
- **Manage** — passkeys, authorized MCP clients, browser sessions, and exports.

Wikimemory has no general-purpose document editor. A document's history page supports
restore by appending a compensating revision. Purge permanently deletes a document
and all of its revision content after recent authentication and explicit typed
confirmation.

### Phone use

Claude mobile and ChatGPT mobile use the deployed remote connector after it has been
configured in the provider's web interface. The responsive Wikimemory web application
provides direct browse and search access.

## 4. Document model

Document types are `system`, `project`, `topic`, `source`, and `note`. A document has
a stable opaque ID, immutable type, and immutable kebab-case slug within its
workspace.

Every revision is a complete snapshot containing title, Markdown body, optional
summary, versioned metadata, and versioned links. Revision ordering uses a
server-assigned integer revision number per document, never timestamps.

Standard singleton metadata keys are `status`, `last_active`, `project`, `priority`,
`confidence`, `source_url`, `source_type`, and `trust`. `tag` is multivalued. Custom
metadata is permitted but must declare singleton or multivalued behavior in the
request. Metadata keys use lowercase letters, digits, and underscores, begin with a
letter, and are at most 64 characters.

Link kinds are `related`, `part_of`, `supersedes`, `cites`, and `contradicts`.
Explicit links require an existing target. Body references to missing `[[slugs]]`
are retained as unresolved references and reported by lint. A document cannot link
to itself; self-edges do not satisfy orphan detection even if legacy data contains one.
`source_url` values are canonicalized on write and lookup by removing fragments,
common tracking parameters, default ports, and non-root trailing slashes.

## 5. Mutation semantics

- New documents require type, slug, title, and body.
- Updates require the current revision ID as `expectedRevisionId`.
- Omitted title/body/summary fields carry forward; explicit empty values do not.
- Singleton metadata uses set/remove semantics. Multivalued metadata uses
  replace/add/remove semantics.
- Links use add/remove semantics and are de-duplicated.
- The server derives body references after the final body is known.
- Every mutation requires a caller-generated operation ID. Repeating a completed
  operation returns the original result without adding a revision.
- Operation IDs are unique opaque strings of 1–200 characters. UUIDs are acceptable
  but not required.
- A stale expected revision returns a structured conflict and makes no changes.
- Secret scanning occurs before persistence. High-confidence secret formats are
  rejected; there is no agent-accessible override. Unsupported manual operator work
  must not weaken this invariant in the service.
- Archive is a normal append-only revision that sets `status=archived`. It preserves
  content and history, remains reversible, and suppresses archived-page lint noise.

## 6. Restore and purge

Restore is non-destructive. It appends a new revision whose content is copied from a
chosen earlier revision, whose parent is the current revision, and whose provenance
records the restored revision.

Purge is the only history-deleting operation. It is available only in the web
application to an owner, requires recent authentication and the
document slug typed exactly, deletes the document and dependent content in one
transaction, and appends a sanitized audit event containing IDs and hashes but no
deleted content. Content-free operation tombstones survive purge so replaying an old
mutation returns `gone` and can never recreate purged content.

## 7. Authentication and authorization

The owner authenticates with a user-verifying WebAuthn passkey. Wikimemory is its
own OAuth 2.1 authorization server and MCP resource server; passkey material is not
passed to an MCP client.

Scopes are:

- `memory:read` — orient, recall, get, index, history, and lint;
- `memory:write` — ingest, link, and archive; and
- `memory:admin` — MCP restore operations and owner passkey management.

Access tokens must be audience-bound to the canonical MCP resource URI.
Passkey registration requires a hashed, one-use bootstrap value produced by the
installer. Rotating that secret through the owner's Cloudflare account is the
recovery mechanism.

Normal agent connections request `memory:read memory:write`. Administrative MCP
connections explicitly request all three scopes; Wikimemory does not depend on
incremental scope elevation. Browser administration is authorized by owner membership
and recent upstream authentication, not by MCP scopes.

## 8. Export and migration boundary

Wikimemory intentionally has no general import endpoint or automated `llmwiki`
migration. Importing untrusted archives creates a large validation and partial-failure
surface before the service has earned operational trust. An owner may perform a
one-off, reviewed migration with local operator tooling, but that procedure is
unsupported and must never upload the raw SQLite database to the Worker.

Exports are:

- lossless versioned JSONL containing memory records, sanitized actor projections and
  memberships, opaque client attribution, purge tombstones, and schema version; and
- Markdown containing current state and a generated index.

OAuth tokens, sessions, secrets, and provider configuration are never exported.

## 9. Limits

Initial limits, configurable downward but not upward without code review:

- body: 256 KiB UTF-8 per revision;
- title: 300 characters;
- summary: 1,000 characters;
- metadata value: 4,096 characters;
- at most 100 metadata values and 100 links per revision;
- recall: at most 20 results;
- MCP `get`: at most 32,768 Unicode code points per response with word-preferred
  cursor-based continuation.

Attachments and server-side URL fetching are not supported.

## 10. Deferred work

Multi-tenant hosted SaaS, semantic/vector search, file attachments, built-in chat,
manual editing, offline replicas, scheduled backups, monitoring infrastructure,
custom domains, and permanent staging infrastructure are explicitly deferred.

## 11. Acceptance criteria

The product is release-ready when:

1. the full service runs locally with no Cloudflare deployment or external identity
   account;
2. domain and MCP tests prove append, conflict, idempotency, restore, purge, scope,
   secret-rejection, and FTS behavior;
3. lossless JSONL export contains versioned domain data and sanitized attribution,
   while Markdown export contains complete current state;
4. Codex CLI and Claude Code use the local MCP endpoint with the distributed skills;
5. a deployed instance authenticates with a passkey and works from Codex CLI, Claude
   Code, Claude web, and Claude mobile;
6. the owner can browse/search the web app and inspect precisely who caused each
   revision;
7. purge replay, OAuth registration and scope profiles, passkey bootstrap reuse,
   log redaction, and bounded export behavior have automated
   acceptance coverage; and
8. the core web browse, search, history, authentication, and management flows pass in
   both Chrome and WebKit component tests, with passkey E2E covered separately.
