import { copyFileSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { ApprovalMode, Effort, SessionMode } from '@shared/agent'
import type { DraftState, LogEvent, SearchHit, SessionStatus, StoredEvent } from '@shared/api'
import { MIGRATIONS } from './migrations'
import { toMatchQuery, type AttachmentRow, type IndexKind, type SessionRow, type Store } from './store'

type Row = Record<string, unknown>

const SESSION_COLUMNS: Record<string, string> = {
  title: 'title',
  model: 'model',
  effort: 'effort',
  approval: 'approval',
  cwd: 'cwd',
  branch: 'branch',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at'
}

function sessionFrom(r: Row): SessionRow {
  return {
    id: r.id as string,
    mode: r.mode as SessionMode,
    title: r.title as string,
    model: r.model as string,
    effort: (r.effort ?? null) as Effort | null,
    approval: r.approval as ApprovalMode,
    ...(r.cwd != null ? { cwd: r.cwd as string } : {}),
    ...(r.branch != null ? { branch: r.branch as string } : {}),
    status: r.status as SessionStatus,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    lastSeq: r.last_seq as number,
    deletedAt: (r.deleted_at ?? null) as number | null
  }
}

function attachmentFrom(r: Row): AttachmentRow {
  return {
    id: r.id as string,
    sessionId: (r.session_id ?? null) as string | null,
    name: r.name as string,
    mime: r.mime as string,
    bytes: r.bytes as number,
    file: r.file as string,
    ...(r.width != null ? { width: r.width as number } : {}),
    ...(r.height != null ? { height: r.height as number } : {}),
    createdAt: r.created_at as number
  }
}

/**
 * Brings the database up to the newest schema. A database made by a newer Celeste is refused, not touched.
 * Before an upgrade, a copy of the old file is kept next to it.
 */
function migrate(db: DatabaseSync, path: string): void {
  const current = (db.prepare('PRAGMA user_version').get() as Row).user_version as number
  if (current > MIGRATIONS.length) {
    throw new Error(`This data was saved by a newer version of Celeste (database version ${current}). Update Celeste to open it.`)
  }
  if (current === MIGRATIONS.length) return
  if (current > 0 && path !== ':memory:') {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(path, `${path}.v${current}.bak`)
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(MIGRATIONS[version])
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 3000')
    try {
      migrate(this.db, path)
    } catch (err) {
      // Do not leave the file locked when the data cannot be opened.
      this.db.close()
      throw err
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }
  private get(sql: string, ...params: unknown[]): Row | undefined {
    return this.stmt(sql).get(...(params as never[])) as Row | undefined
  }
  private all(sql: string, ...params: unknown[]): Row[] {
    return this.stmt(sql).all(...(params as never[])) as Row[]
  }
  private run(sql: string, ...params: unknown[]): void {
    this.stmt(sql).run(...(params as never[]))
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  insertSession(s: SessionRow): void {
    this.run(
      `INSERT INTO sessions (id, mode, title, model, effort, approval, cwd, branch, status, created_at, updated_at, last_seq, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.mode, s.title, s.model, s.effort, s.approval, s.cwd ?? null, s.branch ?? null,
      s.status, s.createdAt, s.updatedAt, s.lastSeq, s.deletedAt
    )
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.get('SELECT * FROM sessions WHERE id = ?', id)
    return r && sessionFrom(r)
  }

  listSessions(): SessionRow[] {
    return this.all('SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC').map(sessionFrom)
  }

  patchSession(id: string, patch: Partial<Omit<SessionRow, 'id' | 'lastSeq'>>): SessionRow | undefined {
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      const column = SESSION_COLUMNS[key]
      if (!column || value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (sets.length) this.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...values, id)
    return this.getSession(id)
  }

  listDeleted(): { id: string; deletedAt: number }[] {
    return this.all('SELECT id, deleted_at FROM sessions WHERE deleted_at IS NOT NULL').map((r) => ({
      id: r.id as string,
      deletedAt: r.deleted_at as number
    }))
  }

  purgeSession(id: string): AttachmentRow[] {
    return this.tx(() => {
      const files = this.all('SELECT * FROM attachments WHERE session_id = ?', id).map(attachmentFrom)
      this.run('DELETE FROM search WHERE session_id = ?', id)
      this.run('DELETE FROM drafts WHERE key = ?', id)
      this.run('DELETE FROM sessions WHERE id = ?', id)
      return files
    })
  }

  appendEvent(sessionId: string, at: number, event: LogEvent): StoredEvent {
    return this.tx(() => {
      const row = this.get('SELECT last_seq FROM sessions WHERE id = ?', sessionId)
      if (!row) throw new Error(`No session ${sessionId}`)
      const seq = (row.last_seq as number) + 1
      this.run('INSERT INTO events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)', sessionId, seq, event.type, JSON.stringify(event), at)
      this.run('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?', seq, at, sessionId)
      return { seq, at, event }
    })
  }

  events(sessionId: string, afterSeq = 0): StoredEvent[] {
    return this.all('SELECT seq, payload_json, created_at FROM events WHERE session_id = ? AND seq > ? ORDER BY seq', sessionId, afterSeq).map((r) => ({
      seq: r.seq as number,
      at: r.created_at as number,
      event: JSON.parse(r.payload_json as string) as LogEvent
    }))
  }

  index(sessionId: string, kind: IndexKind, text: string): void {
    this.tx(() => {
      if (kind === 'title') this.run("DELETE FROM search WHERE session_id = ? AND kind = 'title'", sessionId)
      if (text.trim()) this.run('INSERT INTO search (session_id, kind, text) VALUES (?, ?, ?)', sessionId, kind, text)
    })
  }

  search(query: string, limit: number): SearchHit[] {
    const match = toMatchQuery(query)
    if (!match) return []
    const rows = this.all(
      `SELECT s.id, s.title, s.mode, s.updated_at, search.kind AS kind, snippet(search, 2, '', '', '…', 14) AS snip
         FROM search JOIN sessions s ON s.id = search.session_id
        WHERE search MATCH ? AND s.deleted_at IS NULL
        ORDER BY bm25(search)
        LIMIT ?`,
      match,
      limit * 6
    )
    const hits = new Map<string, SearchHit>()
    for (const r of rows) {
      const id = r.id as string
      const existing = hits.get(id)
      // A title match is the clearest answer, so it wins over a snippet from the conversation.
      if (existing && (r.kind !== 'title' || existing.snippet === undefined)) continue
      hits.set(id, {
        sessionId: id,
        title: r.title as string,
        mode: r.mode as SessionMode,
        updatedAt: r.updated_at as number,
        ...(r.kind !== 'title' ? { snippet: r.snip as string } : {})
      })
    }
    return [...hits.values()].slice(0, limit)
  }

  settings(): Record<string, unknown> {
    return Object.fromEntries(this.all('SELECT key, value_json FROM settings').map((r) => [r.key as string, JSON.parse(r.value_json as string)]))
  }

  setSetting(key: string, value: unknown): void {
    this.run('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json', key, JSON.stringify(value))
  }

  drafts(): Record<string, DraftState> {
    return Object.fromEntries(this.all('SELECT key, value_json FROM drafts').map((r) => [r.key as string, JSON.parse(r.value_json as string) as DraftState]))
  }

  setDraft(key: string, draft: DraftState | null): void {
    if (!draft) {
      this.run('DELETE FROM drafts WHERE key = ?', key)
      return
    }
    this.run(
      'INSERT INTO drafts (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      key,
      JSON.stringify(draft),
      Date.now()
    )
  }

  insertAttachment(a: AttachmentRow): void {
    this.run(
      'INSERT INTO attachments (id, session_id, name, mime, bytes, file, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      a.id, a.sessionId, a.name, a.mime, a.bytes, a.file, a.width ?? null, a.height ?? null, a.createdAt
    )
  }

  attachment(id: string): AttachmentRow | undefined {
    const r = this.get('SELECT * FROM attachments WHERE id = ?', id)
    return r && attachmentFrom(r)
  }

  linkAttachments(ids: string[], sessionId: string): void {
    this.tx(() => {
      for (const id of ids) this.run('UPDATE attachments SET session_id = ? WHERE id = ? AND (session_id IS NULL OR session_id = ?)', sessionId, id, sessionId)
    })
  }

  deleteAttachment(id: string): AttachmentRow | undefined {
    const row = this.attachment(id)
    if (row) this.run('DELETE FROM attachments WHERE id = ?', id)
    return row
  }

  unlinkedAttachments(): AttachmentRow[] {
    return this.all('SELECT * FROM attachments WHERE session_id IS NULL').map(attachmentFrom)
  }

  close(): void {
    this.cache.clear()
    this.db.close()
  }
}
