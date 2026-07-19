# Wikimemory

Wikimemory is a personal, remotely hosted memory service for Claude, Codex, and
other MCP clients. It preserves research, project state, technical decisions, and
reusable context in an auditable revision store that the owner can browse and
search from the web.

It includes remote HTTP MCP with OAuth/PKCE, passkey identity, append-only revision
storage, full-text search, a React browse/search/history UI, multi-passkey controls,
sanitized exports, and version-matched client skills. The server does not call an
LLM; Claude or Codex performs synthesis while Wikimemory provides deterministic,
auditable storage and retrieval.

## Quick start

Requirements: Node.js 22+, npm, a Cloudflare account, and a passkey-capable browser
or password manager. No Google Cloud project or OAuth application is required.

```sh
npx wrangler login
npx wikimemory install
```

The installer previews the exact Cloudflare account, Worker, D1 database, and KV
namespace before creating anything. Open its one-time URL to register the owner
passkey, then connect a client and install its memory skills:

```sh
npx wikimemory connect codex
npx wikimemory skills install codex

# or
npx wikimemory connect claude
npx wikimemory skills install claude
```

Use the same remote MCP from Claude web or mobile by adding the printed HTTPS `/mcp`
URL as a custom connector. See the complete [installation guide](docs/installation.md)
for recovery, passkey management, upgrades, and safe uninstall.

## Local development without a checkout

```sh
npx wikimemory dev
```

This starts the packaged Worker, React app, D1, and KV through local Wrangler
emulation. State persists under `./.wikimemory/dev`; production passkey identity is
replaced with a clearly marked fake local owner while OAuth, PKCE, scopes, tokens,
and MCP transport remain real.

## Lifecycle commands

```sh
npx wikimemory status
npx wikimemory upgrade
npx wikimemory recover
npx wikimemory passkeys list
npx wikimemory uninstall       # preview only
```

Parallel installations use `--deployment NAME`. Non-secret lifecycle state lives
under `~/.config/wikimemory/deployments/NAME/`. Uninstall requires an explicit apply
step and exact Worker-name confirmation because deleting D1 permanently destroys the
stored memory.

## V1 in one picture

```text
Claude / Codex ---- Streamable HTTP MCP ----+
                                             |
Browser ------------ HTTPS web app ---------+--> Cloudflare Worker --> D1
                                             |
Passkey ------------ owner authentication --+
```

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
passkey owner authentication. It includes a React web application with explicit
owner administration, remote MCP,
local emulation, portable export, agent skills, and an installation skill.

Multi-tenant SaaS, vector search, attachments, built-in chat, offline operation,
manual document editing, scheduled backups, monitoring infrastructure, custom
domains, and permanent staging infrastructure are not V1 features.

## License

MIT
