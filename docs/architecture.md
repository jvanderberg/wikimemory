# Architecture

## Context

Wikimemory has two external actors: a human browser and an MCP client acting for that
human. A WebAuthn passkey authenticates the owner. Cloudflare hosts a
single Worker and D1 binding per personal deployment.

```text
Passkey ---- WebAuthn --------------+
                                    |
Browser ---- HTTPS -----------------+--------------------+
                                                         |
Claude/Codex -- Streamable HTTP MCP + OAuth 2.1 ---------v---+
                                                     Worker  |
                                          +-----------------+
                                          | routes/adapters |
                                          +--------+--------+
                                                   |
                                          +--------v--------+
                                          | domain services |
                                          +--------+--------+
                                                   |
                                          +--------v--------+
                                          | D1 repository   |
                                          +-----------------+
```

## Runtime components

### Worker router

The Worker owns `/mcp`, OAuth discovery and endpoints, WebAuthn JSON APIs,
authenticated web JSON APIs, and the compiled web assets. OAuth endpoints may
redirect the browser, but Worker TypeScript does not construct application HTML.

Transport adapters authenticate, validate, and translate requests. They contain no
domain write SQL and do not assemble revisions themselves.

### Domain services

Domain services implement create/update, metadata patching, links, secret scanning,
recall, lint, restore, purge, and export. They accept an `ActorContext`
created by the auth layer and return typed results/errors independent of HTTP or MCP.

### D1 repository

The repository owns prepared statements and transaction batches. SQL migrations
enforce immutable identity, revision-parent conflict checks, operation idempotency,
and guarded purge. FTS5 indexes only current revisions.

### Authentication

Production uses a user-verifying WebAuthn passkey. Registration requires the current
one-use bootstrap secret, whose raw value is delivered only in the installer's URL
fragment. Credential public keys and monotonic counters live in D1; challenges and
short browser sessions live in KV. Local development uses a visibly marked fixed
test owner. Production cannot enter that local path.

### Web application

The web application is a React 19/Vite single-page application. React components and
hooks own setup, authentication, local consent, browse, search, document history, and
passkey/session/client management rendering. Runtime responses are validated before
entering component state. The Worker serves the compiled assets and JSON only; the
asset binding falls back to the React shell for browser routes.

The browser uses an HttpOnly owner-session cookie. Same-origin checks protect every
mutation, passkey management additionally requires authentication within five
minutes, and recovery remains an out-of-band Cloudflare-account operation.

## Deployment model

V1 provisions one Worker, one D1 database, and the OAuth provider's required storage
bindings in the user's Cloudflare account. The domain schema includes a workspace ID
even though the deployment creates exactly one personal workspace. Cross-workspace
queries are forbidden by repository APIs.

The `workers.dev` URL is the canonical V1 resource URI. Custom domains are deferred.

Cloudflare is the V1 recommendation because the Worker, D1, and KV bindings share a
single low-administration deployment and their current free tiers comfortably fit a
personal text memory workload. Verify current limits on the official
[Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/)
before deployment; pricing is an external operational fact, not an application
guarantee.

## Consistency model

Current state is the highest server-assigned revision number for a document; there is
no mutable current pointer. A revision insert supplies its parent revision and next
revision number. A database trigger compares both with the current maximum and aborts
on mismatch. D1 serializes the transactional batch, so a competing insert observes
the first committed revision and fails its stale-parent check. All snapshot metadata,
links, body references, FTS refresh, and audit insertion occur in that same batch.

An operation ID is unique within a workspace. On retry, the service retrieves the
recorded operation result. It never treats a uniqueness error as success without
verifying that the operation principal and canonical request hash match. Purge
replaces result-bearing operation records for the document with content-free `purged`
tombstones, preventing a replay from resurrecting deleted content.

## Error model

Domain errors have stable codes:

- `not_found`
- `already_exists`
- `revision_conflict`
- `idempotency_mismatch`
- `gone`
- `validation_failed`
- `secret_detected`
- `forbidden`
- `reauthentication_required`
- `limit_exceeded`
- `internal_error`

MCP adapters return actionable tool errors with structured data. Web adapters map the
same errors to HTTP status codes and safe user messages. Internal errors receive a
request ID; content and secrets never enter the error response or platform log.

## Local architecture

`wrangler dev` runs the Worker under workerd/Miniflare with a local D1 binding and
persisted `.wrangler/state`. The local identity provider replaces passkey verification only; the
Wikimemory authorization-code, PKCE, token, consent, scope, and resource-server paths
remain exercised.

The Workers Vitest pool provides isolated bindings for automated tests. Browser tests
start the same local Worker. Codex CLI and Claude Code connect to the loopback MCP URL.
