# Security and threat model

## Assets

- current and historical memory content;
- document relationships, metadata, and search queries;
- identity, client, and audit provenance;
- OAuth authorization codes, access tokens, refresh tokens, and browser sessions;
- exported archives; and
- Cloudflare deployment credentials, passkeys, and one-time setup material.

## Trust boundaries

The human owner, authenticators, MCP clients, Cloudflare runtime, and stored source material
are separate trust domains. Claude and Codex are authorized callers, not database
administrators. Text inside a source document is untrusted even when the authenticated
owner asked an agent to store it.

V1 uses Cloudflare-managed encryption at rest and TLS in transit. It is not end-to-end
encrypted against the infrastructure provider. This limitation must be explicit in
the README and installation flow.

## Primary threats and controls

### Unauthorized access

- Require WebAuthn user verification for production owner authentication.
- Bind registration and authentication to the exact HTTPS origin and relying-party ID.
- Store credential public keys and counters, and update counters after successful use.
- Permit registration only with the current hashed, one-use bootstrap value.
- Implement OAuth protected-resource and authorization-server discovery.
- Require authorization code flow with PKCE and exact redirect URI validation.
- Bind access-token audience to the canonical MCP resource URI.
- Inject the canonical `/mcp` resource when a client omits RFC 8707 `resource` and
  reject every non-canonical resource value before completing authorization.
- Use short-lived access tokens and rotating refresh tokens with the pinned OAuth
  provider library's bounded previous-token retry window.
- Hash stored refresh tokens and browser session identifiers.
- Enforce scopes at the domain-service boundary, not only in route handlers.

### Cross-workspace data access

- Every domain query receives a workspace ID from authenticated context.
- Repository methods never accept an optional workspace.
- Foreign and unique keys include workspace where appropriate.
- Tests create two workspaces even though the V1 UI provisions one.

### Prompt injection and memory poisoning

- MCP descriptions and skills state that retrieved content is data, not instruction.
- `source` documents default to `trust=untrusted`.
- Search and get responses separate server provenance from document content.
- Stored content cannot change scopes, invoke tools, or select a different workspace.
- Audit provenance distinguishes authenticated subject, client, and untrusted agent
  label.

### Secret persistence

- Scan title, summary, body, and metadata for explicit, high-confidence credential
  formats before persistence.
- Return findings by field and category without echoing the full candidate.
- No MCP override exists. The owner must remove the secret before ingest.
- Purge exists for an already persisted secret and removes all historical content.

Generic entropy detection is intentionally excluded: generated filenames, report
identifiers, and ordinary URLs produced unacceptable false positives. The scanner
only recognizes private-key headers, AWS access-key IDs, known provider-token
prefixes, and explicit credential assignments. It is a backstop for obvious
accidents, not a general secret classifier.

### Concurrent writes and replay

- Require expected revision IDs for updates.
- Enforce parent/current equality in SQL.
- Require unique operation IDs and compare canonical request hashes on retry.
- Use server timestamps and server revision numbers.

### Destructive actions

- Agents cannot purge.
- Restore preview and restore apply are separate MCP tools; apply requires admin.
- Web purge requires an owner session, passkey authentication completed within five
  minutes, exact slug confirmation, CSRF validation, and a one-use purge
  authorization consumed in the deletion transaction.
- Purge audit events contain identifiers, counts, and hashes, never deleted text.

### Data exfiltration and denial of wallet

- No raw SQL tool, arbitrary fetch tool, or attachment upload exists.
- Bound all inputs, result counts, and MCP output sizes.
- Render stored bodies as text in React; never inject stored HTML into the DOM.
- Apply conservative request-rate limits in application code where practical, while
  treating provider-level rate infrastructure as deferred operational work.

### Logs and diagnostics

Allowed log fields are request ID, route/tool name, response code, duration, hashed
principal ID, and coarse counts. Forbidden log fields include bodies, titles,
summaries, metadata values, link labels, raw queries, OAuth material, cookies, and
authorization headers.

## Local-development safety

- Local authentication is available only in a named local environment.
- Production configuration validation fails closed if local auth or fixture seeding
  is enabled.
- Local D1 state lives under an ignored repository directory.
- Test exports and credentials use unmistakably fake data.

V1 exposes no archive import route. One-off migration is an unsupported local owner
operation and receives no agent-accessible secret-scan override.

## Purge mechanism

Database delete guards permit deletion only when a matching one-use authorization
row exists inside the same transaction. Purge explicitly deletes FTS and snapshot
children before revisions and the document; it does not rely on cascade-trigger
ordering. The authorization remains present through all guarded deletions and is
consumed last. Application code cannot drop immutability triggers.

The purge batch defers foreign-key checking while all parent-linked revisions are
removed, then restores checking before commit. Tests prove that the authorization
cannot be reused and that direct child, revision, or document deletion is rejected.

The sanitized audit event is inserted before deletion in the same transaction and
has no foreign key to the deleted document. Content-bearing operation results are
replaced by content-free `purged` tombstones before deletion. If any step fails,
neither deletion nor audit commit.

Passkey authentication requires user verification and records its server-verified
completion time. Purge requires that timestamp to be no older than five minutes;
absence of usable authentication-time evidence fails closed. The local identity
provider emits and tests the equivalent timestamp.

### Passkey bootstrap and recovery

- The installer generates 256 bits of random setup material and stores only its
  SHA-256 hash as a Worker secret.
- The raw value is printed once in a URL fragment and is not persisted by the
  installer or sent in the setup page's initial request.
- D1 records every consumed hash with a uniqueness constraint. Credential creation
  and consumption are one atomic batch, preventing concurrent reuse.
- A setup flow expires after five minutes and is deleted before verification.
- Authentication challenges are single-use D1 rows; expired rows are removed when
  new setup or authentication challenges are created.
- Recovery rotates the Worker secret through the owner's Cloudflare credentials.
  The old passkeys remain usable until the replacement credential verifies. That
  successful verification atomically keeps only the replacement credential and
  consumes the one-use recovery value; it also revokes every MCP grant and browser
  session.
- Normal passkey registration is separate from recovery. It requires a passkey
  authentication completed within five minutes and preserves existing credentials.
- Listing exposes a SHA-256 credential reference rather than the raw WebAuthn
  credential ID. Individual revocation also removes browser sessions established by
  that credential. Both service logic and a D1 trigger forbid revoking the final
  passkey.
- Passkey private keys never reach Wikimemory. D1 contains only credential IDs,
  public keys, counters, transport hints, and backup/device classifications.

Cloudflare account control is therefore the recovery authority. Recovery deliberately
invalidates the old credentials even when the incident is merely a lost device; the
owner must reconnect MCP clients and sign browser sessions in again.

## Security acceptance tests

- unknown passkeys and wrong workspaces are denied;
- missing, expired, incorrectly scoped, and wrong-audience tokens are denied;
- OAuth state, redirect URI, and PKCE failures are denied;
- wrong origin/RP ID, missing user verification, expired challenges, and reused
  setup values are denied;
- stale revisions and altered idempotent retries make no changes;
- secret fixtures are rejected without leaking candidates;
- ordinary SQL cannot update/delete immutable records;
- purge cannot run without its one-use authorization;
- logs and errors contain no fixture secrets or document bodies; and
- untrusted body text is returned only in explicitly labeled content fields.
