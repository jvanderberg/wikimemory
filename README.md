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

## What you can use it for

- Maintain a to-do list and let an assistant help prioritize, update, and archive it.
- Track personal or work projects with status, decisions, open questions, and next
  actions.
- Collect sources and build a durable research notebook with summaries and
  provenance.
- Keep an automated journal or work log containing the entries you choose to save.
- Maintain notes about people, conversations, commitments, and important context.
- Preserve meeting notes and decision history so later sessions know why a choice
  was made.
- Build a personal assistant that combines connected email or calendar tools with
  selected long-term memory.
- Keep learning notes, reading lists, household context, or a troubleshooting and
  incident notebook.

Wikimemory does not read email, calendars, or other services on its own. A connected
assistant uses those tools and saves only the information you ask it to remember.
Because these uses can involve sensitive personal data, review the
[security model](docs/security.md) before deciding what to store.

## Quick start

Requirements: Node.js 22+, npm, a Cloudflare account, and a passkey-capable browser
or password manager. No Google Cloud project or OAuth application is required.

```sh
npx wrangler login
npx wikimemory install
```

The installer previews the exact Cloudflare account, Worker, D1 database
(Cloudflare's managed SQLite), and OAuth/session store before creating anything.
Open its one-time URL to register the owner passkey. The installer also prints the
exact `/mcp` URL to paste into clients that require manual connector setup. Then
connect a command-line client and install its memory skills:

```sh
npx wikimemory connect codex
npx wikimemory skills install codex

# or
npx wikimemory connect claude
npx wikimemory skills install claude
```

To use Wikimemory on a phone, first add the HTTPS `/mcp` URL printed by the installer
or by `npx wikimemory status`:

Use the complete URL, including `/mcp`. The deployment root opens the Wikimemory web
application and is not an MCP endpoint.

- **Claude:** add it as a custom connector in Claude's web settings. It then appears
  in Claude mobile.
- **ChatGPT:** enable developer mode on ChatGPT web, create an app using the `/mcp`
  URL under **Settings → Plugins**, and finish passkey authorization. The app then
  appears in ChatGPT mobile.

See the complete [installation guide](docs/installation.md) for detailed connection
steps, recovery, passkey management, upgrades, and safe uninstall.

## Run locally

```sh
npx wikimemory dev
```

This starts the Worker, React app, D1, and KV through local Wrangler emulation.
State persists under `./.wikimemory/dev`; production passkey identity is
replaced with a clearly marked fake local owner while OAuth, PKCE, scopes, tokens,
and MCP transport remain real.

## Lifecycle commands

```sh
npx wikimemory status
npx wikimemory browse
npx wikimemory upgrade
npx wikimemory recover
npx wikimemory passkeys list
npx wikimemory uninstall       # preview only
```

Parallel installations use `--deployment NAME`. Non-secret lifecycle state lives
under `~/.config/wikimemory/deployments/NAME/`. Uninstall requires an explicit apply
step and exact Worker-name confirmation because deleting D1 permanently destroys the
stored memory.

## How it works

```text
Claude / Codex ---- Streamable HTTP MCP ----+
                                             |
Browser ------------ HTTPS web app ---------+--> Cloudflare Worker --> D1
                                             |
Passkey ------------ owner authentication --+
```

Cloudflare is the recommended host because Workers, D1, and KV all have free
tier allowances large enough for typical personal use; the
[paid Workers plan](https://developers.cloudflare.com/workers/platform/pricing/)
starts at $5/month if those limits are exceeded. Memory is protected by access control and
Cloudflare-managed encryption, but it is **not end-to-end encrypted from Cloudflare**.
Do not store credentials or material you are unwilling to entrust to the host.

## Design documents

- [Product specification](docs/product-spec.md)
- [Architecture](docs/architecture.md)
- [Security and threat model](docs/security.md)
- [Data model](docs/data-model.md)
- [MCP contract](docs/mcp-contract.md)
- [Local development and testing](docs/testing.md)
- [Installation and client connection](docs/installation.md)
- [Export formats and privacy](docs/export-format.md)
- [Pasteable agent instructions](docs/manual-agent-instructions.md)
- [Implementation history](docs/implementation-history.md)
- [Independent design review and dispositions](docs/design-review-2026-07-18.md)

## Current scope

Wikimemory supports one owner and one workspace, authenticated with passkeys. It
includes a React web application with owner administration, remote MCP, local
emulation, portable export, agent skills, and guided installation and client setup.

Multi-tenant SaaS, vector search, attachments, built-in chat, offline operation,
manual document editing, scheduled backups, monitoring infrastructure, custom
domains, and permanent staging infrastructure are outside the current scope.

## License

MIT
