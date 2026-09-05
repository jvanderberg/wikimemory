ALTER TABLE passkey_challenges ADD COLUMN created_at TEXT;

CREATE TABLE authorization_decisions (
  flow_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('approved', 'denied')),
  redirect_to TEXT,
  decided_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_authorization_decisions_expiry ON authorization_decisions(expires_at);
