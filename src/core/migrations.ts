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
  `
]
