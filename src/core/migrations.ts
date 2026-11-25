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
  `,

  // 6: scheduled workflows (docs/plans/SCHEDULING_PLAN.md): what the person approved and when to run it, what a schedule skipped or missed,
  // and which schedule started a run
  `
  CREATE TABLE workflow_schedules (
    id               TEXT PRIMARY KEY,
    workflow_id      TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
    enabled          INTEGER NOT NULL,
    spec_json        TEXT NOT NULL,
    timezone         TEXT NOT NULL,
    inputs_json      TEXT NOT NULL,
    folder           TEXT NOT NULL,
    approved_version INTEGER NOT NULL,
    approved_hash    TEXT NOT NULL,
    approved_at      INTEGER NOT NULL,
    grace_sec        INTEGER NOT NULL,
    wait_limit_sec   INTEGER NOT NULL,
    notify           TEXT NOT NULL,
    next_run_at      INTEGER,
    last_fire_at     INTEGER,
    fail_streak      INTEGER NOT NULL DEFAULT 0,
    paused_reason    TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX workflow_schedules_due ON workflow_schedules (enabled, next_run_at);

  CREATE TABLE workflow_schedule_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id  TEXT NOT NULL REFERENCES workflow_schedules (id) ON DELETE CASCADE,
    at           INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    text         TEXT NOT NULL
  );
  CREATE INDEX workflow_schedule_log_by_schedule ON workflow_schedule_log (schedule_id, id DESC);

  ALTER TABLE workflow_runs ADD COLUMN schedule_id TEXT;
  CREATE INDEX workflow_runs_by_schedule ON workflow_runs (schedule_id, started_at DESC);
  `,

  // 7: helpers (docs/plans/SUB_AGENTS_PLAN.md): a session the assistant of another session started. `spawn` is how it was started (JSON),
  // `parent_id` the same parent for the index and for deleting a parent's helpers with it
  `
  ALTER TABLE sessions ADD COLUMN spawn TEXT;
  ALTER TABLE sessions ADD COLUMN parent_id TEXT;
  CREATE INDEX sessions_parent ON sessions (parent_id);
  `,

  // 8: Two Moons (docs/plans/TWO_MOONS_PLAN.md): `moons` says that a chat has two agents, as JSON: the pattern and the id of the second one's session
  `
  ALTER TABLE sessions ADD COLUMN moons TEXT;
  `
]
