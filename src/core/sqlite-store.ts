import { copyFileSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { ApprovalMode, Effort, SessionMode, VendorId } from '@shared/agent'
import type { DraftState, LogEvent, SearchHit, SessionStatus, StoredEvent } from '@shared/api'
import type { AccessLevel, AuthMethod, DeviceActivity, DeviceFolder, DeviceKind, DeviceOs, DeviceRecord, DeviceShell, FolderMode } from '@shared/devices'
import { movesSession } from '@shared/status'
import { MIGRATIONS } from './migrations'
import type { RunEvent, RunSummary, StoredRunEvent, WorkflowDefinition } from '@shared/workflow'
import { toMatchQuery, type AttachmentRow, type IndexKind, type SessionRow, type StoredFolder, type Store, type WorkflowRow } from './store'

type Row = Record<string, unknown>

const SESSION_COLUMNS: Record<string, string> = {
  vendor: 'vendor',
  vendorSessionId: 'vendor_session_id',
  title: 'title',
  model: 'model',
  effort: 'effort',
  approval: 'approval',
  cwd: 'cwd',
  branch: 'branch',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
  pinnedAt: 'pinned_at'
}

function sessionFrom(r: Row): SessionRow {
  return {
    id: r.id as string,
    vendor: r.vendor as VendorId,
    mode: r.mode as SessionMode,
    title: r.title as string,
    model: r.model as string,
    effort: (r.effort ?? null) as Effort | null,
    approval: r.approval as ApprovalMode,
    ...(r.vendor_session_id != null ? { vendorSessionId: r.vendor_session_id as string } : {}),
    ...(r.cwd != null ? { cwd: r.cwd as string } : {}),
    ...(r.branch != null ? { branch: r.branch as string } : {}),
    status: r.status as SessionStatus,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    lastSeq: r.last_seq as number,
    deletedAt: (r.deleted_at ?? null) as number | null,
    pinnedAt: (r.pinned_at ?? null) as number | null
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

function deviceFrom(r: Row): DeviceRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as DeviceKind,
    host: r.host as string,
    port: r.port as number,
    username: r.username as string,
    authMethod: r.auth_method as AuthMethod,
    ...(r.key_path != null ? { keyPath: r.key_path as string } : {}),
    os: r.os as DeviceOs,
    shell: r.shell as DeviceShell,
    accessLevel: r.access_level as AccessLevel,
    hostKeySha256: (r.host_key_sha256 ?? null) as string | null,
    createdAt: r.created_at as number,
    lastSeenAt: (r.last_seen_at ?? null) as number | null
  }
}

const DEVICE_COLUMNS: Record<string, string> = {
  name: 'name',
  host: 'host',
  port: 'port',
  username: 'username',
  authMethod: 'auth_method',
  keyPath: 'key_path',
  os: 'os',
  shell: 'shell',
  accessLevel: 'access_level',
  hostKeySha256: 'host_key_sha256',
  lastSeenAt: 'last_seen_at'
}

function folderFrom(r: Row): StoredFolder {
  return {
    id: r.id as string,
    deviceId: r.device_id as string,
    path: r.path as string,
    mode: r.mode as FolderMode,
    snapshotPath: (r.snapshot_path ?? null) as string | null,
    snapshotAt: (r.snapshot_at ?? null) as number | null,
    bytes: r.bytes as number,
    files: r.files as number,
    createdAt: r.created_at as number
  }
}

function workflowFrom(r: Row): WorkflowRow {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    version: r.version as number,
    allowAssistant: r.allow_assistant === 1,
    definition: JSON.parse(r.definition_json as string) as WorkflowDefinition,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function runFrom(r: Row): RunSummary {
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    workflowName: r.workflow_name as string,
    version: r.version as number,
    status: r.status as RunSummary['status'],
    startedBy: r.started_by as RunSummary['startedBy'],
    inputs: JSON.parse(r.inputs_json as string) as RunSummary['inputs'],
    ...(r.session_id ? { sessionId: r.session_id as string } : {}),
    folder: r.folder as string,
    startedAt: r.started_at as number,
    ...(r.finished_at !== null ? { finishedAt: r.finished_at as number } : {}),
    ...(r.output !== null ? { output: r.output as string } : {}),
    ...(r.error !== null ? { error: r.error as string } : {})
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
      `INSERT INTO sessions (id, vendor, vendor_session_id, mode, title, model, effort, approval, cwd, branch, status, created_at, updated_at, last_seq, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.vendor, s.vendorSessionId ?? null, s.mode, s.title, s.model, s.effort, s.approval, s.cwd ?? null, s.branch ?? null,
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
      // The list is ordered by updated_at, which only the person's message and the end of a turn move (shared/status.ts).
      this.run('UPDATE sessions SET last_seq = ?, updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?', seq, movesSession(event) ? 1 : 0, at, sessionId)
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

  listWorkflows(): WorkflowRow[] {
    return this.all('SELECT * FROM workflows ORDER BY updated_at DESC').map(workflowFrom)
  }

  getWorkflow(id: string): WorkflowRow | undefined {
    const r = this.get('SELECT * FROM workflows WHERE id = ?', id)
    return r && workflowFrom(r)
  }

  saveWorkflow(w: WorkflowRow): void {
    const json = JSON.stringify(w.definition)
    this.run(
      `INSERT INTO workflows (id, name, description, version, allow_assistant, definition_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, version = excluded.version,
         allow_assistant = excluded.allow_assistant, definition_json = excluded.definition_json, updated_at = excluded.updated_at`,
      w.id, w.name, w.description, w.version, w.allowAssistant ? 1 : 0, json, w.createdAt, w.updatedAt
    )
    this.run('INSERT OR IGNORE INTO workflow_versions (workflow_id, version, definition_json, created_at) VALUES (?, ?, ?, ?)', w.id, w.version, json, w.updatedAt)
  }

  deleteWorkflow(id: string): void {
    this.run('DELETE FROM workflows WHERE id = ?', id)
  }

  workflowVersions(id: string): { version: number; createdAt: number }[] {
    return this.all('SELECT version, created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC', id).map((r) => ({ version: r.version as number, createdAt: r.created_at as number }))
  }

  workflowVersion(id: string, version: number): WorkflowDefinition | undefined {
    const r = this.get('SELECT definition_json FROM workflow_versions WHERE workflow_id = ? AND version = ?', id, version)
    return r && (JSON.parse(r.definition_json as string) as WorkflowDefinition)
  }

  insertRun(r: RunSummary): void {
    this.run(
      `INSERT INTO workflow_runs (id, workflow_id, workflow_name, version, status, started_by, inputs_json, session_id, folder, started_at, finished_at, output, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.workflowId, r.workflowName, r.version, r.status, r.startedBy, JSON.stringify(r.inputs), r.sessionId ?? null, r.folder, r.startedAt, r.finishedAt ?? null, r.output ?? null, r.error ?? null
    )
  }

  patchRun(id: string, patch: Partial<Pick<RunSummary, 'status' | 'finishedAt' | 'output' | 'error'>>): void {
    const columns: Record<string, string> = { status: 'status', finishedAt: 'finished_at', output: 'output', error: 'error' }
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !columns[key]) continue
      sets.push(`${columns[key]} = ?`)
      values.push(value)
    }
    if (sets.length) this.run(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`, ...values, id)
  }

  getRun(id: string): RunSummary | undefined {
    const r = this.get('SELECT * FROM workflow_runs WHERE id = ?', id)
    return r && runFrom(r)
  }

  listRuns(workflowId: string | undefined, limit: number): RunSummary[] {
    const rows = workflowId
      ? this.all('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?', workflowId, limit)
      : this.all('SELECT * FROM workflow_runs ORDER BY started_at DESC, rowid DESC LIMIT ?', limit)
    return rows.map(runFrom)
  }

  appendRunEvent(runId: string, at: number, event: RunEvent): StoredRunEvent {
    const next = ((this.get('SELECT MAX(seq) AS seq FROM run_events WHERE run_id = ?', runId)?.seq as number | null) ?? 0) + 1
    this.run('INSERT INTO run_events (run_id, seq, payload_json, created_at) VALUES (?, ?, ?, ?)', runId, next, JSON.stringify(event), at)
    return { seq: next, at, event }
  }

  runEvents(runId: string, afterSeq = 0): StoredRunEvent[] {
    return this.all('SELECT seq, payload_json, created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq', runId, afterSeq).map((r) => ({
      seq: r.seq as number,
      at: r.created_at as number,
      event: JSON.parse(r.payload_json as string) as RunEvent
    }))
  }

  listDevices(): DeviceRecord[] {
    return this.all('SELECT * FROM devices ORDER BY created_at').map(deviceFrom)
  }

  getDevice(id: string): DeviceRecord | undefined {
    const r = this.get('SELECT * FROM devices WHERE id = ?', id)
    return r && deviceFrom(r)
  }

  insertDevice(d: DeviceRecord): void {
    this.run(
      `INSERT INTO devices (id, name, kind, host, port, username, auth_method, key_path, os, shell, access_level, host_key_sha256, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id, d.name, d.kind, d.host, d.port, d.username, d.authMethod, d.keyPath ?? null, d.os, d.shell, d.accessLevel, d.hostKeySha256, d.createdAt, d.lastSeenAt
    )
  }

  patchDevice(id: string, patch: Partial<Omit<DeviceRecord, 'id' | 'createdAt'>>): DeviceRecord | undefined {
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      const column = DEVICE_COLUMNS[key]
      if (!column || value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (sets.length) this.run(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, ...values, id)
    return this.getDevice(id)
  }

  deleteDevice(id: string): DeviceFolder[] {
    return this.tx(() => {
      const folders = this.all('SELECT * FROM device_folders WHERE device_id = ?', id).map(folderFrom)
      this.run('DELETE FROM devices WHERE id = ?', id)
      return folders.map(({ snapshotPath: _path, ...folder }) => folder)
    })
  }

  setAttached(sessionId: string, deviceId: string, on: boolean): void {
    if (on) this.run('INSERT OR IGNORE INTO session_devices (session_id, device_id) VALUES (?, ?)', sessionId, deviceId)
    else this.run('DELETE FROM session_devices WHERE session_id = ? AND device_id = ?', sessionId, deviceId)
  }

  attachedDevices(sessionId: string): string[] {
    return this.all('SELECT device_id FROM session_devices WHERE session_id = ?', sessionId).map((r) => r.device_id as string)
  }

  listFolders(): DeviceFolder[] {
    return this.all('SELECT * FROM device_folders ORDER BY created_at').map((r) => {
      const { snapshotPath: _path, ...folder } = folderFrom(r)
      return folder
    })
  }

  getFolder(id: string): StoredFolder | undefined {
    const r = this.get('SELECT * FROM device_folders WHERE id = ?', id)
    return r && folderFrom(r)
  }

  insertFolder(f: StoredFolder): void {
    this.run(
      'INSERT INTO device_folders (id, device_id, path, mode, snapshot_path, snapshot_at, bytes, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.id, f.deviceId, f.path, f.mode, f.snapshotPath, f.snapshotAt, f.bytes, f.files, f.createdAt
    )
  }

  patchFolder(id: string, patch: Partial<Pick<DeviceFolder, 'snapshotAt' | 'bytes' | 'files'> & { snapshotPath: string | null }>): void {
    const columns: Record<string, string> = { snapshotAt: 'snapshot_at', bytes: 'bytes', files: 'files', snapshotPath: 'snapshot_path' }
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (!columns[key] || value === undefined) continue
      sets.push(`${columns[key]} = ?`)
      values.push(value)
    }
    if (sets.length) this.run(`UPDATE device_folders SET ${sets.join(', ')} WHERE id = ?`, ...values, id)
  }

  deleteFolder(id: string): StoredFolder | undefined {
    const row = this.getFolder(id)
    if (row) this.run('DELETE FROM device_folders WHERE id = ?', id)
    return row
  }

  addActivity(a: Omit<DeviceActivity, 'id'>): void {
    this.run('INSERT INTO device_activity (device_id, session_id, tool, summary, ok, bytes, at) VALUES (?, ?, ?, ?, ?, ?, ?)', a.deviceId, a.sessionId, a.tool, a.summary, a.ok ? 1 : 0, a.bytes, a.at)
  }

  activity(deviceId: string, limit: number): DeviceActivity[] {
    return this.all('SELECT * FROM device_activity WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?', deviceId, limit).map((r) => ({
      id: r.id as number,
      deviceId: r.device_id as string,
      sessionId: (r.session_id ?? null) as string | null,
      tool: r.tool as string,
      summary: r.summary as string,
      ok: r.ok === 1,
      bytes: r.bytes as number,
      at: r.at as number
    }))
  }

  close(): void {
    this.cache.clear()
    this.db.close()
  }
}
