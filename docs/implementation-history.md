# Implementation history

Status: completed initial implementation sequence.

This records the phases used to build Wikimemory. Each phase ended with passing tests
and a reviewable change, without weakening invariants established earlier.

## Phase 1 — foundation

- TypeScript Worker project, pinned package manager, Wrangler configuration, static
  web assets, formatting, linting, type checking, and Workers Vitest setup.
- Local/production environment validation.
- Repository-scoped contributor instructions.

Exit: empty Worker and test run locally with no cloud account.

## Phase 2 — schema and domain reads

- D1 migrations for workspaces, principals, documents, revisions, snapshot children,
  operations, audit, purge authorization, and FTS5.
- Seed `home` and `now` through the domain write service.
- Current get, index, recall, history, and lint queries.

Exit: local D1 tests prove identity immutability, current-state selection, FTS, and
workspace isolation.

## Phase 3 — invariant-preserving writes

- Create/update patch model and validation.
- Secret scanner.
- Transactional parent conflict, revision numbering, operation idempotency, snapshot
  metadata/links, derived references, FTS refresh, and audit.
- Link convenience operation and compensating restore.
- Guarded permanent purge for the web domain service.

Exit: race, retry, restore, and purge integration tests pass.

## Phase 4 — local auth and MCP

- MCP Streamable HTTP server, bounded tools, and safe error mapping.
- OAuth provider and resource-server behavior.
- Local identity provider with owner/reader/unauthorized fixtures.
- Programmatic MCP/OAuth contract tests.

Exit: Codex CLI and Claude Code can connect locally and exercise scoped tools.

This is the first usable vertical-slice milestone: local D1, read/write MCP, local
OAuth, and agent skills work together before web/deployment work expands.

## Phase 5 — passkey identity and web application

- WebAuthn registration, authentication, bootstrap rotation, and recovery.
- Browse, Search, Recent, document/history, and Manage pages.
- JSONL/Markdown export, restore, session
  administration, and purge flows.
- Responsive and accessible browser tests.

Exit: the complete product works locally with fake identity and in a temporary
deployment with passkey identity.

## Phase 6 — skills and installation

- Skills: recall, ingest, lint, and installation.
- Versioned client skills and a pasteable manual contract.
- Guided TypeScript installer and documentation for Cloudflare, Codex CLI, Claude
  Code, Claude custom connectors, and mobile use.

Exit: a fresh user can deploy/connect by following the installation skill and can
export all cloud memory without provider-specific database access.

## Phase 7 — acceptance

- Full local verification from a clean clone.
- Security test review and dependency audit.
- Manual Codex/Claude skill scenarios.
- Temporary deployed checks for passkeys, Codex, Claude Code, Claude web, and Claude
  mobile.
- Documentation reconciliation with observed behavior.

Exit: every acceptance criterion in `product-spec.md` is either demonstrated or
explicitly reported as requiring user-owned cloud credentials for final verification.
