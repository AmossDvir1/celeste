import type { DraftState, LogEvent, SearchHit, StoredEvent } from '@shared/api'
import type { DeviceActivity, DeviceFolder, DeviceRecord } from '@shared/devices'
import type { AttachmentRow, FileStore, IndexKind, SessionRow, StoredFolder, Store } from '../store'

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The same contract as SqliteStore, held in memory. It backs the service tests,
 * which need no database. Values are copied in and out, as a database would.
 */
export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRow>()
  private logs = new Map<string, StoredEvent[]>()
  private indexRows: { sessionId: string; kind: IndexKind; text: string }[] = []
  private kv = new Map<string, unknown>()
  private draftMap = new Map<string, DraftState>()
  private files = new Map<string, AttachmentRow>()
  private devs = new Map<string, DeviceRecord>()
  private attached = new Map<string, Set<string>>()
  private folders = new Map<string, StoredFolder>()
  private acts: DeviceActivity[] = []
  private actId = 0

  insertSession(row: SessionRow): void {
    if (this.sessions.has(row.id)) throw new Error(`Session ${row.id} exists`)
    this.sessions.set(row.id, structuredClone(row))
    this.logs.set(row.id, [])
  }

  getSession(id: string): SessionRow | undefined {
    const s = this.sessions.get(id)
    return s && structuredClone(s)
  }

  listSessions(): SessionRow[] {
    return [...this.sessions.values()]
      .filter((s) => s.deletedAt === null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => structuredClone(s))
  }

  patchSession(id: string, patch: Partial<Omit<SessionRow, 'id' | 'lastSeq'>>): SessionRow | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (s as unknown as Record<string, unknown>)[key] = value
    }
    return structuredClone(s)
  }

  listDeleted(): { id: string; deletedAt: number }[] {
    return [...this.sessions.values()].filter((s) => s.deletedAt !== null).map((s) => ({ id: s.id, deletedAt: s.deletedAt as number }))
  }

  purgeSession(id: string): AttachmentRow[] {
    const gone = [...this.files.values()].filter((a) => a.sessionId === id)
    gone.forEach((a) => this.files.delete(a.id))
    this.sessions.delete(id)
    this.logs.delete(id)
    this.draftMap.delete(id)
    this.attached.delete(id)
    this.indexRows = this.indexRows.filter((r) => r.sessionId !== id)
    return structuredClone(gone)
  }

  appendEvent(sessionId: string, at: number, event: LogEvent): StoredEvent {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`No session ${sessionId}`)
    s.lastSeq += 1
    s.updatedAt = at
    const stored: StoredEvent = { seq: s.lastSeq, at, event: structuredClone(event) }
    this.logs.get(sessionId)?.push(stored)
    return structuredClone(stored)
  }

  events(sessionId: string, afterSeq = 0): StoredEvent[] {
    return structuredClone((this.logs.get(sessionId) ?? []).filter((e) => e.seq > afterSeq))
  }

  index(sessionId: string, kind: IndexKind, text: string): void {
    if (kind === 'title') this.indexRows = this.indexRows.filter((r) => !(r.sessionId === sessionId && r.kind === 'title'))
    if (text.trim()) this.indexRows.push({ sessionId, kind, text })
  }

  search(query: string, limit: number): SearchHit[] {
    const terms = (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map(fold)
    if (terms.length === 0) return []
    const hits = new Map<string, SearchHit>()
    for (const row of this.indexRows) {
      const session = this.sessions.get(row.sessionId)
      if (!session || session.deletedAt !== null) continue
      const text = fold(row.text)
      const words = text.match(/[\p{L}\p{N}]+/gu) ?? []
      if (!terms.every((t) => words.some((w) => w.startsWith(t)))) continue
      const existing = hits.get(session.id)
      if (existing && (row.kind !== 'title' || existing.snippet === undefined)) continue
      const at = Math.max(0, text.indexOf(terms[0]))
      hits.set(session.id, {
        sessionId: session.id,
        title: session.title,
        mode: session.mode,
        updatedAt: session.updatedAt,
        ...(row.kind !== 'title' ? { snippet: `${at > 0 ? '…' : ''}${row.text.slice(Math.max(0, at - 30), at + 80)}` } : {})
      })
    }
    return [...hits.values()].slice(0, limit)
  }

  settings(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.kv))
  }
  setSetting(key: string, value: unknown): void {
    this.kv.set(key, structuredClone(value))
  }

  drafts(): Record<string, DraftState> {
    return structuredClone(Object.fromEntries(this.draftMap))
  }
  setDraft(key: string, draft: DraftState | null): void {
    if (draft) this.draftMap.set(key, structuredClone(draft))
    else this.draftMap.delete(key)
  }

  insertAttachment(row: AttachmentRow): void {
    this.files.set(row.id, structuredClone(row))
  }
  attachment(id: string): AttachmentRow | undefined {
    const a = this.files.get(id)
    return a && structuredClone(a)
  }
  linkAttachments(ids: string[], sessionId: string): void {
    for (const id of ids) {
      const a = this.files.get(id)
      if (a && (a.sessionId === null || a.sessionId === sessionId)) a.sessionId = sessionId
    }
  }
  deleteAttachment(id: string): AttachmentRow | undefined {
    const a = this.files.get(id)
    this.files.delete(id)
    return a && structuredClone(a)
  }
  unlinkedAttachments(): AttachmentRow[] {
    return structuredClone([...this.files.values()].filter((a) => a.sessionId === null))
  }

  listDevices(): DeviceRecord[] {
    return structuredClone([...this.devs.values()].sort((a, b) => a.createdAt - b.createdAt))
  }
  getDevice(id: string): DeviceRecord | undefined {
    const d = this.devs.get(id)
    return d && structuredClone(d)
  }
  insertDevice(device: DeviceRecord): void {
    this.devs.set(device.id, structuredClone(device))
  }
  patchDevice(id: string, patch: Partial<Omit<DeviceRecord, 'id' | 'createdAt'>>): DeviceRecord | undefined {
    const d = this.devs.get(id)
    if (!d) return undefined
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (d as unknown as Record<string, unknown>)[key] = value
    }
    return structuredClone(d)
  }
  deleteDevice(id: string): DeviceFolder[] {
    const gone = [...this.folders.values()].filter((f) => f.deviceId === id)
    gone.forEach((f) => this.folders.delete(f.id))
    this.devs.delete(id)
    this.attached.forEach((set) => set.delete(id))
    this.acts = this.acts.filter((a) => a.deviceId !== id)
    return structuredClone(gone.map(({ snapshotPath: _p, ...folder }) => folder))
  }
  setAttached(sessionId: string, deviceId: string, on: boolean): void {
    const set = this.attached.get(sessionId) ?? new Set<string>()
    if (on) set.add(deviceId)
    else set.delete(deviceId)
    this.attached.set(sessionId, set)
  }
  attachedDevices(sessionId: string): string[] {
    return [...(this.attached.get(sessionId) ?? [])]
  }
  listFolders(): DeviceFolder[] {
    return structuredClone([...this.folders.values()].sort((a, b) => a.createdAt - b.createdAt).map(({ snapshotPath: _p, ...folder }) => folder))
  }
  getFolder(id: string): StoredFolder | undefined {
    const f = this.folders.get(id)
    return f && structuredClone(f)
  }
  insertFolder(folder: StoredFolder): void {
    this.folders.set(folder.id, structuredClone(folder))
  }
  patchFolder(id: string, patch: Partial<Pick<DeviceFolder, 'snapshotAt' | 'bytes' | 'files'> & { snapshotPath: string | null }>): void {
    const f = this.folders.get(id)
    if (!f) return
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (f as unknown as Record<string, unknown>)[key] = value
    }
  }
  deleteFolder(id: string): StoredFolder | undefined {
    const f = this.folders.get(id)
    this.folders.delete(id)
    return f && structuredClone(f)
  }
  addActivity(row: Omit<DeviceActivity, 'id'>): void {
    this.acts.push({ ...row, id: ++this.actId })
  }
  activity(deviceId: string, limit: number): DeviceActivity[] {
    return structuredClone(this.acts.filter((a) => a.deviceId === deviceId).sort((a, b) => b.at - a.at || b.id - a.id).slice(0, limit))
  }

  close(): void {}
}

/** Attachment bytes in memory, shown through object URLs. Tests only. */
export class MemoryFileStore implements FileStore {
  private blobs = new Map<string, { url: string }>()

  save(id: string, ext: string, mime: string, data: ArrayBuffer): { file: string; url: string } {
    const file = `${id}.${ext}`
    const url = typeof URL !== 'undefined' && 'createObjectURL' in URL ? URL.createObjectURL(new Blob([data], { type: mime })) : `memory://${file}`
    this.blobs.set(file, { url })
    return { file, url }
  }

  remove(file: string): void {
    const entry = this.blobs.get(file)
    if (entry && entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url)
    this.blobs.delete(file)
  }
}
