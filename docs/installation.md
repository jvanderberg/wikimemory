# Installation

Wikimemory deploys to your Cloudflare account and uses your passkey for owner
access. Local development needs no cloud account. Production needs Node.js 22+,
npm, a Cloudflare account, and a device or password manager that supports passkeys.
It does not need a Google Cloud project or OAuth application.

## Command line

Use the command line to install, manage, connect, and remove Wikimemory:

```sh
npx wikimemory install
npx wikimemory status
npx wikimemory browse
npx wikimemory upgrade
npx wikimemory passkeys list
npx wikimemory connect codex
npx wikimemory skills install codex
npx wikimemory uninstall
```

Each installation stores its non-secret deployment details under
`~/.config/wikimemory/deployments/NAME/`. Use `--deployment NAME` consistently for
parallel installations. Each command uses the files from the selected Wikimemory
release.

## Run locally

```sh
npx wikimemory dev
```

This retains local state under `./.wikimemory/dev/`. Extra arguments are passed to
Wrangler, for example `npx wikimemory dev --port 8790`.

Wrangler applies migrations to a local Miniflare D1 database and starts the Worker
at `http://127.0.0.1:8787`. Open `/app` and continue as the clearly marked fake local
owner. Only owner authentication is replaced locally: Wikimemory's OAuth
authorization code, PKCE, access/refresh tokens, scopes, and MCP transport remain
real. Contributors can find the repository workflows in the [testing guide](testing.md).

Passkeys also work on `localhost`, but the fixed local identity is the default test
path so routine development does not depend on a particular browser or authenticator.

## Guided Cloudflare deployment

First authenticate Wrangler:

```sh
npx wrangler login
```

Install Wikimemory with:

```sh
npx wikimemory install
```

Before changing anything, the installer displays the active Cloudflare identity and
the exact Worker, D1, and KV names and asks for confirmation. It then:

1. confirms that the requested remote names are unused;
2. creates the Worker address, D1 database, and KV namespace;
3. applies database updates and deploys Wikimemory;
4. creates a one-time owner setup URL;
5. verifies the deployment and saves its non-secret details for later commands.

The final handoff prints both the one-time passkey setup URL and a separately labeled
manual connector URL ending in `/mcp`. Paste that complete connector URL into Claude,
ChatGPT, or any other client configured by URL.

On a Cloudflare account that has never deployed a Worker, Cloudflare first requires
an account-wide `workers.dev` subdomain. The installer detects that condition before
creating D1 or KV, reconnects Wrangler directly to the terminal, and lets Wrangler
prompt for and register an available subdomain. Setup then continues automatically.
Non-interactive setup stops before creating storage and asks to be rerun in a terminal.

Open that setup URL on a phone or computer with a passkey-capable browser. The raw
setup value is in the URL fragment, so it is not sent in the initial HTTP request or
normal access logs. It is held in page memory only long enough to request passkey
registration, is never written to disk by the installer, and cannot be reused after
successful registration.

Use `--deployment` to choose a different name for the Worker and its storage:

```sh
npx wikimemory install --deployment my-memory
```

If Wrangler exposes more than one Cloudflare account, the installer asks which one
to use. Before provisioning, it also refuses collisions with existing Worker, D1, or
KV names; select unused custom names instead of overwriting or silently adopting
unrelated resources.

If provisioning stops after collision preflight, rerun with `--resume`. The ignored
installer state pins the preflighted account and resource names; existing bindings
are reused and missing stages continue. Resume refuses to run without proof that
collision preflight succeeded. Fresh deployment refuses to overwrite same-named
remote resources, and all uploads use Wrangler strict mode.

The installer does not delete or replace an existing production configuration.

## Upgrades

Upgrade the selected installation:

```sh
npx wikimemory upgrade
```

The command loads the deployment record written by setup, verifies the authenticated
Cloudflare account and immutable Worker/D1/KV targets, and compares both the running
application version and the D1 migration history with the selected release.
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
npx wikimemory upgrade --deployment my-memory
```

Use `npx wikimemory status` to verify the deployment. Its output labels the browser
address as **Web app** and the manual connector address as **MCP endpoint**; always
copy the complete MCP endpoint, including `/mcp`, into a connector. Use
`npx wikimemory browse` to open the web application directly.

## Passkey recovery

If every passkey is lost, access to the Cloudflare account lets the owner recover.
Start recovery with:

```sh
npx wikimemory recover
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
npx wikimemory passkeys list
npx wikimemory passkeys add --name "Phone"
npx wikimemory passkeys revoke CREDENTIAL_REF
```

The add command opens an expiring one-use registration page bound to the passkey that
authorized it. Revoking that credential invalidates its unused registration links
and blocks its browser sessions; recovery invalidates every outstanding registration
link. Use `npx wikimemory recover` only when no remaining passkey is available or all
existing credentials should be replaced.

## Uninstall

Preview the exact cloud resources recorded for the installation:

```sh
npx wikimemory uninstall
```

It reads the exact targets from the per-deployment state directory.

Preview mode does not call any deletion command. To remove the deployment, run:

```sh
npx wikimemory uninstall --apply
```

The workflow requires typing the exact Worker name, then deletes that Worker, its
recorded KV namespace, and its recorded D1 database before removing the local
deployment record and installer state. D1 deletion permanently destroys the remote
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

## Connect Codex

Connect Codex using the saved deployment details:

```sh
npx wikimemory connect codex
```

The command registers the MCP server and starts browser approval with the owner
passkey. Normal agent connections request read/write access; use an administrative
connection only when restore tools are needed.

To configure Codex manually or use a custom connection name, use the exact HTTPS MCP
endpoint printed by the installer:

```sh
codex mcp add wikimemory --url https://YOUR_WORKER_HOST/mcp
codex mcp login wikimemory --scopes memory:read,memory:write
```

## Connect Claude Code

Connect Claude Code using the saved deployment details:

```sh
npx wikimemory connect claude
```

The command registers the MCP server and starts browser approval with the owner
passkey. Claude stores and refreshes its Wikimemory OAuth tokens. Inside Claude Code,
run `/mcp` afterward to verify the connection.

To configure Claude Code manually or use a custom connection name:

```sh
claude mcp add --transport http --scope user wikimemory https://YOUR_WORKER_HOST/mcp
claude mcp login wikimemory
```

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
remote, the same connector is available from Claude web and mobile.

The `/mcp` suffix is required. The bare Worker URL is the Wikimemory web application,
not the connector endpoint.

## ChatGPT on the web and phone

ChatGPT setup starts on the web, following
[OpenAI's developer-mode app flow](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt):

1. Open **Settings → Security and login** and enable **Developer mode**. A managed
   workspace may require an administrator to allow it.
2. Open **Settings → Plugins**, select the plus button, and create an app using the
   Wikimemory HTTPS `/mcp` URL printed by the installer.
3. Complete authorization with the owner passkey.
4. Start a new chat, select the plus button by the composer, choose **More**, and
   select Wikimemory.

After the app is linked on ChatGPT web, it is also available in the ChatGPT mobile
app. ChatGPT and Codex keep separate connector registrations and authorization.
As with Claude, the bare Worker URL is not a connector endpoint.

## Install the agent skills

Install version-matched copies from the package, then restart the client:

```sh
npx wikimemory skills install codex
npx wikimemory skills install claude
```

Restart the client after adding skills. If skills are unavailable, paste the
[manual agent contract](manual-agent-instructions.md) into a session.

Use `wikimemory backup` and `wikimemory restore` for portable ZIP archives. Convert
other source formats locally with the documented CRUD API; never upload a SQLite
database to the Worker.
