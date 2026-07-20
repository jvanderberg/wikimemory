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
npm test                # Worker, React, and lifecycle CLI tests
npm run test:coverage   # instrument source locally and enforce coverage thresholds
npm run smoke:local     # OAuth/PKCE, MCP, export, restore, purge, and revoke smoke
npm run test:passkey    # real WebAuthn registration/login using Chrome virtual authenticator
npm run format          # apply Biome formatting and import organization
npm run format:check    # fail on formatting or import-order drift
npm run typecheck
npm run lint
npm run docs:check      # verify documentation links, commands, and current terminology
npm run check           # typecheck, lint, tests, and coverage gates
npm run test:package    # pack and exercise the CLI from a temporary empty directory
npm run verify:release  # verify version and migration-manifest consistency
```

There is no automated development reset command. To reset contributor state, stop the
development server and remove only the verified repository-local `.wrangler/state`
directory. Use the smoke script plus manual web checks for broader end-to-end changes.

## Local identity

The React local authorization page offers a fixed fake owner. Selecting the owner
completes the upstream identity step. Wikimemory's own consent, authorization code,
PKCE, access/refresh token, scope, resource audience, and revocation behavior remain
real. Programmatic tests cover rejected identities and authorization boundaries.

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

`npm run test:coverage` uses test-time Istanbul instrumentation and writes an ignored
HTML report to `coverage/`. Vitest runs two projects in the same coverage process:
Workers/D1 integration under workerd and React component tests in real headless Chrome
through the Playwright provider.

The release gate protects global floors of 85% statements, 78% branches, 88% functions,
and 85% lines. Independent floors prevent well-covered code from hiding regressions in
auth, domain, MCP, Worker web, or React code. The current floors are recorded in
`vitest.config.ts` and should be ratcheted upward as each tranche lands; never lower them
merely to admit untested code.

The installer and uninstall lifecycle have a separate Node coverage gate: 50% lines,
70% branches, and 60% functions across `scripts/setup.ts` and `scripts/uninstall.ts`.
The destructive uninstall sequence runs against an injected fake command runner in a
temporary directory, validating Cloudflare command order and local cleanup without
changing remote resources.

The browser project runs the component suite in both the installed stable Google
Chrome channel and Playwright WebKit. Install Chrome and the Playwright WebKit browser
before running the full check on a fresh development machine.

### MCP contract

A programmatic client connects to the local Streamable HTTP endpoint. Tests cover
initialization, tool schemas, discovery challenges, scopes, OAuth, structured
content, errors, and output limits.

### Browser interaction coverage

Real-Chrome component tests cover local and production login states, MCP authorization,
passkey setup, browse, search, recent history, document rendering, and credential,
grant, and browser-session management. Full browser/WebAuthn E2E remains available via
`npm run test:passkey` for pre-release validation.

### Agent behavior

The distributed Codex and Claude skills define recall-before-work, deduplication,
meaningful ingestion, provenance, conflict handling, and resistance to instructions
embedded in stored documents. The pasteable manual contract provides the same core
behavior when skills are unavailable. Agent behavior is validated manually during
release acceptance rather than by brittle assertions on generated prose.

## Local client use

Codex CLI and Claude Code can connect to `http://127.0.0.1:8787/mcp`. The local OAuth
provider opens in the developer's browser. Claude web/mobile cannot reach localhost
because their connector traffic originates remotely; deployed-client compatibility
is a release acceptance check rather than a normal development dependency.

## Fixtures

Fixtures contain only synthetic identities, projects, sources, and fake credentials.
No test or development command reads the user's personal `llmwiki` database. Manual
migration is outside the supported product surface.
