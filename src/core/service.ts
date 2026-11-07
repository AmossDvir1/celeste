import type { AgentSession, ApprovalAnswer, ApprovalMode, AskAnswers, AttachmentInfo, SessionMode, ToolKind, UserInput, VendorId } from '@shared/agent'
import {
  UNDO_WINDOW_MS,
  type AppSettings,
  type Bootstrap,
  type SessionApi,
  type CorePush,
  type CreateSessionInput,
  type DraftState,
  type LogEvent,
  type NewAttachment,
  type SessionPatch,
  type SessionSummary,
  type SettingsPatch,
  type VendorRecord,
  type VendorRecords
} from '@shared/api'
import { nextStatus } from '@shared/status'
import type { SampleSession } from './mock/samples'
import type { AttachmentRow, FileStore, SessionRow, Store } from './store'

/*
 * The session logic, independent of where data is kept. The app runs it on SQLite inside the Core process;
 * the browser preview and the tests run the same code on an in-memory store.
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
  adapter: AdapterFactory
  push: (p: CorePush) => void
  defaults: AppSettings
  defaultVendors: VendorRecords
  samples?: () => SampleSession[]
  /** Called when a session is stopped or deleted, so work started on its behalf (device commands) can be cancelled. */
  onSessionStopped?: (sessionId: string) => void
  now?: () => number
  undoMs?: number
}

interface Live {
  session: AgentSession
  /** Approval and question cards that this running agent is waiting on. */
  pending: Set<string>
  /** The assistant's text so far this turn, indexed for search when the turn ends. */
  text: string
}

const MODES: SessionMode[] = ['chat', 'develop']
const APPROVALS: ApprovalMode[] = ['auto', 'edits', 'ask', 'plan']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const THEMES = ['dark', 'light', 'system']
const VENDOR_IDS: VendorId[] = ['copilot', 'claude', 'openai', 'gemini']
const SETTINGS_KEYS = ['theme', 'userName', 'wizardDone', 'sidebarCollapsed', 'defaults'] as const
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
  private forced: string | undefined
  private readonly undoMs: number
  /** Approval cards raised for tool calls that are not the agent's own (device commands), waiting for an answer. */
  private readonly toolApprovals = new Map<string, { sessionId: string; resolve: (allow: boolean) => void }>()

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

    if (this.opts.samples && this.store.settings().samplesSeeded !== true) {
      this.restoreSamples()
      this.store.setSetting('samplesSeeded', true)
    }
  }

  close(): void {
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
    'settings.patch': (patch) => this.patchSettings(patch),
    'vendors.set': (id, record) => this.setVendor(id, record),

    'sessions.create': (input) => this.create(input),
    'sessions.get': (id) => {
      const row = this.store.getSession(id)
      if (!row || row.deletedAt !== null) return null
      return { summary: summaryOf(row), events: this.store.events(id) }
    },
    'sessions.send': (id, input) => this.send(id, input),
    'sessions.interrupt': (id) => this.interrupt(id),
    'sessions.respondApproval': (id, requestId, answer) => this.respondApproval(id, requestId, answer),
    'sessions.respondAsk': (id, requestId, answers) => this.respondAsk(id, requestId, answers),
    'sessions.update': (id, patch) => this.update(id, patch),
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

    'dev.forceScenario': (scenario) => {
      this.forced = scenario ?? undefined
    },
    'dev.restoreSamples': () => this.restoreSamples()
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
      defaults: { ...d.defaults, ...(stored.defaults as Partial<AppSettings['defaults']> | undefined) }
    }
  }

  private currentVendors(): VendorRecords {
    return (this.store.settings().vendors as VendorRecords | undefined) ?? this.opts.defaultVendors
  }

  private bootstrap(): Bootstrap {
    const stored = this.store.settings()
    return {
      settings: this.currentSettings(),
      settingsStored: SETTINGS_KEYS.some((k) => k in stored),
      vendors: this.currentVendors(),
      sessions: this.store.listSessions().map(summaryOf),
      drafts: this.store.drafts(),
      dataDir: this.opts.dataDir
    }
  }

  private patchSettings(patch: SettingsPatch): AppSettings {
    const next: Partial<AppSettings> = {}
    if (patch.theme !== undefined) next.theme = oneOf(patch.theme, THEMES as AppSettings['theme'][], 'theme')
    if (patch.userName !== undefined) next.userName = text(patch.userName, 'name', 100)
    if (patch.wizardDone !== undefined) next.wizardDone = patch.wizardDone === true
    if (patch.sidebarCollapsed !== undefined) next.sidebarCollapsed = patch.sidebarCollapsed === true
    if (patch.defaults !== undefined) {
      const d = patch.defaults
      const merged = { ...this.currentSettings().defaults }
      if (d.model !== undefined) merged.model = text(d.model, 'model', 100)
      if (d.approval !== undefined) merged.approval = oneOf(d.approval, APPROVALS, 'approval mode')
      if (d.projectsFolder !== undefined) merged.projectsFolder = text(d.projectsFolder, 'folder', 500)
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

  private requireSession(id: string): SessionRow {
    const row = this.store.getSession(id)
    if (!row || row.deletedAt !== null) throw new Error('That session no longer exists')
    return row
  }

  private emitSummary(id: string): SessionSummary | undefined {
    const row = this.store.getSession(id)
    if (!row || row.deletedAt !== null) return undefined
    const summary = summaryOf(row)
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
    return summary ?? summaryOf(row)
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
        return { model: now.model, effort: now.effort, approval: now.approval, ...(now.cwd ? { cwd: now.cwd } : {}) }
      },
      getApproval: () => this.store.getSession(id)?.approval ?? 'auto',
      ...(row.vendorSessionId ? { vendorSessionId: row.vendorSessionId } : {}),
      remember: (vendorSessionId) => this.store.patchSession(id, { vendorSessionId }),
      transcript: () => this.transcript(id),
      attachmentPath: (attachmentId) => {
        const file = this.store.attachment(attachmentId)?.file
        return file ? this.opts.files.pathOf?.(file) : undefined
      },
      takeForcedScenario: () => {
        const s = this.forced
        this.forced = undefined
        return s
      }
    })
    const live: Live = { session, pending: new Set(), text: '' }
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
    const row = this.store.getSession(id)
    if (!row || row.deletedAt !== null) return
    const stored = this.store.appendEvent(id, this.now(), event)

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
    const live = this.runtime(id)
    this.store.linkAttachments(input.attachments.map((a) => a.id), id)
    this.record(id, { type: 'user.message', text: input.text, attachments: input.attachments }, live)
    live.session.send(input)
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
      waiting.resolve(answer.allow === true)
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
    const requestId = `tool-${crypto.randomUUID()}`
    // Not tied to the running agent: the answer goes to whoever is waiting, not to the vendor.
    this.record(sessionId, { type: 'approval.requested', requestId, kind: request.kind, title: request.title, detail: request.detail }, { text: '' })
    return new Promise((resolve) => this.toolApprovals.set(requestId, { sessionId, resolve }))
  }

  /** Says no to every approval a session is waiting on, so the calls behind them finish instead of hanging. */
  private declineToolApprovals(sessionId: string): void {
    for (const [requestId, waiting] of [...this.toolApprovals]) {
      if (waiting.sessionId !== sessionId) continue
      this.toolApprovals.delete(requestId)
      waiting.resolve(false)
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

  private purge(id: string): void {
    this.stopRuntime(id)
    clearTimeout(this.undoTimers.get(id))
    this.undoTimers.delete(id)
    for (const row of this.store.purgeSession(id)) this.opts.files.remove(row.file)
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

  private setDraft(key: string, draft: DraftState | null): void {
    if (typeof key !== 'string' || !/^(home:(chat|develop)|[\w-]{1,80})$/.test(key)) throw new Error('Invalid draft')
    if (!draft || (draft.text === '' && draft.attachments.length === 0)) {
      this.store.setDraft(key, null)
      return
    }
    if (typeof draft.text !== 'string' || draft.text.length > 200_000 || !Array.isArray(draft.attachments) || draft.attachments.length > MAX_ATTACHMENTS) {
      throw new Error('Invalid draft')
    }
    this.store.setDraft(key, { text: draft.text, attachments: draft.attachments as AttachmentInfo[] })
  }

  private saveAttachment(file: NewAttachment): AttachmentInfo {
    const name = text(file.name, 'file name', 300).replace(/[\u0000-\u001f]/g, '').trim() || 'file'
    const mime = text(file.mime, 'file type', 120) || 'application/octet-stream'
    if (!(file.data instanceof ArrayBuffer) || file.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('That file is too large')
    // Only known types keep their extension, so a file named .exe is stored inert.
    const ext = EXTENSIONS[mime] ?? 'bin'
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

  // --- sample sessions (preview) -------------------------------------------------------------------

  /** Adds the sample sessions that are missing, replaying each as it would have been recorded. */
  private restoreSamples(): SessionSummary[] {
    const added: SessionSummary[] = []
    for (const sample of this.opts.samples?.() ?? []) {
      if (this.store.getSession(sample.id)) continue
      const last = sample.events[sample.events.length - 1]?.at ?? sample.createdAt
      this.store.insertSession({
        id: sample.id,
        vendor: sample.vendor,
        mode: sample.mode,
        title: sample.title,
        model: sample.model,
        effort: sample.effort,
        approval: sample.approval,
        ...(sample.cwd ? { cwd: sample.cwd } : {}),
        ...(sample.branch ? { branch: sample.branch } : {}),
        status: 'idle',
        createdAt: sample.createdAt,
        updatedAt: last,
        lastSeq: 0,
        deletedAt: null
      })
      this.store.index(sample.id, 'title', sample.title)
      let assistant = ''
      for (const { at, event } of sample.events) {
        this.store.appendEvent(sample.id, at, event)
        if (event.type === 'user.message') this.store.index(sample.id, 'user', event.text)
        if (event.type === 'message.delta') assistant += event.text
      }
      if (assistant) this.store.index(sample.id, 'assistant', assistant)
      const summary = this.emitSummary(sample.id)
      if (summary) added.push(summary)
    }
    return added
  }
}
