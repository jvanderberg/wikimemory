# Local development and testing

## Goals

- Develop and test normal changes without deploying to Cloudflare.
- Exercise D1, the Workers runtime, MCP, web routes, and Wikimemory's OAuth paths
  locally rather than replacing them with Node-only mocks.
- Replace only passkey verification during ordinary development.

## Local runtime

`wrangler dev` runs the Worker under workerd/Miniflare and creates local bindings.
Local D1 data persists in `.wrangler/state`, which is ignored by git.

Current scripts:

```sh
npm run dev             # migrate/seed local D1, start Worker and web app
npm test                # domain + Workers/D1 integration tests
npm run smoke:local     # OAuth/PKCE, MCP, export, restore, purge, and revoke smoke
npm run test:passkey    # real WebAuthn registration/login using Chrome virtual authenticator
npm run typecheck
npm run lint
```

`dev:reset`, a standalone full MCP contract suite, and automated browser E2E are
Phase 5 work. Until then, reset only the explicit repository-local
`.wrangler/state` path manually after verifying it, and use the smoke script plus
manual web checks.

Destructive reset scripts resolve and validate the repository-local state path before
removal. They never accept a broad directory or unresolved environment variable.

## Local identity

The current local page offers a fixed fake owner. Reader and denied-identity fixtures
remain planned for authorization coverage. Selecting the owner completes the upstream identity step. Wikimemory's own consent, authorization
code, PKCE, access/refresh token, scope, resource audience, and revocation behavior
remain real.

Production configuration fails to start if local identity or fixture seeding is
enabled.

## Test suites

### Domain

Pure tests cover patch semantics, canonical request hashing, secret detection,
custom metadata cardinality, exact source-URL discovery, high-confidence secret
signatures, long URL/filename non-regressions, pagination, lint classification, and
safe error formatting.

### Worker/D1 integration

Cloudflare's Vitest Workers pool applies real migrations to isolated local D1. Tests
cover constraints, triggers, FTS5, atomic snapshot writes, cross-workspace isolation,
conflict races, idempotency, restore, guarded purge, and export ordering.

### MCP contract

A programmatic client connects to the local Streamable HTTP endpoint. Tests cover
initialization, tools/resources, discovery challenges, scopes, OAuth, structured
content, errors, and output limits. An MCP inspector recipe supports exploratory use.

### Planned browser end-to-end

Browser tests will use the local identity chooser and cover Now, search, browse, history,
connection guidance, export, restore preview/apply, reauthentication
timestamp enforcement, and purge confirmation.

### Agent behavior

Repo-scoped Codex and Claude skills connect to `wikimemory-dev`. A pasteable manual
contract provides a control condition. Scenario tests assess recall-before-work,
deduplication-before-ingest, meaningfulness, provenance, conflict handling, and
resistance to instructions embedded in source documents.

These scenarios are behavioral checks, not brittle assertions on exact prose.

## Local client use

Codex CLI and Claude Code can connect to `http://127.0.0.1:8787/mcp`. The local OAuth
provider opens in the developer's browser. Claude web/mobile cannot reach localhost
because their connector traffic originates remotely; deployed-client compatibility
is a release acceptance check rather than a normal development dependency.

## Fixtures

Fixtures contain only synthetic identities, projects, sources, and fake credentials.
No test or development command reads the user's personal `llmwiki` database. Manual
migration is outside the supported V1 surface.
