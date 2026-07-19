ALTER TABLE passkey_registration_tokens RENAME TO passkey_registration_tokens_unbound;

CREATE TABLE passkey_registration_tokens (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  authorizing_credential_id TEXT NOT NULL REFERENCES passkey_credentials(credential_id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

DROP TABLE passkey_registration_tokens_unbound;

CREATE INDEX idx_passkey_registration_tokens_expiry
  ON passkey_registration_tokens(expires_at);

CREATE INDEX idx_passkey_registration_tokens_authorizer
  ON passkey_registration_tokens(authorizing_credential_id);
