CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  transports_json TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX idx_passkey_credentials_principal
  ON passkey_credentials(principal_id, created_at);

CREATE TABLE passkey_bootstrap (
  used_token_hash TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);

CREATE TABLE passkey_challenges (
  flow_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'mcp', 'web')),
  challenge TEXT NOT NULL,
  payload_json TEXT,
  token_hash TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_passkey_challenges_expiry ON passkey_challenges(expires_at);
