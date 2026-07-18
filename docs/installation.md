# Installation

V1 is a personal Cloudflare Worker protected by the owner's passkey. Local
development needs no cloud account. Production needs Node.js 22+, npm, a
Cloudflare account, and a device or password manager that supports passkeys. It
does not need a Google Cloud project or OAuth application.

## Run locally

```sh
npm ci
npm run dev
```

Wrangler applies migrations to a repository-local Miniflare D1 database and starts
the Worker at `http://127.0.0.1:8787`. Open `/app` and continue as the clearly marked
fake local owner. Only owner authentication is replaced locally: Wikimemory's OAuth
authorization code, PKCE, access/refresh tokens, scopes, and MCP transport remain
real.

In a second terminal, exercise the local OAuth and MCP flow:

```sh
npm run smoke:local
```

Passkeys also work on `localhost`, but the fixed local identity is the default test
path so routine development does not depend on a particular browser or authenticator.

## Guided Cloudflare deployment

First authenticate Wrangler:

```sh
npx wrangler login
```

Then run the installer from a clean checkout:

```sh
npm ci
npm run setup
```

Before changing anything, the installer displays the active Cloudflare identity and
the exact Worker, D1, and KV names and asks for confirmation. It then:

1. creates an ignored `wrangler.production.jsonc`;
2. confirms that the requested remote names are unused;
3. deploys a bootstrap Worker and discovers its `workers.dev` origin;
4. creates and binds D1 and KV, then applies the remote migrations;
5. generates a random one-time setup value, stores only its SHA-256 hash as a
   Cloudflare Worker secret, and redeploys with the canonical origin;
6. verifies both `/health` and the D1-backed `/ready` check; and
7. prints the one-time passkey setup URL and client commands.

On a Cloudflare account that has never deployed a Worker, Cloudflare first requires
an account-wide `workers.dev` subdomain. The installer detects that condition before
creating D1 or KV, reconnects Wrangler directly to the terminal, and lets Wrangler
prompt for and register an available subdomain. Setup then continues automatically.
Non-interactive setup stops before creating storage and asks to be rerun in a terminal.

Remote migrations are uploaded as one atomic file per migration because D1's query
endpoint cannot reliably parse compound trigger bodies. Each uploaded file includes
its `d1_migrations` record, so an interrupted run either applies the entire migration
or none of it. `npm run db:migrate:production` uses the same path for later updates.

Open that setup URL on a phone or computer with a passkey-capable browser. The raw
setup value is in the URL fragment, so it is not sent in the initial HTTP request or
normal access logs. It is held in page memory only long enough to request passkey
registration, is never written to disk by the installer, and cannot be reused after
successful registration.

Custom resource names are optional:

```sh
npm run setup -- --worker-name my-memory --database-name my-memory --kv-name my-memory-oauth
```

If Wrangler exposes more than one Cloudflare account, the installer asks which one
to use and pins its ID in the generated config. For noninteractive use, pass
`--account-id ID --yes`. Before provisioning, the installer also refuses collisions
with existing Worker, D1, or KV names; select unused custom names instead of
overwriting or silently adopting unrelated resources.

If provisioning stops after collision preflight, rerun with `--resume`. The ignored
installer state pins the preflighted account and resource names; existing bindings
are reused and missing stages continue. Resume refuses to run without proof that
collision preflight succeeded. Fresh deployment refuses to overwrite same-named
remote resources, and all uploads use Wrangler strict mode.

`--yes` skips the confirmation and is intended for an operator who has already
reviewed the displayed defaults. The installer does not delete or replace an
existing production configuration.

## Passkey recovery

Cloudflare account control is the recovery authority. From the original checkout
with its ignored `wrangler.production.jsonc`, rotate the one-time setup secret:

```sh
npm run setup -- --recover
```

The command asks for confirmation, writes a new hash to the Worker secret store, and
prints a new one-use URL. Completing it adds a replacement passkey; it does not erase
existing passkeys or memory. Treat control of the Cloudflare account and local
production config as administrator access.

## Uninstall a test deployment

Preview the exact resources recorded in the ignored production config:

```sh
npm run uninstall
```

Preview mode does not call any deletion command. To remove the deployment, run:

```sh
npm run uninstall -- --apply
```

The workflow requires typing the exact Worker name, then deletes that Worker, its
recorded KV namespace, and its recorded D1 database before removing the local
production config and installer state. D1 deletion permanently destroys the remote
memory and cannot be recovered. For controlled automation,
`--apply --confirm WORKER_NAME` provides the same exact-name guard. Delete targets
always come from recorded resource IDs and names, never defaults or uninstall
arguments. Progress is recorded after each successful deletion so an interrupted
uninstall can be rerun without repeating completed destructive steps.
A partial installation where the Worker was never deployed is treated as an
already-complete Worker deletion, allowing its recorded KV and D1 cleanup to
continue.

## Connect Codex CLI

Use the exact HTTPS MCP endpoint printed by the installer:

```sh
codex mcp add wikimemory --url https://YOUR_WORKER_HOST/mcp
codex mcp login wikimemory --scopes memory:read,memory:write
```

Approve the MCP client in the browser with the owner passkey. Normal agent
connections request read/write scopes; use an administrative connection only when
restore tools are needed.

## Connect Claude Code

```sh
claude mcp add --transport http --scope user wikimemory https://YOUR_WORKER_HOST/mcp
```

Inside Claude Code, run `/mcp`, select Wikimemory, and approve with the passkey.
Claude stores and refreshes its Wikimemory OAuth tokens.

### Recover a stale connector session

An already-running conversation can retain the connector session it opened before
authentication. Start a new conversation or restart the CLI. If it still reports
unauthenticated, refresh the client-owned credentials:

```sh
codex mcp logout wikimemory
codex mcp login wikimemory --scopes memory:read,memory:write

claude mcp logout wikimemory
claude mcp login wikimemory
```

Then verify `orient` in a fresh conversation.

## Claude on the web and phone

In Claude's web settings, add a custom connector with
`https://YOUR_WORKER_HOST/mcp`, then approve it with the passkey. Because the MCP is
remote, the connector can be used from Claude web and mobile. Hosted clients cannot
reach a local `127.0.0.1` Worker.

## Install the agent skills

Symlink the repo skills for Claude:

```sh
mkdir -p ~/.claude/skills
ln -sfn "$PWD/skills/wikimemory-recall" ~/.claude/skills/wikimemory-recall
ln -sfn "$PWD/skills/wikimemory-ingest" ~/.claude/skills/wikimemory-ingest
ln -sfn "$PWD/skills/wikimemory-lint" ~/.claude/skills/wikimemory-lint
ln -sfn "$PWD/skills/wikimemory-install" ~/.claude/skills/wikimemory-install
```

For Codex, copy or symlink the same directories into `~/.codex/skills`.
Repository-local testing can use `.agents/skills` and `.claude/skills`. Restart the
client after adding skills. If skills are unavailable, paste the
[manual agent contract](manual-agent-instructions.md) into a session.

Archive import and automated `llmwiki` migration are intentionally unsupported in
V1. Do not upload a personal SQLite database to the Worker.
