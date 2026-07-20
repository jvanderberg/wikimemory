# Design review — 2026-07-18

An independent internal review was performed after the first complete design pass and
before implementation. This file records the root agent's review of that review and
the resulting decisions.

## Blocking findings accepted

1. **Purge replay:** deleting an operation record could allow a retried create to
   resurrect purged content. Purge now retains content-free terminal operation
   tombstones, and portable export preserves them.
2. **Actor attribution in export:** a supposedly lossless export omitted principal
   and membership projections required by revisions and audit events. The format now
   includes sanitized identity projections and explicit import remapping.
3. **Raw SQLite web import:** parsing and atomically ingesting a realistic SQLite file
   inside a Worker is not a sound design. The later scope decision removed all import
   paths and automated migration rather than implementing the proposed local CLI or
   bounded JSONL import.
4. **OAuth compatibility profile:** the original contract named OAuth but did not
   select client registration behavior. Wikimemory now requires DCR and explicit
   pre-registration, exact resource-indicator validation, protected-resource
   challenge metadata, and client-specific fixtures. CIMD is deferred pending an
   SSRF-safe implementation decision.

## Medium findings accepted

- Normal and administrative MCP scope profiles are separate; Wikimemory does not rely on
  incremental elevation.
- Browser owner authorization is distinct from MCP `memory:admin`.
- The original Google design had an explicit five-minute `auth_time` rule; the
  implemented passkey design preserves the five-minute recent-auth requirement
  using the server-verified assertion completion time.
- Refresh-token rotation language matches the provider library's bounded retry
  window.
- Workspace-safe composite constraints, stable cursor behavior, Unicode-safe chunks,
  and the import secret-risk policy are now explicit.
- Phase 4 is a usable local vertical-slice milestone before web and deployment work.

## Additional root adjustment

The reviewer noted that a mutable current-revision pointer needed its own guarded
update mechanism. The root review removed that pointer entirely. Current state is the
greatest server revision number; insert triggers validate parent and next number in
the transactional D1 batch. This is simpler and preserves the original monotonic
revision model.

## Constraints retained

The review explicitly supported full-snapshot append-only revisions, compensating
restore, one domain write path, separate authenticated and agent identity, untrusted
source handling, purge outside MCP, local real-runtime testing, bounded output, and
portable exports. These remain design constraints.

## Subsequent scope decision — 2026-07-18

The owner explicitly removed import and automated `llmwiki` migration. The
review's prohibition on raw SQLite upload remains; the proposed JSONL import and
chunked migration implementation are superseded. Wikimemory provides exports only.
