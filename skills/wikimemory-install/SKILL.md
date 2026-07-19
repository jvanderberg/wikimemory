---
name: wikimemory-install
description: Connect Codex or Claude to an existing Wikimemory MCP, or deploy and configure a personal Cloudflare-hosted instance when the user asks to install, deploy, or connect Wikimemory.
---

# Install Wikimemory

Determine whether the user wants to connect to an existing instance or deploy a new one. Read the repository installation documentation before changing configuration because supported commands and prerequisites may evolve.

## Connect a client

1. Require an HTTPS base URL from the user and normalize the endpoint to `/mcp`.
2. Add it as a remote HTTP MCP server using the current Codex CLI or Claude Code command documented in `docs/installation.md`.
3. Let the user complete the browser passkey flow. Never request passkey data, setup tokens, or bearer tokens in chat.
4. Verify connection with `orient`, then a narrow `recall` query.
5. Install or expose the recall, ingest, and lint skills using the client-specific paths in the installation guide.

If browser approval succeeds but the active conversation remains unauthenticated,
do not repeat approval indefinitely. The host may retain the connector session it
opened before login. Start a new conversation or restart the CLI; if needed, use the
documented `mcp logout` then `mcp login` sequence and verify `orient` from a fresh
conversation. The Worker cannot refresh client-owned in-memory connector state.

For Claude on phone, configure the same HTTPS endpoint as a custom connector in Claude's web settings; localhost is not reachable from hosted clients.

## Deploy a new instance

1. Confirm the user controls a Cloudflare account. Deployment changes external state, so show the exact target account, Worker name, D1 database name, and KV namespace before applying it.
2. Run `npx --yes wikimemory install`, or the repository's guided TypeScript workflow for
   maintainer testing. Use `--deployment NAME` for a
   non-default installation. Do not reimplement provisioning steps ad hoc.
3. Stop after the installer prints the one-time URL. The human must open it and create the owner passkey; never open, copy, or retain that URL for them.
4. After the user confirms passkey setup, verify protected-resource metadata, OAuth login, and an authenticated `orient` call.
5. Do not enable local fixture identity in production. Never print, commit, or persist setup material outside the installer's one-time handoff and Cloudflare's secret store.

If a provisioning step fails after the config is created, rerun the documented
`--resume` workflow. It must require the installer's successful-preflight state.
Never work around a remote resource name collision by deploying over it.

For lost-passkey recovery, use `npx --yes wikimemory recover` or the documented repository
fallback.
It rotates the bootstrap hash and prints a one-use registration URL. Existing
credentials remain active until the replacement verifies; successful recovery then
replaces all old credentials and revokes browser sessions and MCP grants. It must
not delete memory.

For repeated deployment testing, run the documented uninstall preview before any
deletion. Apply uninstall only after showing the exact config-recorded account,
Worker, D1, and KV targets and obtaining the exact Worker-name confirmation. State
plainly that deleting D1 permanently destroys the remote memory.

If production deployment is marked incomplete in the installation guide, stop after local setup or client connection and state the limitation rather than improvising an insecure path.

## Update an existing instance

1. Run `npx --yes wikimemory status` first, then use `npx --yes wikimemory upgrade` or
   `npm run upgrade` for maintainer testing from this repository.
2. Let the CLI load the non-secret deployment record written by setup and show the
   exact account, Worker, D1 database, KV namespace, origin, version transition, and
   pending migrations before changing remote state.
3. Confirm that Wrangler's authenticated account and remote resource IDs/names match
   the record. Stop on migration drift, a newer schema, or an application downgrade.
4. Let the CLI verify packaged migration checksums, apply only the missing ordered
   suffix, deploy the bundled Worker and React assets, and update the record.
5. Verify `/health`, D1-backed `/ready`, protected-resource discovery, the compiled
   React shell, the exact application version, and the schema version.

An ordinary update must not run `setup -- --resume` or `setup -- --recover`, rotate
`SETUP_TOKEN_HASH`, replace passkeys, delete resources, or seed local fixture data.

## Manage an installed instance

- Run `npx --yes wikimemory dev` for package-owned local D1/KV/Worker testing; state is
  retained under the current directory's `.wikimemory/dev`.
- Run `npx --yes wikimemory passkeys list|add|revoke` for owner credential management.
- Run `npx --yes wikimemory connect codex|claude` only when the user explicitly asks to
  change that client's MCP configuration.
- Run `npx --yes wikimemory skills install codex|claude` to install version-matched skills.
- Preview with `npx --yes wikimemory uninstall`; apply only after exact-target review and
  explicit destructive confirmation. Remind the user to remove client-owned MCP
  registrations separately.
