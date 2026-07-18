# Wikimemory

Wikimemory is a personal, remotely hosted memory service for Claude, Codex, and
other MCP clients. It preserves research, project state, technical decisions, and
reusable context in an auditable revision store that the owner can browse and
search from the web.

The first usable vertical slice is implemented: local D1 emulation, remote HTTP
MCP with OAuth/PKCE, passkey production identity, append-only revision storage,
secret rejection, web browse/search/history, owner restore/purge/session controls,
sanitized exports, and client skills. See
[installation](docs/installation.md) to run it locally or deploy it.

## V1 in one picture

```text
Claude / Codex ---- Streamable HTTP MCP ----+
                                             |
Browser ------------ HTTPS web app ---------+--> Cloudflare Worker --> D1
                                             |
Passkey ------------ owner authentication --+
```

The server itself does not call an LLM. Claude or Codex performs synthesis; the
service provides deterministic storage, retrieval, authorization, history, and
recovery.

Cloudflare is the recommended V1 host because Workers, D1, and KV all have free
tier allowances large enough for typical personal use; the
[paid Workers plan](https://developers.cloudflare.com/workers/platform/pricing/)
starts at $5/month if those limits are exceeded. Memory is protected by access control and
Cloudflare-managed encryption, but it is **not end-to-end encrypted from Cloudflare**.
Do not store credentials or material you are unwilling to entrust to the host.

## Design documents

- [V1 product specification](docs/v1-spec.md)
- [Architecture](docs/architecture.md)
- [Security and threat model](docs/security.md)
- [Data model](docs/data-model.md)
- [MCP contract](docs/mcp-contract.md)
- [Local development and testing](docs/testing.md)
- [Installation and client connection](docs/installation.md)
- [Export formats and privacy](docs/export-format.md)
- [Pasteable agent instructions](docs/manual-agent-instructions.md)
- [Implementation plan](docs/implementation-plan.md)
- [Independent design review and dispositions](docs/design-review-2026-07-18.md)

## V1 boundaries

V1 is a personal, bring-your-own-Cloudflare deployment with one workspace and
passkey owner authentication. It includes a read-oriented web application with explicit
owner administration, remote MCP,
local emulation, portable export, agent skills, and an installation skill.

Multi-tenant SaaS, vector search, attachments, built-in chat, offline operation,
manual document editing, scheduled backups, monitoring infrastructure, custom
domains, and permanent staging infrastructure are not V1 features.
