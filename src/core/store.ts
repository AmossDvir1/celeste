import type { DraftState, LogEvent, SearchHit, SessionSummary, StoredEvent } from '@shared/api'

/** A session as stored. `deletedAt` is set between Delete and the end of the undo window. */
export interface SessionRow extends SessionSummary {
  deletedAt: number | null
}

export interface AttachmentRow {
  id: string
  /** Null until the message that carries the file is sent. */
  sessionId: string | null
  name: string
  mime: string
  bytes: number
  /** File name inside the attachments folder. */
  file: string
  width?: number
  height?: number
  createdAt: number
}

export type IndexKind = 'title' | 'user' | 'assistant'

/**
 * Everything Core persists. The methods are synchronous: SQLite (node:sqlite) is, and so is the in-memory copy
 * that the browser preview uses. One contract test runs against both.
 */
export interface Store {
  insertSession(row: SessionRow): void
  /** Includes sessions waiting out their undo window. */
  getSession(id: string): SessionRow | undefined
  /** Sessions that are not deleted. */
  listSessions(): SessionRow[]
  patchSession(id: string, patch: Partial<Omit<SessionRow, 'id' | 'lastSeq'>>): SessionRow | undefined
  listDeleted(): { id: string; deletedAt: number }[]
  /** Removes the session, its log, its search entries and its attachment rows. Returns the rows so files can go too. */
  purgeSession(id: string): AttachmentRow[]

  /** Adds to the log and moves the session's `lastSeq` and `updatedAt` forward. */
  appendEvent(sessionId: string, at: number, event: LogEvent): StoredEvent
  events(sessionId: string, afterSeq?: number): StoredEvent[]

  /** Adds text to the search index. A `title` entry replaces the earlier one. */
  index(sessionId: string, kind: IndexKind, text: string): void
  search(query: string, limit: number): SearchHit[]

  settings(): Record<string, unknown>
  setSetting(key: string, value: unknown): void

  drafts(): Record<string, DraftState>
  setDraft(key: string, draft: DraftState | null): void

  insertAttachment(row: AttachmentRow): void
  attachment(id: string): AttachmentRow | undefined
  linkAttachments(ids: string[], sessionId: string): void
  deleteAttachment(id: string): AttachmentRow | undefined
  unlinkedAttachments(): AttachmentRow[]

  close(): void
}

/** Where attachment bytes live: a folder on disk in the app, in memory in the browser preview. */
export interface FileStore {
  save(id: string, ext: string, mime: string, data: ArrayBuffer): { file: string; url: string }
  remove(file: string): void
}

/** The words of a search box as FTS5 prefix terms: "ana log" becomes `"ana"* AND "log"*`. */
export function toMatchQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu)
  if (!words) return null
  return words
    .slice(0, 8)
    .map((w) => `"${w}"*`)
    .join(' AND ')
}
