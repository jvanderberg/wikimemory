ALTER TABLE passkey_credentials
  ADD COLUMN label TEXT NOT NULL DEFAULT 'Passkey'
  CHECK (length(label) BETWEEN 1 AND 80);

CREATE TRIGGER prevent_last_passkey_delete
BEFORE DELETE ON passkey_credentials
WHEN (SELECT COUNT(*) FROM passkey_credentials WHERE principal_id = OLD.principal_id) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot delete final passkey');
END;

CREATE TABLE passkey_registration_tokens (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_passkey_registration_tokens_expiry
  ON passkey_registration_tokens(expires_at);

CREATE TABLE passkey_challenges_new (
  flow_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'mcp', 'web', 'registration')),
  challenge TEXT NOT NULL,
  payload_json TEXT,
  token_hash TEXT,
  expires_at TEXT NOT NULL
);

INSERT INTO passkey_challenges_new(flow_id, kind, challenge, payload_json, token_hash, expires_at)
SELECT flow_id, kind, challenge, payload_json, token_hash, expires_at
FROM passkey_challenges;

DROP TABLE passkey_challenges;
ALTER TABLE passkey_challenges_new RENAME TO passkey_challenges;
CREATE INDEX idx_passkey_challenges_expiry ON passkey_challenges(expires_at);
