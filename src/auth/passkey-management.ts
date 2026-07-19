import { sha256 } from "../domain/crypto";
import { DomainError } from "../domain/errors";

const PRINCIPAL_ID = "passkey-owner";
const RECENT_AUTH_SECONDS = 300;
const TOKEN_TTL_SECONDS = 300;

interface PasskeyRow {
  credential_id: string;
  label: string;
  device_type: "singleDevice" | "multiDevice";
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

export interface PasskeySummary {
  credentialRef: string;
  label: string;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RegistrationToken {
  rawToken: string;
  expiresAt: string;
}

function tokenValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function requireRecentPasskeyAuthentication(reauthenticatedAt: string): void {
  const timestamp = Date.parse(reauthenticatedAt);
  if (
    !Number.isFinite(timestamp) ||
    Date.now() - timestamp > RECENT_AUTH_SECONDS * 1000 ||
    timestamp > Date.now() + 30_000
  ) {
    throw new DomainError(
      "reauthentication_required",
      "Passkey management requires authentication within the last five minutes"
    );
  }
}

async function rows(db: D1Database): Promise<PasskeyRow[]> {
  const result = await db
    .prepare(`SELECT credential_id, label, device_type, backed_up, created_at, last_used_at
    FROM passkey_credentials WHERE principal_id = ? ORDER BY created_at, credential_id`)
    .bind(PRINCIPAL_ID)
    .all<PasskeyRow>();
  return result.results;
}

export async function listPasskeys(db: D1Database): Promise<PasskeySummary[]> {
  return await Promise.all(
    (await rows(db)).map(async (row) => ({
      credentialRef: await sha256(row.credential_id),
      label: row.label,
      deviceType: row.device_type,
      backedUp: row.backed_up === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at
    }))
  );
}

export async function revokePasskey(db: D1Database, credentialRef: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(credentialRef))
    throw new DomainError("validation_failed", "Invalid passkey reference");
  const existing = await rows(db);
  if (existing.length <= 1)
    throw new DomainError("validation_failed", "The final passkey cannot be revoked");
  let selected: PasskeyRow | undefined;
  for (const row of existing) {
    if ((await sha256(row.credential_id)) === credentialRef) selected = row;
  }
  if (selected === undefined) throw new DomainError("not_found", "Passkey not found");
  const result = await db
    .prepare("DELETE FROM passkey_credentials WHERE credential_id = ? AND principal_id = ?")
    .bind(selected.credential_id, PRINCIPAL_ID)
    .run();
  if (result.meta.changes !== 1)
    throw new DomainError("revision_conflict", "Passkey changed before it could be revoked");
  return selected.credential_id;
}

export async function createRegistrationToken(
  db: D1Database,
  labelInput: string
): Promise<RegistrationToken> {
  const label = labelInput.trim();
  if (label.length < 1 || label.length > 80)
    throw new DomainError("validation_failed", "Passkey name must be 1 to 80 characters");
  const rawToken = tokenValue();
  const tokenHash = await sha256(rawToken);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM passkey_registration_tokens WHERE expires_at <= ?").bind(createdAt),
    db
      .prepare(`INSERT INTO passkey_registration_tokens(token_hash, principal_id, label, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(tokenHash, PRINCIPAL_ID, label, expiresAt, createdAt)
  ]);
  return { rawToken, expiresAt };
}

export async function registrationToken(
  db: D1Database,
  rawToken: string
): Promise<{ tokenHash: string; label: string } | null> {
  if (rawToken.length < 32 || rawToken.length > 512) return null;
  const tokenHash = await sha256(rawToken);
  const row = await db
    .prepare(`SELECT label FROM passkey_registration_tokens
    WHERE token_hash = ? AND principal_id = ? AND expires_at > ?`)
    .bind(tokenHash, PRINCIPAL_ID, new Date().toISOString())
    .first<{ label: string }>();
  return row === null ? null : { tokenHash, label: row.label };
}

export const PASSKEY_OWNER_ID = PRINCIPAL_ID;
