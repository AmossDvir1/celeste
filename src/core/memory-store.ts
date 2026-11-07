import type { DraftState, LogEvent, SearchHit, StoredEvent } from '@shared/api'
import type { AttachmentRow, FileStore, IndexKind, SessionRow, Store } from './store'

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The same contract as SqliteStore, held in memory. It backs the browser preview (`npm run dev:web`),
 * where there is no database, and the service tests. Values are copied in and out, as a database would.
 */
export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRow>()
  private logs = new Map<string, StoredEvent[]>()
  private indexRows: { sessionId: string; kind: IndexKind; text: string }[] = []
  private kv = new Map<string, unknown>()
  private draftMap = new Map<string, DraftState>()
  private files = new Map<string, AttachmentRow>()

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

  close(): void {}
}

/** Attachment bytes in memory, shown through object URLs. Browser preview and tests only. */
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
