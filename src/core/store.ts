import type { DraftState, LogEvent, SearchHit, SessionSummary, StoredEvent } from '@shared/api'
import type { DeviceActivity, DeviceFolder, DeviceRecord } from '@shared/devices'

/** A session as stored. `deletedAt` is set between Delete and the end of the undo window. */
export interface SessionRow extends SessionSummary {
  deletedAt: number | null
  /** The vendor's own id for this conversation, used to resume it. The window never sees it. */
  vendorSessionId?: string
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
 * that the tests use. One contract test runs against both.
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

  listDevices(): DeviceRecord[]
  getDevice(id: string): DeviceRecord | undefined
  insertDevice(device: DeviceRecord): void
  patchDevice(id: string, patch: Partial<Omit<DeviceRecord, 'id' | 'createdAt'>>): DeviceRecord | undefined
  /** Removes the device with its folders and activity. Returns its folders so cached copies can be deleted. */
  deleteDevice(id: string): DeviceFolder[]
  setAttached(sessionId: string, deviceId: string, on: boolean): void
  attachedDevices(sessionId: string): string[]
  listFolders(): DeviceFolder[]
  getFolder(id: string): StoredFolder | undefined
  insertFolder(folder: StoredFolder): void
  patchFolder(id: string, patch: Partial<Pick<DeviceFolder, 'snapshotAt' | 'bytes' | 'files'> & { snapshotPath: string | null }>): void
  deleteFolder(id: string): StoredFolder | undefined
  addActivity(row: Omit<DeviceActivity, 'id'>): void
  activity(deviceId: string, limit: number): DeviceActivity[]

  close(): void
}

/** A folder as stored: with where its snapshot copy lives on this computer, which the window never sees. */
export type StoredFolder = DeviceFolder & { snapshotPath: string | null }

/** Where attachment bytes live: a folder on disk in the app, in memory in tests. */
export interface FileStore {
  save(id: string, ext: string, mime: string, data: ArrayBuffer): { file: string; url: string }
  remove(file: string): void
  /** Where the file is on disk, for agents that read attachments by path. Absent in tests that keep files in memory. */
  pathOf?(file: string): string
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
