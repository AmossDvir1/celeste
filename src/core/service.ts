import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { AgentSession, ApprovalAnswer, ApprovalChoices, ApprovalSlider, ApprovalMode, AskAnswers, AttachmentInfo, ContextRef, SessionMode, ToolKind, UserInput, VendorId } from '@shared/agent'
import {
  UNDO_WINDOW_MS,
  type AppSettings,
  type Bootstrap,
  type SessionApi,
  type CheckpointChanges,
  type CheckpointReview,
  type CorePush,
  type CreateSessionInput,
  type DesktopGrantRecord,
  type DraftState,
  type LogEvent,
  type NewAttachment,
  type SessionPatch,
  type SessionSummary,
  type SettingsPatch,
  type VendorRecord,
  type VendorRecords
} from '@shared/api'
import { SIDEBAR_WIDTH } from '@shared/defaults'
import { coalesceEvents } from '@shared/coalesce'
import { nextStatus } from '@shared/status'
import type { AttachmentRow, FileStore, SessionRow, Store } from './store'
import type { Snapshots } from './snapshots'
import { cleanTitle, type Titler } from './titles'
import { contextText, MAX_CONTEXT } from './context'
import { listFolder, readPreview } from './files'
import { producedSince, scanFolder, type Manifest } from './produced-files'

/*
 * The session logic, independent of where data is kept. The app runs it on SQLite inside the Core process;
 * the tests run the same code on an in-memory store.
 *
 * Every event is written to the log first and only then pushed to the window, so what the window shows
 * can always be rebuilt from the log.
 */

import type { AdapterFactory } from './adapters/types'
export type { AdapterContext, AdapterFactory } from './adapters/types'

export interface ServiceOptions {
  store: Store
  files: FileStore
  dataDir: string
  /** The version of Celeste that is running, from the main process. */
  version?: string
  adapter: AdapterFactory
  push: (p: CorePush) => void
  defaults: AppSettings
  /** Called when a session is stopped or deleted, so work started on its behalf (device commands) can be cancelled. */
  onSessionStopped?: (sessionId: string) => void
  /** Saves a Develop session's project folder before each message, so a turn can be reverted. Without it there are no checkpoints. */
  snapshots?: Snapshots
  /** Writes the short title shown for a session after its first message. Without it the first words stay as the title. */
  titler?: Titler
  now?: () => number
  undoMs?: number
}

interface Live {
  session: AgentSession
  /** Approval and question cards that this running agent is waiting on. */
  pending: Set<string>
  /** The assistant's text so far this turn, indexed for search when the turn ends. */
  text: string
  /** True from the moment a message is sent until its turn ends. A message sent in the middle of a turn is not a checkpoint. */
  open: boolean
  /** Saving the folder, and the messages that wait behind it, one after the other so the agent hears them in order. */
  chain: Promise<void>
  /** The checkpoint taken before the current turn. */
  checkpoint?: string
  /** The folder was reverted since the agent last heard from the person, so the next message says so. */
  reverted: boolean
  /** Chat: the private folder as it was when the current turn began, to find the files the turn made. */
  filesBefore?: Manifest
}

/**
 * Tokens arrive many times a second. The first of a run is logged and shown at once; the ones that follow within this time are joined
 * into one entry, so the log, the windows and the phone hear a few entries a second, not one for every few characters.
 */
const BURST_MS = 80

/** The tokens of one run that are waiting to be logged together. */
interface Burst {
  type: 'message.delta' | 'thinking.delta'
  text: string
  /** When the first of the waiting tokens arrived. */
  at: number
  live: { text: string; pending?: Set<string> }
  timer: ReturnType<typeof setTimeout>
}

/** How long Celeste waits for a folder to be saved before it sends the message anyway, without a checkpoint. */
const CHECKPOINT_TIMEOUT_MS = 90_000
const CHECKPOINT_ID = /^[0-9a-f]{40}$/
/** How long the small model has to name a session. Its own limit is a little shorter, so this is the backstop. */
const NAMING_TIMEOUT_MS = 40_000
/** Added to the first message after a revert: the agent remembers edits that are no longer there. */
const REVERT_NOTE =
  '[Celeste: before this message the person reverted the project folder to an earlier point, which undid changes made since. Files you changed may be back to older contents or gone. Read a file again before relying on what you remember of it.]'

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

const MODES: SessionMode[] = ['chat', 'develop']
const APPROVALS: ApprovalMode[] = ['auto', 'edits', 'ask', 'plan']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const THEMES = ['dark', 'light', 'system']
const VENDOR_IDS: VendorId[] = ['copilot', 'claude', 'openai', 'gemini']
const SETTINGS_KEYS = ['theme', 'userName', 'wizardDone', 'sidebarCollapsed', 'sidebarWidth', 'desktopControl', 'desktopNeverApps', 'browserTools', 'browserAllowedSites', 'pinnedModels', 'defaults'] as const
const MAX_PINNED = 100
const TRANSCRIPT_LIMIT = 24_000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENTS = 10

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv'
}

/**
 * The extensions an attachment keeps from its name: documents, data, media and archives. A Word file is stored as `<id>.docx`, so the
 * assistant, the viewer and the person's programs can tell what it is. Anything that could run when it is opened (programs, scripts,
 * shortcuts, installers) is not here: it is stored with no extension of its own. At most five letters (the file's address allows that).
 */
const KEPT_EXTENSIONS = new Set(
  (
    'pdf doc docx dot dotx xls xlsx xlsm xlsb ods odt odp ppt pptx pps rtf csv tsv txt md json jsonl xml yaml yml toml ini log html htm svg ipynb ' +
    'zip gz tar 7z rar png jpg jpeg gif webp avif bmp ico heic tif tiff mp4 m4v mov webm mkv avi mp3 wav ogg m4a flac aac epub tex srt vtt css ' +
    'ts tsx jsx c h cpp cs java go rs kt swift sql'
  ).split(' ')
)

/** The extension a stored attachment gets: the one its name has when that is a kept kind, else by its type, else none. */
export function attachmentExtension(name: string, mime: string): string {
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase()
  if (fromName && KEPT_EXTENSIONS.has(fromName)) return fromName
  return EXTENSIONS[mime] ?? 'bin'
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`Invalid ${what}`)
  return value as T
}
function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${what}`)
  return value
}

const summaryOf = ({ deletedAt: _deleted, vendorSessionId: _vendorSession, ...summary }: SessionRow): SessionSummary => summary

export class SessionService {
  private readonly store: Store
  private readonly live = new Map<string, Live>()
  private readonly undoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly undoMs: number
  /** Approval cards raised for tool calls that are not the agent's own (device commands), waiting for an answer. */
  private readonly toolApprovals = new Map<string, { sessionId: string; resolve: (answer: { allow: boolean; always: boolean; minutes?: number }) => void }>()

  constructor(private readonly opts: ServiceOptions) {
    this.store = opts.store
    this.undoMs = opts.undoMs ?? UNDO_WINDOW_MS
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** Start-up housekeeping. Run once, before the first window connects. */
  init(): void {
    // Anything still waiting out an undo window when Celeste closed is deleted now.
    for (const { id } of this.store.listDeleted()) this.purge(id)

    // A turn that was running when Celeste closed cannot continue. Say so in the log.
    for (const row of this.store.listSessions()) {
      if (row.status === 'working') this.record(row.id, { type: 'turn.abandoned' }, { text: '' })
    }

    // Attachments that were added to a message and never sent, and are in no draft, are leftovers.
    const inDrafts = new Set(Object.values(this.store.drafts()).flatMap((d) => d.attachments.map((a) => a.id)))
    for (const a of this.store.unlinkedAttachments()) {
      if (!inDrafts.has(a.id)) this.dropAttachment(a)
    }

    // Earlier builds added sample sessions to the sidebar. They were never the person's conversations, so they are removed, once.
    if (this.store.settings().samplesSeeded === true) {
      for (const row of this.store.listSessions()) if (row.id.startsWith('seed-')) this.purge(row.id)
      this.store.setSetting('samplesSeeded', false)
    }
  }

  close(): void {
    this.flushAllBursts()
    for (const [id, live] of this.live) {
      void live.session.close()
      this.live.delete(id)
    }
    for (const t of this.undoTimers.values()) clearTimeout(t)
    this.undoTimers.clear()
  }

  // --- the methods the window can call ---------------------------------------------------------------

  /** Everything except the device methods, which DeviceService adds. */
  readonly api: SessionApi = {
    'app.bootstrap': () => this.bootstrap(),
    'settings.get': () => this.currentSettings(),
    'settings.patch': (patch) => this.patchSettings(patch),
    'desktop.grants': () => [...((this.store.settings().desktopGrants as DesktopGrantRecord[] | undefined) ?? [])].reverse(),
    'vendors.set': (id, record) => this.setVendor(id, record),

    'sessions.create': (input) => this.create(input),
    'sessions.get': (id) => {
      const row = this.store.getSession(id)
      if (!row || row.deletedAt !== null) return null
      this.flushBurst(id)
      // The log holds a token at a time; the window is sent whole runs of them, which replay to the same conversation.
      return { summary: this.summary(row), events: coalesceEvents(this.store.events(id)) }
    },
    'sessions.send': (id, input) => this.send(id, input),
    'sessions.interrupt': (id) => this.interrupt(id),
    'sessions.respondApproval': (id, requestId, answer) => this.respondApproval(id, requestId, answer),
    'sessions.respondAsk': (id, requestId, answers) => this.respondAsk(id, requestId, answers),
    'sessions.update': (id, patch) => this.update(id, patch),
    'sessions.netChanges': (id) => this.netChanges(id),
    'sessions.listFiles': async (id, path) => listFolder(this.projectOf(id), path),
    'sessions.readFile': async (id, path) => readPreview(this.projectOf(id), path),
    'sessions.review': (id, from, to) => this.review(id, from, to),
    'sessions.discardFiles': (id, checkpointId, paths) => this.discardFiles(id, checkpointId, paths),
    'sessions.revertPreview': (id, checkpointId) => this.revertPreview(id, checkpointId),
    'sessions.revert': (id, checkpointId) => this.revert(id, checkpointId),
    'sessions.remove': (id) => this.remove(id),
    'sessions.restore': (id) => this.restore(id),
    'sessions.removeAll': () => this.removeAll(),
    'sessions.search': (query) => this.store.search(text(query, 'search', 200), 12),

    'drafts.set': (key, draft) => this.setDraft(key, draft),

    'attachments.save': (file) => this.saveAttachment(file),
    'attachments.discard': (id) => {
      const row = this.store.attachment(text(id, 'attachment', 80))
      if (row && row.sessionId === null) this.dropAttachment(row)
    },
  }

  // --- start-up data ---------------------------------------------------------------------------------

  private currentSettings(): AppSettings {
    const stored = this.store.settings()
    const d = this.opts.defaults
    return {
      theme: (stored.theme as AppSettings['theme']) ?? d.theme,
      userName: (stored.userName as string) ?? d.userName,
      wizardDone: (stored.wizardDone as boolean) ?? d.wizardDone,
      sidebarCollapsed: (stored.sidebarCollapsed as boolean) ?? d.sidebarCollapsed,
      sidebarWidth: (stored.sidebarWidth as number | undefined) ?? d.sidebarWidth,
      desktopControl: (stored.desktopControl as boolean | undefined) ?? d.desktopControl,
      desktopNeverApps: (stored.desktopNeverApps as string[] | undefined) ?? d.desktopNeverApps,
      browserTools: (stored.browserTools as boolean | undefined) ?? d.browserTools,
      browserAllowedSites: (stored.browserAllowedSites as string[] | undefined) ?? d.browserAllowedSites,
      pinnedModels: (stored.pinnedModels as string[] | undefined) ?? d.pinnedModels,
      defaults: { ...d.defaults, ...(stored.defaults as Partial<AppSettings['defaults']> | undefined) }
    }
  }

  private currentVendors(): VendorRecords {
    return (this.store.settings().vendors as VendorRecords | undefined) ?? {}
  }

  private bootstrap(): Bootstrap {
    const stored = this.store.settings()
    return {
      settings: this.currentSettings(),
      settingsStored: SETTINGS_KEYS.some((k) => k in stored),
      vendors: this.currentVendors(),
      sessions: this.store.listSessions().map((r) => this.summary(r)),
      drafts: this.store.drafts(),
      dataDir: this.opts.dataDir,
      version: this.opts.version ?? '0.0.0'
    }
  }

  private patchSettings(patch: SettingsPatch): AppSettings {
    const next: Partial<AppSettings> = {}
    if (patch.theme !== undefined) next.theme = oneOf(patch.theme, THEMES as AppSettings['theme'][], 'theme')
    if (patch.userName !== undefined) next.userName = text(patch.userName, 'name', 100)
    if (patch.wizardDone !== undefined) next.wizardDone = patch.wizardDone === true
    if (patch.sidebarCollapsed !== undefined) next.sidebarCollapsed = patch.sidebarCollapsed === true
    if (patch.desktopControl !== undefined) next.desktopControl = patch.desktopControl === true
    if (patch.browserTools !== undefined) next.browserTools = patch.browserTools === true
    if (patch.browserAllowedSites !== undefined) {
      if (!Array.isArray(patch.browserAllowedSites) || patch.browserAllowedSites.length > 200) throw new Error('Invalid list of sites')
      const sites = patch.browserAllowedSites.map((s) => text(s, 'site', 253).trim().toLowerCase())
      if (sites.some((s) => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s) && !/^\[[0-9a-f:]+\]$/.test(s))) throw new Error('Invalid site')
      next.browserAllowedSites = [...new Set(sites)]
    }
    if (patch.desktopNeverApps !== undefined) {
      if (!Array.isArray(patch.desktopNeverApps) || patch.desktopNeverApps.length > 50) throw new Error('Invalid list of programs')
      next.desktopNeverApps = [...new Set(patch.desktopNeverApps.map((name) => text(name, 'program', 100).trim()).filter(Boolean))]
    }
    if (patch.sidebarWidth !== undefined) {
      if (typeof patch.sidebarWidth !== 'number' || !Number.isFinite(patch.sidebarWidth)) throw new Error('Invalid sidebar width')
      next.sidebarWidth = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, patch.sidebarWidth)))
    }
    if (patch.pinnedModels !== undefined) {
      if (!Array.isArray(patch.pinnedModels) || patch.pinnedModels.length > MAX_PINNED) throw new Error('Invalid pinned models')
      next.pinnedModels = [...new Set(patch.pinnedModels.map((id) => text(id, 'model', 100)))]
    }
    if (patch.defaults !== undefined) {
      const d = patch.defaults
      const merged = { ...this.currentSettings().defaults }
      if (d.model !== undefined) merged.model = text(d.model, 'model', 100)
      if (d.approval !== undefined) merged.approval = oneOf(d.approval, APPROVALS, 'approval mode')
      next.defaults = merged
    }
    for (const [key, value] of Object.entries(next)) this.store.setSetting(key, value)
    return this.currentSettings()
  }

  private setVendor(id: VendorId, record: VendorRecord | null): void {
    oneOf(id, VENDOR_IDS, 'vendor')
    const next = { ...this.currentVendors() }
    if (record === null) delete next[id]
    else next[id] = { account: text(record.account, 'account', 200), method: oneOf(record.method, ['browser', 'key'] as const, 'method') }
    this.store.setSetting('vendors', next)
  }

  // --- sessions --------------------------------------------------------------------------------------

  /** Stops the agents working in a folder, so that the folder can be removed. */
  stopWorkingIn(path: string): void {
    for (const id of [...this.live.keys()]) {
      if (this.store.getSession(id)?.cwd !== path) continue
      this.declineToolApprovals(id)
      this.opts.onSessionStopped?.(id)
      this.stopRuntime(id)
    }
  }

  /** What the window is told about a session. A folder under the data folder's `worktrees` is a separate copy Celeste made. */
  private summary(row: SessionRow): SessionSummary {
    const root = resolve(join(this.opts.dataDir, 'worktrees'))
    const copy = row.cwd !== undefined && (process.platform === 'win32' ? resolve(row.cwd).toLowerCase().startsWith(root.toLowerCase() + sep) : resolve(row.cwd).startsWith(root + sep))
    return { ...summaryOf(row), ...(copy ? { worktree: true } : {}) }
  }

  private requireSession(id: string): SessionRow {
    const row = this.store.getSession(id)
    if (!row || row.deletedAt !== null) throw new Error('That session no longer exists')
    return row
  }

  private emitSummary(id: string): SessionSummary | undefined {
    const row = this.store.getSession(id)
    if (!row || row.deletedAt !== null) return undefined
    const summary = this.summary(row)
    this.opts.push({ type: 'summary', session: summary })
    return summary
  }

  private create(input: CreateSessionInput): SessionSummary {
    const now = this.now()
    const row: SessionRow = {
      id: `s-${crypto.randomUUID()}`,
      vendor: oneOf(input.vendor, VENDOR_IDS, 'vendor'),
      mode: oneOf(input.mode, MODES, 'mode'),
      title: text(input.title, 'title', 200).trim() || 'New chat',
      model: text(input.model, 'model', 100),
      effort: input.effort === null ? null : (oneOf(input.effort, EFFORTS, 'effort') as SessionRow['effort']),
      approval: oneOf(input.approval, APPROVALS, 'approval mode'),
      ...(input.cwd ? { cwd: text(input.cwd, 'folder', 500) } : {}),
      ...(input.branch ? { branch: text(input.branch, 'branch', 200) } : {}),
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      deletedAt: null
    }
    this.store.insertSession(row)
    this.store.index(row.id, 'title', row.title)
    const summary = this.emitSummary(row.id)
    return summary ?? this.summary(row)
  }

  private update(id: string, patch: SessionPatch): SessionSummary {
    this.requireSession(id)
    const next: Partial<Omit<SessionRow, 'id' | 'lastSeq'>> = {}
    if (patch.title !== undefined) {
      const title = text(patch.title, 'title', 200).trim()
      if (title) next.title = title
    }
    if (patch.model !== undefined) next.model = text(patch.model, 'model', 100)
    if (patch.effort !== undefined) next.effort = patch.effort === null ? null : (oneOf(patch.effort, EFFORTS, 'effort') as SessionRow['effort'])
    if (patch.approval !== undefined) next.approval = oneOf(patch.approval, APPROVALS, 'approval mode')
    this.store.patchSession(id, next)
    if (next.title) this.store.index(id, 'title', next.title)
    return this.emitSummary(id) as SessionSummary
  }

  // --- the agent -------------------------------------------------------------------------------------

  private readonly bursts = new Map<string, Burst>()

  /** The timer that ends a window for joining tokens. It never keeps the process alive, and a failure in it is reported, not thrown from a timer. */
  private burstTimer(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      try {
        this.flushBurst(id)
      } catch (err) {
        console.error('[core] could not log the last tokens', err)
      }
    }, BURST_MS)
    timer.unref?.()
    return timer
  }

  /** Logs the tokens that are waiting, now. */
  private flushBurst(id: string): void {
    const b = this.bursts.get(id)
    if (!b) return
    clearTimeout(b.timer)
    this.bursts.delete(id)
    if (b.text) this.commit(id, { type: b.type, text: b.text }, b.live, b.at)
  }

  private flushAllBursts(): void {
    for (const id of [...this.bursts.keys()]) this.flushBurst(id)
  }

  private runtime(id: string): Live {
    const existing = this.live.get(id)
    if (existing) return existing
    const row = this.requireSession(id)
    const session = this.opts.adapter({
      sessionId: id,
      vendor: row.vendor,
      mode: row.mode,
      options: () => {
        const now = this.store.getSession(id) ?? row
        return { model: now.model, effort: now.effort, approval: now.approval, cwd: now.cwd ?? this.scratchDir(id) }
      },
      getApproval: () => this.store.getSession(id)?.approval ?? 'auto',
      ...(row.vendorSessionId ? { vendorSessionId: row.vendorSessionId } : {}),
      remember: (vendorSessionId) => this.store.patchSession(id, { vendorSessionId }),
      transcript: () => this.transcript(id),
      attachmentPath: (attachmentId) => {
        const file = this.store.attachment(attachmentId)?.file
        return file ? this.opts.files.pathOf?.(file) : undefined
      }
    })
    const live: Live = { session, pending: new Set(), text: '', open: false, chain: Promise.resolve(), reverted: row.mode === 'develop' && this.revertedSince(id) }
    this.live.set(id, live)
    void (async () => {
      try {
        for await (const event of session.events) this.record(id, event, live)
      } catch (err) {
        console.error('[core] agent stream failed', err)
      }
    })()
    return live
  }

  /** The conversation as plain text, newest last, cut from the front when long. Seeds a new vendor session. */
  private transcript(id: string): string {
    this.flushBurst(id)
    const lines: string[] = []
    let answer = ''
    const flush = () => {
      if (answer.trim()) lines.push(`Assistant: ${answer.trim()}`)
      answer = ''
    }
    for (const { event } of this.store.events(id)) {
      if (event.type === 'user.message') {
        flush()
        lines.push(`User: ${event.text}`)
      } else if (event.type === 'message.delta') answer += event.text
    }
    flush()
    const text = lines.join('\n\n')
    return text.length > TRANSCRIPT_LIMIT ? `…${text.slice(text.length - TRANSCRIPT_LIMIT)}` : text
  }

  /** Writes an event to the log, then tells the windows. Status changes also update the session's summary. */
  private record(id: string, event: LogEvent, live: { text: string; pending?: Set<string> }): void {
    if (event.type === 'message.delta' || event.type === 'thinking.delta') {
      let b = this.bursts.get(id)
      if (b && b.type !== event.type) {
        this.flushBurst(id)
        b = undefined
      }
      if (!b) {
        // The first token of a run goes straight through; the window for joining the next ones opens.
        this.commit(id, event, live, this.now())
        this.bursts.set(id, { type: event.type, text: '', at: 0, live, timer: this.burstTimer(id) })
        return
      }
      if (!b.text) b.at = this.now()
      b.text += event.text
      return
    }
    // Anything else keeps its place in the log: what is waiting goes first.
    this.flushBurst(id)
    this.commit(id, event, live, this.now())
  }

  private commit(id: string, event: LogEvent, live: { text: string; pending?: Set<string> }, at: number): void {
    const row = this.store.getSession(id)
    if (!row || row.deletedAt !== null) return
    const stored = this.store.appendEvent(id, at, event)

    switch (event.type) {
      case 'user.message':
        this.store.index(id, 'user', event.text)
        break
      case 'message.delta':
        live.text += event.text
        break
      case 'approval.requested':
      case 'ask_user.requested':
        live.pending?.add(event.requestId)
        break
      case 'turn.completed':
      case 'turn.interrupted':
      case 'turn.failed':
      case 'turn.abandoned':
        if (live.text) this.store.index(id, 'assistant', live.text)
        live.text = ''
        this.finishCheckpoint(id)
        this.finishFiles(id)
        break
    }

    const status = nextStatus(row.status, event)
    if (status !== row.status) this.store.patchSession(id, { status })
    this.opts.push({ type: 'event', sessionId: id, stored })
    if (status !== row.status) this.emitSummary(id)
  }

  private send(id: string, input: UserInput): void {
    this.requireSession(id)
    if (typeof input?.text !== 'string' || input.text.length > 200_000 || !Array.isArray(input.attachments) || input.attachments.length > MAX_ATTACHMENTS) {
      throw new Error('Invalid message')
    }
    const row = this.requireSession(id)
    const context = this.contextOf(row, input.context)
    // Read before this message is logged, because it is what has happened since the one before.
    const workflows = this.workflowNote(id)
    const live = this.runtime(id)
    this.store.linkAttachments(input.attachments.map((a) => a.id), id)
    this.record(id, { type: 'user.message', text: input.text, attachments: input.attachments, ...(context.length ? { context } : {}) }, live)

    // The first message names the session: the sidebar shows a short title in place of its first words, a moment later.
    if (row.lastSeq === 0 && this.opts.titler && input.text.trim().length >= 3 ) void this.autoTitle(id, row.vendor, row.title, input.text)

    // What the agent is told: the person's words, then (if the folder was reverted) a note about that, then the files they added.
    // The agent's adapter gets only text and attachments; the files are already in the text.
    const extra = [live.reverted ? REVERT_NOTE : '', workflows, row.cwd && context.length ? contextText(row.cwd, context) : ''].filter(Boolean)
    const outgoing: UserInput = { text: [input.text, ...extra].filter(Boolean).join('\n\n'), attachments: input.attachments }
    live.reverted = false

    // Chat: what is in the private folder now is compared with what is there when the answer ends.
    if (row.mode === 'chat') live.filesBefore ??= scanFolder(this.chatDir(id))

    const cwd = row.cwd
    if (!this.opts.snapshots || row.mode !== 'develop' || !cwd) {
      live.session.send(outgoing)
      return
    }
    // A Develop message saves the folder first, so every message goes through one queue and the agent hears them in order.
    // A message sent while the previous answer is still running is not a place to go back to.
    const checkpoint = !live.open
    live.open = true
    live.chain = live.chain.then(async () => {
      if (checkpoint) await this.checkpointBefore(id, cwd, live)
      if (this.live.get(id) === live) live.session.send(outgoing)
    })
  }

  /**
   * Asks a small model of the session's own vendor for a title and puts it in place of the first words. It is only ever a
   * nicety: if the model cannot be asked, takes too long, or answers with something that is not a title, nothing changes, and
   * if the person renamed the session in the meantime their name stays.
   */
  private async autoTitle(id: string, vendor: VendorId, provisional: string, text: string): Promise<void> {
    const titler = this.opts.titler
    if (!titler) return
    try {
      const title = cleanTitle(await withTimeout(titler.title(vendor, text), NAMING_TIMEOUT_MS, 'Naming took too long.'))
      const row = this.store.getSession(id)
      if (!title || !row || row.deletedAt !== null || row.title !== provisional || title === provisional) return
      this.store.patchSession(id, { title })
      this.store.index(id, 'title', title)
      this.emitSummary(id)
    } catch (err) {
      console.error('[core] could not name a session', err)
    }
  }

  /** Saves the folder before a message. If it cannot be saved the message still goes, and the log says there is no checkpoint. */
  private async checkpointBefore(id: string, cwd: string, live: Live): Promise<void> {
    const snapshots = this.opts.snapshots
    if (!snapshots) return
    try {
      const checkpoint = await withTimeout(snapshots.take(id, cwd), CHECKPOINT_TIMEOUT_MS, 'Saving the folder took too long.')
      live.checkpoint = checkpoint
      this.record(id, { type: 'checkpoint.created', id: checkpoint }, live)
    } catch (err) {
      live.checkpoint = undefined
      const reason = err instanceof Error ? err.message : String(err)
      // The same reason on every message would be noise.
      if (this.lastCheckpointSkip(id) !== reason) this.record(id, { type: 'checkpoint.skipped', reason }, live)
    }
  }

  private lastCheckpointSkip(id: string): string | undefined {
    const events = this.store.events(id)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = (events[i] as { event: LogEvent }).event
      if (event.type === 'checkpoint.skipped') return event.reason
      if (event.type === 'checkpoint.created') return undefined
    }
    return undefined
  }

  /** When a turn ends, what it changed in the folder is worked out and logged, behind any message that is waiting. */
  private finishCheckpoint(id: string): void {
    const live = this.live.get(id)
    if (!live) return
    live.open = false
    const from = live.checkpoint
    live.checkpoint = undefined
    const snapshots = this.opts.snapshots
    const cwd = this.store.getSession(id)?.cwd
    if (!from || !snapshots || !cwd) return
    live.chain = live.chain.then(async () => {
      try {
        const to = await withTimeout(snapshots.take(id, cwd), CHECKPOINT_TIMEOUT_MS, 'Saving the folder took too long.')
        const changes = await snapshots.changes(id, cwd, from, to)
        this.record(id, { type: 'checkpoint.summary', id: from, ...changes }, live)
      } catch (err) {
        // The summary is a convenience: without it the message simply shows no list of files.
        console.error('[core] could not summarise a turn', err)
      }
    })
  }

  /** Chat: when a turn ends, the files it wrote in the private folder are logged, so the answer can offer them. */
  private finishFiles(id: string): void {
    const live = this.live.get(id)
    const before = live?.filesBefore
    if (live) live.filesBefore = undefined
    if (!before || !live) return
    // After the event that ended the turn has been delivered, so the files come behind the answer.
    queueMicrotask(() => {
      try {
        const made = producedSince(before, scanFolder(this.chatDir(id)))
        if (made.files.length) this.record(id, { type: 'files.produced', ...made }, live)
      } catch (err) {
        console.error('[core] could not look for files made in a turn', err)
      }
    })
  }

  /** The conversation so far as plain text, for an assistant to read. */
  transcriptOf(id: string): string {
    this.requireSession(id)
    return this.transcript(id)
  }

  /** The folder a workflow started from this conversation works in: the project of a Develop session, the private folder of a chat. */
  workFolder(id: string): string {
    const row = this.requireSession(id)
    return row.mode === 'develop' && row.cwd ? row.cwd : this.scratchDir(id)
  }

  /** Writes what a workflow run did into the conversation it was started from. Nothing happens for a conversation that is gone. */
  recordWorkflow(id: string, event: Extract<LogEvent, { type: 'workflow.started' | 'workflow.finished' }>): void {
    if (!this.store.getSession(id)) return
    this.record(id, event, this.live.get(id) ?? { text: '' })
  }

  /** Writes what desktop control did into the conversation. Nothing happens for a conversation that is gone. */
  recordDesktop(id: string, event: Extract<LogEvent, { type: 'desktop.started' | 'desktop.action' | 'desktop.ended' }>): void {
    if (!this.store.getSession(id)) return
    this.record(id, event, this.live.get(id) ?? { text: '' })
  }

  /** What the assistant has not been told yet about workflows that ended since the person's last message. Read from the log. */
  private workflowNote(id: string): string {
    const notes: string[] = []
    const events = this.store.events(id)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = (events[i] as { event: LogEvent }).event
      if (event.type === 'user.message') break
      // A run the assistant started handed its result to the assistant itself, when it ended.
      if (event.type !== 'workflow.finished' || event.startedBy === 'assistant') continue
      const result = event.status === 'completed' ? `finished. Its result:\n${(event.output ?? '').slice(0, 4000) || '(nothing)'}` : event.status === 'failed' ? `failed: ${event.error ?? 'it did not say why'}` : 'was stopped before it finished'
      notes.unshift(`[The workflow “${event.name}” that the user started from this conversation ${result}]`)
    }
    return notes.join('\n\n')
  }

  /** True when the folder was reverted after the person's latest message. Read from the log, so it survives a restart. */
  private revertedSince(id: string): boolean {
    const events = this.store.events(id)
    for (let i = events.length - 1; i >= 0; i--) {
      const type = (events[i] as { event: LogEvent }).event.type
      if (type === 'user.message') return false
      if (type === 'checkpoint.reverted') return true
    }
    return false
  }

  // --- checkpoints -----------------------------------------------------------------------------------

  /** The session's folder and snapshots, after checking that the checkpoint is one of this session's own. */
  private checkpointTarget(id: string, checkpointId: unknown): { cwd: string; snapshots: Snapshots; checkpoint: string; row: SessionRow } {
    const row = this.requireSession(id)
    const snapshots = this.opts.snapshots
    if (!snapshots) throw new Error('Checkpoints are not available.')
    if (row.mode !== 'develop' || !row.cwd) throw new Error('Only Develop sessions have checkpoints.')
    if (typeof checkpointId !== 'string' || !CHECKPOINT_ID.test(checkpointId)) throw new Error('Invalid checkpoint')
    const mine = this.store.events(id).some(({ event }) => (event.type === 'checkpoint.created' && event.id === checkpointId) || (event.type === 'checkpoint.reverted' && event.undoId === checkpointId))
    if (!mine) throw new Error('That checkpoint does not belong to this session.')
    return { cwd: row.cwd, snapshots, checkpoint: checkpointId, row }
  }

  /** The folder a Develop session works in. Only that folder is ever browsed: the window names a path inside it, never outside. */
  /** The folder a Develop session works in (its separate copy, when it has one). */
  projectFolder(id: string): string {
    return this.projectOf(id)
  }

  private projectOf(id: string): string {
    const row = this.requireSession(id)
    if (row.mode !== 'develop' || !row.cwd) throw new Error('Only Develop sessions have a project folder.')
    return row.cwd
  }

  /** The first place this session's folder was saved: how it was before the person's first message. */
  private firstCheckpoint(id: string): string | undefined {
    for (const { event } of this.store.events(id)) if (event.type === 'checkpoint.created') return event.id
    return undefined
  }

  /**
   * What differs now from before the session's first message. This is the net result, so a file the agent changed and then changed
   * back (or that a revert undid) is not in it, and what a command did is. It looks at the folder as it is, which is why it is asked
   * for when an answer ends and not while one is running.
   */
  private async netChanges(id: string): Promise<CheckpointChanges> {
    const row = this.requireSession(id)
    const snapshots = this.opts.snapshots
    if (!snapshots || row.mode !== 'develop' || !row.cwd) return { files: [], more: 0 }
    const first = this.firstCheckpoint(id)
    if (!first) return { files: [], more: 0 }
    const now = await withTimeout(snapshots.take(id, row.cwd), CHECKPOINT_TIMEOUT_MS, 'Saving the folder took too long.')
    return snapshots.changes(id, row.cwd, first, now)
  }

  /** The files that changed between two of this session's checkpoints (`to` null: up to now), with their lines. */
  private async review(id: string, from: string, to: string | null): Promise<CheckpointReview> {
    const start = this.checkpointTarget(id, from)
    if (to !== null) this.checkpointTarget(id, to)
    return start.snapshots.diffs(id, start.cwd, from, to)
  }

  /** Puts only some files back as they were at a checkpoint, the way a revert does for all of them, and can be undone the same way. */
  private async discardFiles(id: string, checkpointId: string, paths: string[]): Promise<{ restored: number; removed: number; undoId: string }> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 1000 || paths.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 1000)) throw new Error('Invalid files')
    const { cwd, snapshots, checkpoint, row } = this.checkpointTarget(id, checkpointId)
    const live = this.live.get(id)
    if (live?.open || row.status !== 'idle') throw new Error('Wait for the answer to finish, or stop it, before discarding changes.')
    await live?.chain
    const result = await snapshots.discard(id, cwd, checkpoint, paths)
    // Logged as a revert: the timeline says what was put back, offers to undo it, and the agent is told its files moved.
    this.record(id, { type: 'checkpoint.reverted', id: checkpoint, ...result }, live ?? { text: '' })
    if (live) live.reverted = true
    return result
  }

  private async revertPreview(id: string, checkpointId: string): Promise<CheckpointChanges> {
    const { cwd, snapshots, checkpoint } = this.checkpointTarget(id, checkpointId)
    return snapshots.preview(id, cwd, checkpoint)
  }

  private async revert(id: string, checkpointId: string): Promise<{ restored: number; removed: number; undoId: string }> {
    const { cwd, snapshots, checkpoint, row } = this.checkpointTarget(id, checkpointId)
    const live = this.live.get(id)
    if (live?.open || row.status !== 'idle') throw new Error('Wait for the answer to finish, or stop it, before reverting.')
    // A summary that is still being worked out must not run against the folder as it is being put back.
    await live?.chain
    const result = await snapshots.restore(id, cwd, checkpoint)
    this.record(id, { type: 'checkpoint.reverted', id: checkpoint, ...result }, live ?? { text: '' })
    // With no agent running yet, the log says it: the next one to start reads it (see `revertedSince`).
    if (live) live.reverted = true
    return result
  }

  /**
   * Answers that arrive after Celeste restarted have no running agent to receive them. Until real
   * vendors can resume a session, the answer goes in as a message that starts a new turn.
   */
  private resume(id: string, message: string): void {
    const live = this.runtime(id)
    this.record(id, { type: 'user.message', text: message, attachments: [] }, live)
    live.session.send({ text: message, attachments: [] })
  }

  private respondApproval(id: string, requestId: string, answer: ApprovalAnswer): void {
    this.requireSession(id)
    const waiting = this.toolApprovals.get(requestId)
    if (waiting && waiting.sessionId === id) {
      this.toolApprovals.delete(requestId)
      this.record(id, { type: 'approval.resolved', requestId, allow: answer.allow === true }, { text: '' })
      waiting.resolve({ allow: answer.allow === true, always: answer.allow === true && answer.always === true, ...(answer.allow === true && typeof answer.minutes === 'number' ? { minutes: answer.minutes } : {}) })
      return
    }
    const live = this.live.get(id)
    this.record(id, { type: 'approval.resolved', requestId, allow: answer.allow === true }, live ?? { text: '' })
    if (answer.allow && answer.always) {
      this.store.patchSession(id, { approval: 'auto' })
      this.emitSummary(id)
    }
    if (live?.pending.delete(requestId)) live.session.respond(requestId, { allow: answer.allow === true, always: answer.always === true })
    else this.resume(id, answer.allow ? 'Yes, go ahead.' : 'No, do not do that.')
  }

  private respondAsk(id: string, requestId: string, answers: AskAnswers): void {
    this.requireSession(id)
    const live = this.live.get(id)
    this.record(id, { type: 'ask.answered', requestId, answers }, live ?? { text: '' })
    if (live?.pending.delete(requestId)) live.session.respond(requestId, answers)
    else {
      const summary = Object.entries(answers)
        .map(([question, answer]) => `${question} ${Array.isArray(answer) ? answer.join(', ') : answer}`)
        .join('\n')
      this.resume(id, summary || 'Go ahead.')
    }
  }

  /** Raises an approval card in the session for something that is not the agent's own tool, and waits. */
  requestApproval(sessionId: string, request: { kind: ToolKind; title: string; detail?: string }): Promise<boolean> {
    return this.ask(sessionId, request).then((a) => a.allow)
  }

  /**
   * The same card with a third button: yes for this chat, yes for good, or no. `choices` are the words on the first two. Used where a yes can be
   * remembered (the browser's sites).
   */
  requestChoice(sessionId: string, request: { kind: ToolKind; title: string; detail?: string; choices: ApprovalChoices }): Promise<'once' | 'always' | 'deny'> {
    return this.ask(sessionId, request).then((a) => (!a.allow ? 'deny' : a.always ? 'always' : 'once'))
  }

  /**
   * The same card with a slider for how long (minutes). Resolves with the minutes the person left it at, or null for no. Used by desktop
   * control, whose yes lasts a while.
   */
  requestTimed(sessionId: string, request: { kind: ToolKind; title: string; detail?: string; slider: ApprovalSlider }): Promise<number | null> {
    return this.ask(sessionId, request).then((a) => (a.allow ? Math.min(Math.max(request.slider.max, request.slider.until ?? 0), Math.max(request.slider.min, a.minutes ?? request.slider.value)) : null))
  }

  private ask(sessionId: string, request: { kind: ToolKind; title: string; detail?: string; choices?: ApprovalChoices; slider?: ApprovalSlider }): Promise<{ allow: boolean; always: boolean; minutes?: number }> {
    const requestId = `tool-${crypto.randomUUID()}`
    // Not tied to the running agent: the answer goes to whoever is waiting, not to the vendor.
    this.record(sessionId, { type: 'approval.requested', requestId, kind: request.kind, title: request.title, detail: request.detail, ...(request.choices ? { choices: request.choices } : {}), ...(request.slider ? { slider: request.slider } : {}) }, { text: '' })
    return new Promise((resolve) => this.toolApprovals.set(requestId, { sessionId, resolve }))
  }

  /** How a session asks before the agent acts: for the browser, whether going to a new site asks. */
  approvalOf(sessionId: string): ApprovalMode {
    return this.store.getSession(sessionId)?.approval ?? 'auto'
  }

  /** How many questions in a session wait for the person: the agent's own approvals and questions, and Celeste's cards. */
  pendingApprovals(sessionId: string): number {
    let n = this.live.get(sessionId)?.pending.size ?? 0
    for (const waiting of this.toolApprovals.values()) if (waiting.sessionId === sessionId) n++
    return n
  }

  /** Says no to every approval a session is waiting on, so the calls behind them finish instead of hanging. */
  private declineToolApprovals(sessionId: string): void {
    for (const [requestId, waiting] of [...this.toolApprovals]) {
      if (waiting.sessionId !== sessionId) continue
      this.toolApprovals.delete(requestId)
      waiting.resolve({ allow: false, always: false })
    }
  }

  private interrupt(id: string): void {
    const row = this.requireSession(id)
    this.declineToolApprovals(id)
    this.opts.onSessionStopped?.(id)
    const live = this.live.get(id)
    if (live) {
      void live.session.interrupt()
      return
    }
    // After a restart a session can still show as waiting, with nothing running to stop.
    if (row.status !== 'idle') this.record(id, { type: 'turn.interrupted', turnId: 'stopped' }, { text: '' })
  }

  // --- deleting --------------------------------------------------------------------------------------

  private stopRuntime(id: string): void {
    this.flushBurst(id)
    const live = this.live.get(id)
    if (!live) return
    void live.session.interrupt()
    void live.session.close()
    this.live.delete(id)
  }

  private remove(id: string): void {
    this.requireSession(id)
    this.declineToolApprovals(id)
    this.opts.onSessionStopped?.(id)
    this.stopRuntime(id)
    this.store.patchSession(id, { deletedAt: this.now() })
    this.opts.push({ type: 'removed', id })
    this.undoTimers.set(
      id,
      setTimeout(() => {
        this.undoTimers.delete(id)
        if (this.store.getSession(id)?.deletedAt != null) this.purge(id)
      }, this.undoMs)
    )
  }

  private restore(id: string): SessionSummary | null {
    const row = this.store.getSession(id)
    if (!row || row.deletedAt === null) return null
    clearTimeout(this.undoTimers.get(id))
    this.undoTimers.delete(id)
    this.store.patchSession(id, { deletedAt: null })
    return this.emitSummary(id) ?? null
  }

  /**
   * A chat with no project folder still gives its agent somewhere to work: a private folder of its own, so a file it writes
   * lands there and not in whatever folder Celeste was started from. It is made when first needed and removed with the session.
   */
  private chatDir(id: string): string {
    return join(this.opts.dataDir, 'chats', id)
  }

  private scratchDir(id: string): string {
    const dir = this.chatDir(id)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private purge(id: string): void {
    this.stopRuntime(id)
    clearTimeout(this.undoTimers.get(id))
    this.undoTimers.delete(id)
    for (const row of this.store.purgeSession(id)) this.opts.files.remove(row.file)
    this.opts.snapshots?.forget(id)
    try {
      rmSync(join(this.opts.dataDir, 'chats', id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch {
      // A program may still hold the folder on Windows; what is left is a few files in Celeste's own data folder.
    }
  }

  private removeAll(): string[] {
    const ids = [...this.store.listSessions().map((s) => s.id), ...this.store.listDeleted().map((s) => s.id)]
    for (const id of ids) {
      this.purge(id)
      this.opts.push({ type: 'removed', id })
    }
    return ids
  }

  // --- drafts and attachments -----------------------------------------------------------------------

  /** The files and folders added to a message, checked: only Develop sessions have a project, and a path is only ever inside it. */
  private contextOf(row: { mode: SessionMode; cwd?: string }, value: unknown): ContextRef[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_CONTEXT) throw new Error('Invalid files for the message')
    if (value.length > 0 && (row.mode !== 'develop' || !row.cwd)) throw new Error('Only Develop sessions have project files to add.')
    const refs: ContextRef[] = []
    for (const item of value as Partial<ContextRef>[]) {
      if (typeof item?.path !== 'string' || item.path.length === 0 || item.path.length > 1000 || (item.kind !== 'file' && item.kind !== 'dir')) throw new Error('Invalid files for the message')
      // A name that leaves the project is refused here, before anything reads it.
      const parts = item.path.split(/[\\/]+/)
      if (parts.some((p) => p === '..' || /^[a-z]:$/i.test(p)) || item.path.includes('\0')) throw new Error('Invalid files for the message')
      refs.push({ path: item.path, kind: item.kind })
    }
    return refs
  }

  private setDraft(key: string, draft: DraftState | null): void {
    if (typeof key !== 'string' || !/^(home:(chat|develop)|[\w-]{1,80})$/.test(key)) throw new Error('Invalid draft')
    if (!draft || (draft.text === '' && draft.attachments.length === 0 && !draft.context?.length)) {
      this.store.setDraft(key, null)
      return
    }
    if (typeof draft.text !== 'string' || draft.text.length > 200_000 || !Array.isArray(draft.attachments) || draft.attachments.length > MAX_ATTACHMENTS) {
      throw new Error('Invalid draft')
    }
    // A draft is not tied to a session yet, so only the shape of what was added is checked here; Send checks it against the project.
    const context = this.contextOf({ mode: 'develop', cwd: '.' }, draft.context)
    this.store.setDraft(key, { text: draft.text, attachments: draft.attachments as AttachmentInfo[], ...(context.length ? { context } : {}) })
  }

  private saveAttachment(file: NewAttachment): AttachmentInfo {
    const name = text(file.name, 'file name', 300).replace(/[\u0000-\u001f]/g, '').trim() || 'file'
    const mime = text(file.mime, 'file type', 120) || 'application/octet-stream'
    if (!(file.data instanceof ArrayBuffer) || file.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('That file is too large')
    // Only kinds that cannot run keep their extension, so a file named .exe is stored inert.
    const ext = attachmentExtension(name, mime)
    const id = crypto.randomUUID()
    const { file: stored, url } = this.opts.files.save(id, ext, mime, file.data)
    const row: AttachmentRow = {
      id,
      sessionId: null,
      name,
      mime,
      bytes: file.data.byteLength,
      file: stored,
      ...(file.width ? { width: Math.round(file.width) } : {}),
      ...(file.height ? { height: Math.round(file.height) } : {}),
      createdAt: this.now()
    }
    this.store.insertAttachment(row)
    return { id, name, mime, size: row.bytes, url, ...(row.width ? { width: row.width } : {}), ...(row.height ? { height: row.height } : {}) }
  }

  private dropAttachment(row: AttachmentRow): void {
    this.store.deleteAttachment(row.id)
    this.opts.files.remove(row.file)
  }
}
