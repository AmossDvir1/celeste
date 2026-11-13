/**
 * Database schema, one entry per version. Never edit an entry that has shipped: add a new one.
 * The version is stored in SQLite's `user_version`.
 */
export const MIGRATIONS: string[] = [
  // 1: sessions, their event log, attachments, drafts, settings and the search index
  `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    mode        TEXT NOT NULL,
    title       TEXT NOT NULL,
    model       TEXT NOT NULL,
    effort      TEXT,
    approval    TEXT NOT NULL,
    cwd         TEXT,
    branch      TEXT,
    status      TEXT NOT NULL DEFAULT 'idle',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    deleted_at  INTEGER
  );
  CREATE INDEX sessions_by_update ON sessions (deleted_at, updated_at DESC);

  CREATE TABLE events (
    session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;

  CREATE TABLE attachments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT REFERENCES sessions (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    file        TEXT NOT NULL,
    width       INTEGER,
    height      INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX attachments_by_session ON attachments (session_id);

  CREATE TABLE drafts (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE search USING fts5 (
    session_id UNINDEXED,
    kind UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,

  // 2: devices (remote machines and phones), which sessions they are attached to, their folders and activity
  `
  CREATE TABLE devices (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL,
    host             TEXT NOT NULL,
    port             INTEGER NOT NULL,
    username         TEXT NOT NULL,
    auth_method      TEXT NOT NULL,
    key_path         TEXT,
    os               TEXT NOT NULL DEFAULT 'unknown',
    shell            TEXT NOT NULL DEFAULT 'posix',
    access_level     TEXT NOT NULL DEFAULT 'read',
    host_key_sha256  TEXT,
    created_at       INTEGER NOT NULL,
    last_seen_at     INTEGER
  );

  CREATE TABLE session_devices (
    session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, device_id)
  );

  CREATE TABLE device_folders (
    id             TEXT PRIMARY KEY,
    device_id      TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    path           TEXT NOT NULL,
    mode           TEXT NOT NULL,
    snapshot_path  TEXT,
    snapshot_at    INTEGER,
    bytes          INTEGER NOT NULL DEFAULT 0,
    files          INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE device_activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    session_id  TEXT,
    tool        TEXT NOT NULL,
    summary     TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0,
    at          INTEGER NOT NULL
  );
  CREATE INDEX device_activity_by_device ON device_activity (device_id, at DESC);
  `,

  // 3: which vendor runs a session, and the id that vendor gave it so the next message can resume it.
  // Sessions made before this had only the scripted assistant; its model names say which vendor they imitated.
  `
  ALTER TABLE sessions ADD COLUMN vendor TEXT NOT NULL DEFAULT 'copilot';
  ALTER TABLE sessions ADD COLUMN vendor_session_id TEXT;
  UPDATE sessions SET vendor = CASE
    WHEN model LIKE 'claude-%' THEN 'claude'
    WHEN model LIKE 'openai-%' THEN 'openai'
    WHEN model LIKE 'gemini-%' THEN 'gemini'
    ELSE 'copilot' END;
  `,

  // 4: workflows, their saved versions, their runs and what happened in each run
  `
  CREATE TABLE workflows (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    version          INTEGER NOT NULL,
    allow_assistant  INTEGER NOT NULL DEFAULT 0,
    definition_json  TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE workflow_versions (
    workflow_id      TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    version          INTEGER NOT NULL,
    definition_json  TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (workflow_id, version)
  ) WITHOUT ROWID;

  CREATE TABLE workflow_runs (
    id             TEXT PRIMARY KEY,
    workflow_id    TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    workflow_name  TEXT NOT NULL,
    version        INTEGER NOT NULL,
    status         TEXT NOT NULL,
    started_by     TEXT NOT NULL,
    inputs_json    TEXT NOT NULL,
    session_id     TEXT,
    folder         TEXT NOT NULL,
    started_at     INTEGER NOT NULL,
    finished_at    INTEGER,
    output         TEXT,
    error          TEXT
  );
  CREATE INDEX workflow_runs_by_workflow ON workflow_runs (workflow_id, started_at DESC);

  CREATE TABLE run_events (
    run_id        TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    payload_json  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  ) WITHOUT ROWID;
  `,

  // 5: pinned sessions, with when each was pinned so the newest pin is listed first
  `
  ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;
  `
]
