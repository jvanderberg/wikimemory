PRAGMA foreign_keys = ON;
PRAGMA recursive_triggers = ON;

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  display_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject),
  UNIQUE (provider, email)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id)
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL CHECK (type IN ('system', 'project', 'topic', 'source', 'note')),
  slug TEXT NOT NULL CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, id)
);

CREATE TABLE operations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK (kind IN ('ingest', 'link', 'restore')),
  status TEXT NOT NULL CHECK (status IN ('completed', 'purged')),
  result_document_id TEXT,
  result_revision_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  parent_revision_id TEXT,
  title TEXT NOT NULL CHECK (length(title) <= 300),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 262144),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 1000),
  created_at TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  client_id TEXT NOT NULL,
  agent_label TEXT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  restored_from_revision_id TEXT,
  UNIQUE (doc_id, revision_number),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, doc_id) REFERENCES documents(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (parent_revision_id) REFERENCES revisions(id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (restored_from_revision_id) REFERENCES revisions(id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, operation_id)
    REFERENCES operations(workspace_id, operation_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_revisions_current
  ON revisions(workspace_id, doc_id, revision_number DESC);

CREATE TABLE revision_metadata (
  workspace_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
  value TEXT NOT NULL CHECK (length(value) <= 4096),
  cardinality TEXT NOT NULL CHECK (cardinality IN ('singleton', 'multi')),
  UNIQUE (revision_id, key, value),
  FOREIGN KEY (workspace_id, revision_id) REFERENCES revisions(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_revision_metadata_lookup
  ON revision_metadata(workspace_id, key, value, revision_id);

CREATE TABLE revision_links (
  workspace_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('related', 'part_of', 'supersedes', 'cites', 'contradicts')),
  target_slug TEXT NOT NULL,
  target_document_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('explicit', 'body')),
  UNIQUE (revision_id, kind, target_slug, origin),
  FOREIGN KEY (workspace_id, revision_id) REFERENCES revisions(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, target_document_id) REFERENCES documents(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_revision_links_target
  ON revision_links(workspace_id, target_slug, revision_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  principal_id TEXT,
  client_id TEXT,
  agent_label TEXT,
  document_id TEXT,
  revision_id TEXT,
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_audit_events_workspace_time
  ON audit_events(workspace_id, created_at, id);

CREATE TABLE purge_authorizations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, document_id, id)
);

CREATE VIRTUAL TABLE current_fts USING fts5(
  workspace_id UNINDEXED,
  document_id UNINDEXED,
  slug UNINDEXED,
  title,
  summary,
  body,
  tokenize = 'unicode61'
);

CREATE VIEW current_revisions AS
SELECT r.*
FROM revisions r
JOIN (
  SELECT doc_id, MAX(revision_number) AS revision_number
  FROM revisions
  GROUP BY doc_id
) latest
  ON latest.doc_id = r.doc_id
 AND latest.revision_number = r.revision_number;

CREATE TRIGGER revisions_validate_insert
BEFORE INSERT ON revisions
BEGIN
  SELECT CASE
    WHEN NEW.revision_number != COALESCE(
      (SELECT MAX(revision_number) + 1 FROM revisions WHERE doc_id = NEW.doc_id), 1
    )
    THEN RAISE(ABORT, 'revision_conflict:number')
  END;
  SELECT CASE
    WHEN NEW.parent_revision_id IS NOT (
      SELECT id FROM revisions WHERE doc_id = NEW.doc_id
      ORDER BY revision_number DESC LIMIT 1
    )
    THEN RAISE(ABORT, 'revision_conflict:parent')
  END;
  SELECT CASE
    WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM revisions
      WHERE id = NEW.parent_revision_id
        AND workspace_id = NEW.workspace_id
        AND doc_id = NEW.doc_id
    )
    THEN RAISE(ABORT, 'revision_conflict:foreign_parent')
  END;
END;

CREATE TRIGGER revisions_refresh_fts
AFTER INSERT ON revisions
BEGIN
  DELETE FROM current_fts
  WHERE workspace_id = NEW.workspace_id AND document_id = NEW.doc_id;
  INSERT INTO current_fts(workspace_id, document_id, slug, title, summary, body)
  SELECT NEW.workspace_id, NEW.doc_id, d.slug, NEW.title, COALESCE(NEW.summary, ''), NEW.body
  FROM documents d WHERE d.id = NEW.doc_id AND d.workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER metadata_singleton_guard
BEFORE INSERT ON revision_metadata
WHEN NEW.cardinality = 'singleton'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM revision_metadata
    WHERE revision_id = NEW.revision_id AND key = NEW.key
  ) THEN RAISE(ABORT, 'metadata_singleton_conflict') END;
END;

CREATE TRIGGER documents_immutable_update
BEFORE UPDATE ON documents
BEGIN SELECT RAISE(ABORT, 'documents are immutable'); END;

CREATE TRIGGER revisions_immutable_update
BEFORE UPDATE ON revisions
BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;

CREATE TRIGGER metadata_immutable_update
BEFORE UPDATE ON revision_metadata
BEGIN SELECT RAISE(ABORT, 'revision metadata is immutable'); END;

CREATE TRIGGER links_immutable_update
BEFORE UPDATE ON revision_links
BEGIN SELECT RAISE(ABORT, 'revision links are immutable'); END;

CREATE TRIGGER audit_immutable_update
BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TRIGGER audit_immutable_delete
BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TRIGGER documents_guard_delete
BEFORE DELETE ON documents
WHEN NOT EXISTS (
  SELECT 1 FROM purge_authorizations p
  WHERE p.workspace_id = OLD.workspace_id
    AND p.document_id = OLD.id
    AND p.expires_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'document deletion requires purge authorization'); END;

CREATE TRIGGER revisions_guard_delete
BEFORE DELETE ON revisions
WHEN NOT EXISTS (
  SELECT 1 FROM purge_authorizations p
  WHERE p.workspace_id = OLD.workspace_id
    AND p.document_id = OLD.doc_id
    AND p.expires_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'revision deletion requires purge authorization'); END;

CREATE TRIGGER metadata_guard_delete
BEFORE DELETE ON revision_metadata
WHEN NOT EXISTS (
  SELECT 1 FROM revisions r
  JOIN purge_authorizations p
    ON p.workspace_id = r.workspace_id AND p.document_id = r.doc_id
  WHERE r.id = OLD.revision_id
    AND p.expires_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'metadata deletion requires purge authorization'); END;

CREATE TRIGGER links_guard_delete
BEFORE DELETE ON revision_links
WHEN NOT EXISTS (
  SELECT 1 FROM revisions r
  JOIN purge_authorizations p
    ON p.workspace_id = r.workspace_id AND p.document_id = r.doc_id
  WHERE r.id = OLD.revision_id
    AND p.expires_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
)
BEGIN SELECT RAISE(ABORT, 'link deletion requires purge authorization'); END;

CREATE TRIGGER operations_guard_delete
BEFORE DELETE ON operations
BEGIN SELECT RAISE(ABORT, 'operations cannot be deleted'); END;

CREATE TRIGGER operations_guard_update
BEFORE UPDATE ON operations
WHEN NOT (
  NEW.status = 'purged'
  AND NEW.result_document_id IS NULL
  AND NEW.result_revision_id IS NULL
  AND OLD.result_document_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM purge_authorizations p
    WHERE p.workspace_id = OLD.workspace_id
      AND p.document_id = OLD.result_document_id
      AND p.expires_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  )
)
BEGIN SELECT RAISE(ABORT, 'operation mutation requires purge authorization'); END;
