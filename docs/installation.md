# Installation

V1 is a personal Cloudflare Worker protected by the owner's passkey. Local
development needs no cloud account. Production needs Node.js 22+, npm, a
Cloudflare account, and a device or password manager that supports passkeys. It
does not need a Google Cloud project or OAuth application.

## Packaged command line

The npm package provides the complete lifecycle without a source checkout:

```sh
npx --yes wikimemory install
npx --yes wikimemory status
npx --yes wikimemory upgrade
npx --yes wikimemory passkeys list
npx --yes wikimemory connect codex
npx --yes wikimemory skills install codex
npx --yes wikimemory uninstall
```

Each installation stores non-secret lifecycle state under
`~/.config/wikimemory/deployments/NAME/`. Use `--deployment NAME` consistently for
parallel installations. Worker source, React assets, migrations, and skills come
from the exact npm release, not the current directory.

## Run locally

Without a checkout:

```sh
npx --yes wikimemory dev
```

This retains local state under `./.wikimemory/dev/`. Extra arguments are passed to
Wrangler, for example `npx --yes wikimemory dev --port 8790`.

From a checkout:

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

Deploy from any directory with:

```sh
npx --yes wikimemory install
```

From a clean checkout, the maintainer equivalent is:

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
6. verifies both `/health` and the D1-backed `/ready` check;
7. writes a non-secret deployment record under
   `~/.config/wikimemory/deployments/` for checkout-free upgrades; and
8. prints the one-time passkey setup URL and client commands.

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

## Packaged upgrades

Upgrade without a source checkout:

```sh
npx --yes wikimemory upgrade
```

The command loads the deployment record written by setup, verifies the authenticated
Cloudflare account and immutable Worker/D1/KV targets, and compares both the running
application version and the D1 migration history with the packaged release manifest.
It shows the exact targets, version transition, and pending migrations before asking
for confirmation. It then applies only the missing ordered migration suffix, deploys
the package's Worker and compiled React assets, and verifies health, readiness, OAuth
discovery, application version, schema version, and the React shell.

Every bundled migration has a SHA-256 checksum verified during packaging and again
before an upgrade touches Cloudflare. Upgrade refuses modified release files,
unknown or reordered migration history, a newer installed schema, application
downgrades, account mismatches, and resource-ID/name mismatches. It never rotates the
setup secret, replaces passkeys, seeds fixtures, or deletes memory.

Custom or parallel installations use the Worker name as the deployment-record name:

```sh
npx --yes wikimemory upgrade --deployment my-memory
```

For testing an explicit record without changing the default, use
`--record /absolute/path/to/record.json`. `--yes` accepts the displayed plan for
noninteractive release automation.

The identical maintainer command from this checkout is:

```sh
npm run upgrade
```

Use `npx --yes wikimemory status` to verify the recorded and running application versions,
schema version, OAuth discovery, and React shell.

## Passkey recovery

Cloudflare account control is the recovery authority. The packaged command is:

```sh
npx --yes wikimemory recover
```

From the original checkout, the equivalent command is:

```sh
npm run setup -- --recover
```

The command asks for confirmation, writes a new hash to the Worker secret store, and
prints a new one-use URL. Existing passkeys continue working until the replacement
passkey verifies. Completion then replaces every old passkey and revokes all browser
sessions and MCP grants. Memory is not changed. Treat control of the Cloudflare
account and local production config as administrator access.

## Manage passkeys

Open `/app/manage` to list passkeys, add a named passkey, or revoke one credential.
The final credential cannot be revoked. These actions require a passkey sign-in from
the last five minutes; sign in again if the management session is older.

The owner CLI performs the same operations. Each command opens a browser and requires
the owner passkey; it does not use Cloudflare credentials:

```sh
npm run passkeys -- list
npm run passkeys -- add --name "Phone"
npm run passkeys -- revoke CREDENTIAL_REF
```

The checkout-free equivalents are `npx --yes wikimemory passkeys list`,
`npx --yes wikimemory passkeys add --name "Phone"`, and
`npx --yes wikimemory passkeys revoke CREDENTIAL_REF`.

The add command opens an expiring one-use registration page bound to the passkey that
authorized it. Revoking that credential invalidates its unused registration links
and blocks its browser sessions; recovery invalidates every outstanding registration
link. Use `setup -- --recover` only when no remaining passkey is available or all
existing credentials should be replaced.

## Uninstall a test deployment

Preview the exact resources recorded in the ignored production config:

```sh
npm run uninstall
```

Without a checkout, use `npx --yes wikimemory uninstall`. It reads the same exact targets
from the per-deployment state directory.

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

Cloud resource deletion cannot remove MCP registrations stored by clients or hosted
services. The uninstall preview and completion output therefore print the separate
client cleanup commands:

```sh
codex mcp logout wikimemory
codex mcp remove wikimemory

claude mcp logout wikimemory
claude mcp remove --scope user wikimemory
```

For Claude web and mobile, remove the custom connector separately from
**Settings > Connectors**. Repeat client cleanup on every machine or hosted client
where Wikimemory was registered.

## Connect Codex CLI

Use the exact HTTPS MCP endpoint printed by the installer:

```sh
codex mcp add wikimemory --url https://YOUR_WORKER_HOST/mcp
codex mcp login wikimemory --scopes memory:read,memory:write
```

Approve the MCP client in the browser with the owner passkey. Normal agent
connections request read/write scopes; use an administrative connection only when
restore tools are needed.

The packaged shortcut is `npx --yes wikimemory connect codex`.

## Connect Claude Code

```sh
claude mcp add --transport http --scope user wikimemory https://YOUR_WORKER_HOST/mcp
```

Inside Claude Code, run `/mcp`, select Wikimemory, and approve with the passkey.
Claude stores and refreshes its Wikimemory OAuth tokens.

The packaged shortcut is `npx --yes wikimemory connect claude`.

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

Install version-matched copies from the package, then restart the client:

```sh
npx --yes wikimemory skills install codex
npx --yes wikimemory skills install claude
```

From a checkout, symlink the repo skills for Claude:

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
