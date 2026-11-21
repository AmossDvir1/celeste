import { resolve } from 'node:path'
import type { Effort, ModelInfo, VendorId } from '@shared/agent'
import type { CorePush, CreateSessionInput, LogEvent, StoredEvent } from '@shared/api'
import {
  MAX_RUNNING_PER_PARENT,
  MAX_RUNNING_TOTAL,
  MAX_STARTS_PER_MESSAGE,
  NOTE_BATCH_MS,
  RESULT_MAX_CHARS,
  helperApproval,
  waitCapFor,
  type HelperState,
  type HelperView
} from '@shared/subagents'
import type { SessionRow, Store } from '../store'
import type { SessionService } from '../service'
import type { ToolResult } from '../workflows/tools'

/*
 * What Core keeps about helpers that is not in the log (docs/plans/SUB_AGENTS_PLAN.md, section 7): which helpers are working on something
 * for their parent right now, the tool calls that wait on them, and the timers that wake a parent that has an answer waiting. Everything
 * that matters after a restart is in the parents' logs (`child.started`, `child.finished`), so this starts empty.
 */

export const VENDOR_NAMES: Record<VendorId, string> = { copilot: 'Copilot', claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini' }
const VENDORS = Object.keys(VENDOR_NAMES) as VendorId[]

/** The part of the session service that helpers use. A test gives the real service, on a memory store. */
export type HelperHost = Pick<
  SessionService,
  | 'createChild'
  | 'sendFrom'
  | 'isBusy'
  | 'stop'
  | 'recordChild'
  | 'lastAnswer'
  | 'lastTurnEnd'
  | 'pendingNote'
  | 'pendingNoteList'
  | 'canWake'
  | 'sessionRow'
  | 'chatFolderOf'
  | 'requestApproval'
>

export interface SubAgentsDeps {
  service: HelperHost
  /** Read only: the parents' logs. */
  store: Pick<Store, 'getSession' | 'events' | 'listChildren'>
  /** Whether a vendor is connected and signed in, and the models it offers. */
  vendors: { ready: (vendor: VendorId) => Promise<boolean>; models: (vendor: VendorId) => Promise<ModelInfo[]> }
  /** The model the person chose as their default, when they chose one. */
  defaultModel: () => string | undefined
  /** Makes a separate copy of a project (a git worktree) on a new branch. */
  worktrees: { create: (repo: string, hint: string) => Promise<{ path: string; branch: string }> }
  /**
   * How long one waiting tool call may last for a parent of this vendor. 0 means it cannot wait at all (its program gives up on a tool call
   * too soon), so helpers of its chats always work in the background.
   */
  waitCapMs?: (vendor: VendorId) => number
}

export interface StartInput {
  task: string
  title: string
  vendor?: VendorId
  model?: string
  effort?: Effort
  approval?: 'edits' | 'ask' | 'plan'
  folder?: 'same' | 'copy'
  wait: boolean
}

/** How one assignment ended. */
interface Ended {
  status: 'done' | 'failed' | 'stopped' | 'abandoned' | 'deleted'
  result?: string
  error?: string
}
type Outcome = Ended | 'cap' | 'parent-stopped'

interface Assignment {
  childId: string
  parentId: string
  title: string
  /** The tool calls waiting on it. Resolved once, by whichever comes first: the end, the cap, or a stop in the parent. */
  waiters: Set<(r: Outcome) => void>
  startedAt: number
  /** The child's log position when the assignment began, to tell whether the person talked to it meanwhile. */
  startSeq: number
}

const refuse = (text: string): ToolResult => ({ text, isError: true })
const ok = (text: string): ToolResult => ({ text, isError: false })

const TURN_ENDS = new Set(['turn.completed', 'turn.interrupted', 'turn.failed', 'turn.abandoned'])
const NOTHING_SAID = '(The helper finished without saying anything. Open it to see what it did.)'

/** The same folder, however it is written (Windows ignores case). */
const folderKey = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))

const quoted = (title: string): string => `“${title}”`

export class SubAgents {
  private readonly open = new Map<string, Assignment>()
  /** The timer, for each parent, that waits a moment for helpers that end together before it wakes the parent once. */
  private readonly batch = new Map<string, ReturnType<typeof setTimeout>>()
  /** Counts the times a parent was stopped, so a tool call that began before a Stop does nothing after it. */
  private readonly epochs = new Map<string, number>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: SubAgentsDeps) {}

  close(): void {
    for (const t of this.batch.values()) clearTimeout(t)
    for (const t of this.timers) clearTimeout(t)
    this.batch.clear()
    this.timers.clear()
  }

  private cap(vendor: VendorId): number {
    return this.deps.waitCapMs ? this.deps.waitCapMs(vendor) : waitCapFor(vendor)
  }

  private epoch(parentId: string): number {
    return this.epochs.get(parentId) ?? 0
  }

  /** True when the session is a helper: it may not start helpers, and it gets no desktop or phone tools. */
  isHelper(sessionId: string): boolean {
    return !!this.deps.store.getSession(sessionId)?.spawn
  }

  // --- starting ----------------------------------------------------------------------------------------

  /** Sentences for the limits, or null when one more helper may start. Counted from what is open and from the parent's log. */
  private budgetProblem(parentId: string): string | null {
    const mine = [...this.open.values()].filter((a) => a.parentId === parentId).length
    if (mine >= MAX_RUNNING_PER_PARENT) return `${MAX_RUNNING_PER_PARENT} helpers are already working for this chat, which is the most at once. Wait for one with agent_wait, then start another.`
    if (this.open.size >= MAX_RUNNING_TOTAL) return `${MAX_RUNNING_TOTAL} helpers are already working across all of the person's chats, which is the most at once. Wait for one with agent_wait, then start another.`
    if (this.startsSinceMessage(parentId) >= MAX_STARTS_PER_MESSAGE) return `${MAX_STARTS_PER_MESSAGE} helpers have been started since the person's last message, which is the most without them. Tell the person what is done and ask them to continue.`
    return null
  }

  /** The helpers (and follow-ups) started since the last message the person wrote in the parent. A wake is not the person's message. */
  private startsSinceMessage(parentId: string): number {
    let n = 0
    const events = this.deps.store.events(parentId)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = (events[i] as StoredEvent).event
      if (e.type === 'user.message' && !e.from) break
      if (e.type === 'child.started') n++
    }
    return n
  }

  /** What may be used for a helper, as a sentence for a refusal and for agent_list. */
  private async usable(): Promise<string> {
    const lines: string[] = []
    for (const vendor of VENDORS) {
      if (!(await this.deps.vendors.ready(vendor).catch(() => false))) continue
      const models = await this.deps.vendors.models(vendor).catch(() => [])
      lines.push(`${vendor} (${VENDOR_NAMES[vendor]}): ${models.map((m) => m.id).join(', ') || 'no models listed'}`)
    }
    return lines.join('; ') || 'nothing is connected'
  }

  /** The key for the folder a helper writes in: its project, or the private folder of its chat. */
  private folderOf(row: SessionRow): string {
    return row.cwd ? folderKey(row.cwd) : `chat:${this.deps.service.chatFolderOf(row.id)}`
  }

  /** Whether a helper that can change files is working in that folder now. */
  private editingIn(key: string): boolean {
    for (const a of this.open.values()) {
      const row = this.deps.store.getSession(a.childId)
      if (row && row.approval !== 'plan' && this.folderOf(row) === key) return true
    }
    return false
  }

  async start(parentId: string, input: StartInput): Promise<ToolResult> {
    const { service } = this.deps
    const parent = service.sessionRow(parentId)
    if (!parent) return refuse('This chat is gone.')
    const epoch = this.epoch(parentId)

    // 3. The limits.
    const budget = this.budgetProblem(parentId)
    if (budget) return refuse(budget)

    // 4. Which assistant: the parent's unless another is asked for, and it must be ready.
    const vendor = input.vendor ?? parent.vendor
    if (!(await this.deps.vendors.ready(vendor).catch(() => false))) return refuse(`${VENDOR_NAMES[vendor]} is not connected. You can use: ${await this.usable()}.`)

    // 5. Which model: one of that vendor's. Not asked for: the parent's own on the same vendor, else the person's default, else the vendor's first.
    const models = await this.deps.vendors.models(vendor).catch(() => [] as ModelInfo[])
    const known = (id: string | undefined) => models.find((m) => m.id === id)
    let info: ModelInfo | undefined
    let model: string
    if (input.model) {
      info = known(input.model)
      if (!info) return refuse(`${input.model} is not a model of ${VENDOR_NAMES[vendor]}. You can use: ${models.map((m) => m.id).join(', ') || 'none are listed now'}.`)
      model = info.id
    } else if (vendor === parent.vendor) {
      info = known(parent.model)
      model = parent.model
    } else {
      info = known(this.deps.defaultModel()) ?? models[0]
      if (!info) return refuse(`${VENDOR_NAMES[vendor]} offers no models now. You can use: ${await this.usable()}.`)
      model = info.id
    }
    // An effort the model does not offer is dropped, not refused. Not asked for: the parent's, when it is the same model.
    const efforts = info?.efforts ?? []
    const effort: Effort | null = input.effort && efforts.includes(input.effort) ? input.effort : vendor === parent.vendor && model === parent.model && parent.effort && efforts.includes(parent.effort) ? parent.effort : (info?.defaultEffort ?? null)

    // 6. The approval mode: never looser than the chat's. A chat that only plans gets helpers that only plan.
    const approval = helperApproval(parent.approval, input.approval)
    if (approval === null) return refuse(`A helper cannot have a looser approval mode than this chat (${parent.approval}).`)

    // 7. The folder.
    const folder = input.folder ?? 'same'
    if (folder === 'copy' && (parent.mode !== 'develop' || !parent.cwd)) return refuse('A separate copy is only for a project (Develop).')
    const key = parent.mode === 'develop' && parent.cwd ? folderKey(parent.cwd) : `chat:${service.chatFolderOf(parentId)}`
    const clash = 'Another helper is changing files in this folder. Use folder: "copy", or approval: "plan", or wait for it.'
    if (folder === 'same' && approval !== 'plan' && this.editingIn(key)) return refuse(clash)

    // 8. In ask mode, the person says yes first: starting another assistant that spends money is acting.
    if (parent.approval === 'ask') {
      const detail = [
        `${input.title}: ${VENDOR_NAMES[vendor]}, ${info?.label ?? model}`,
        parent.mode === 'develop' ? (folder === 'copy' ? 'Works in a separate copy of the project.' : `Works in the project folder, ${parent.cwd ?? ''}.`) : 'Works in this chat’s own folder.',
        `Approval mode: ${approval}.`,
        `The task:\n${input.task.slice(0, 600)}${input.task.length > 600 ? '…' : ''}`
      ].join('\n')
      const yes = await service.requestApproval(parentId, { kind: 'agent', title: 'Start a helper?', detail })
      if (!yes) return refuse('The person said no to starting this helper. Do not try again unless they ask.')
    }

    // A separate copy is made now, after the person said yes. A git project is needed: its sentence is the refusal.
    let cwd = parent.mode === 'develop' ? parent.cwd : undefined
    let branch = parent.mode === 'develop' ? parent.branch : undefined
    if (folder === 'copy') {
      try {
        const made = await this.deps.worktrees.create(parent.cwd as string, input.title)
        cwd = made.path
        branch = made.branch
      } catch (err) {
        return refuse(err instanceof Error ? err.message : 'A separate copy could not be made.')
      }
    }

    // Everything from here to the end of the assignment's start is one step with no waiting in it, so two calls that arrive together
    // cannot both pass a limit that only one of them fits under.
    if (this.epoch(parentId) !== epoch) return refuse('The person stopped this chat, so no helper was started.')
    const again = service.sessionRow(parentId)
    if (!again) return refuse('This chat is gone.')
    const late = this.budgetProblem(parentId)
    if (late) return refuse(late)
    if (folder === 'same' && approval !== 'plan' && this.editingIn(key)) return refuse(clash)

    const create: CreateSessionInput = { vendor, mode: parent.mode, title: input.title, model, effort, approval, ...(cwd ? { cwd } : {}), ...(branch ? { branch } : {}) }
    const child = service.createChild(parentId, create, { parentId, folder, ceiling: parent.approval })
    const text = `Started the helper ${quoted(input.title)} (id ${child.id}). `
    return this.begin(parentId, child.id, input.title, input.task, input.wait, { vendor, model, folder, started: text })
  }

  /** Logs the assignment in the parent, opens it, hands the child its task, and (waiting) waits for the end. */
  private async begin(parentId: string, childId: string, title: string, task: string, wait: boolean, more: { vendor: VendorId; model: string; folder: 'same' | 'copy'; started: string; again?: true }): Promise<ToolResult> {
    const { service } = this.deps
    const parentVendor = service.sessionRow(parentId)?.vendor ?? 'claude'
    const cap = this.cap(parentVendor)
    this.deps.service.recordChild(parentId, { type: 'child.started', childId, title, vendor: more.vendor, model: more.model, task: task.slice(0, 2000), folder: more.folder, wait: wait && cap > 0, ...(more.again ? { again: true as const } : {}) })
    const a: Assignment = { childId, parentId, title, waiters: new Set(), startedAt: Date.now(), startSeq: this.deps.store.getSession(childId)?.lastSeq ?? 0 }
    this.open.set(childId, a)
    try {
      service.sendFrom(childId, task, 'parent')
    } catch (err) {
      this.open.delete(childId)
      const reason = err instanceof Error ? err.message : 'it could not be given the task'
      this.deps.service.recordChild(parentId, { type: 'child.finished', childId, title, status: 'failed', error: reason, delivered: 'tool' })
      return refuse(`The helper ${quoted(title)} was made but could not start: ${reason}`)
    }
    if (!wait) return ok(`${more.started}You will be told when it finishes; use agent_wait to wait for it.`)
    if (cap === 0) {
      return ok(`${more.started}This assistant’s tool calls end after about a minute, so it cannot wait for a helper: it works in the background. You will be told when it finishes; carry on, or tell the person you are waiting.`)
    }
    return this.waitFor(parentId, [childId], false, cap)
  }

  /** More work for a helper that is idle (a new assignment). */
  async send(parentId: string, id: string, text: string, wait: boolean): Promise<ToolResult> {
    const { service } = this.deps
    const parent = service.sessionRow(parentId)
    if (!parent) return refuse('This chat is gone.')
    const child = this.helperOf(parentId, id)
    if (!child) return refuse('There is no helper with that id here.')
    if (this.open.has(id) || service.isBusy(id)) return refuse('It is still working. Use agent_wait.')
    const budget = this.budgetProblem(parentId)
    if (budget) return refuse(budget)
    const key = this.folderOf(child)
    if (child.spawn?.folder !== 'copy' && child.approval !== 'plan' && this.editingIn(key)) return refuse('Another helper is changing files in this folder. Wait for it with agent_wait, or use agent_stop.')
    return this.begin(parentId, id, child.title, text, wait, { vendor: child.vendor, model: child.model, folder: child.spawn?.folder ?? 'same', started: `Gave the helper ${quoted(child.title)} (id ${id}) more work. `, again: true })
  }

  /** The helper of this parent with that id, or nothing: another chat's helpers are not revealed. */
  private helperOf(parentId: string, id: string): SessionRow | undefined {
    const row = this.deps.service.sessionRow(id)
    return row && row.spawn?.parentId === parentId ? row : undefined
  }

  // --- waiting -----------------------------------------------------------------------------------------

  /**
   * Waits for the current assignments of these helpers, up to `cap`. `any`: the first to end is enough. A helper that already ended and
   * whose answer was not yet told is answered at once; one whose answer was told is said to be told, so the answer is not repeated.
   */
  private waitFor(parentId: string, ids: string[], any: boolean, cap: number): Promise<ToolResult> {
    return new Promise((resolveCall) => {
      const outcomes = new Map<string, Outcome>()
      const pending: { id: string; a: Assignment; waiter: (r: Outcome) => void }[] = []
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (finished) return
        finished = true
        if (timer) {
          clearTimeout(timer)
          this.timers.delete(timer)
        }
        for (const p of pending) p.a.waiters.delete(p.waiter)
        resolveCall(this.describeOutcomes(parentId, ids, outcomes))
      }
      const check = () => {
        const done = ids.filter((id) => outcomes.has(id)).length
        if (any ? done >= 1 : done === ids.length) finish()
      }
      for (const id of ids) {
        const a = this.open.get(id)
        if (!a) {
          // Not working: what it ended with, and whether the parent was already told.
          outcomes.set(id, this.endedAlready(parentId, id))
          continue
        }
        const waiter = (r: Outcome) => {
          outcomes.set(id, r)
          check()
        }
        a.waiters.add(waiter)
        pending.push({ id, a, waiter })
      }
      check()
      if (finished) return
      timer = setTimeout(() => {
        for (const id of ids) if (!outcomes.has(id)) outcomes.set(id, 'cap')
        finish()
      }, cap)
      timer.unref?.()
      this.timers.add(timer)
    })
  }

  /** What an assignment that is over ended with, from the parent's log. A note not yet told is handed over here, once. */
  private endedAlready(parentId: string, id: string): Outcome {
    const events = this.deps.store.events(parentId)
    let last: Extract<LogEvent, { type: 'child.finished' }> | undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const e = (events[i] as StoredEvent).event
      if (e.type === 'child.started' && e.childId === id) break
      if (e.type === 'child.finished' && e.childId === id) {
        last = e
        break
      }
    }
    if (!last) return { status: 'abandoned' }
    const untold = last.delivered === 'note' && this.deps.service.pendingNoteList(parentId).some((n) => n.childId === id)
    if (untold) {
      // The tool hands it over now: a second line, delivered by the tool, takes the note's place (see SessionService.noteFor).
      this.deps.service.recordChild(parentId, { ...last, delivered: 'tool' })
      return { status: last.status, ...(last.result !== undefined ? { result: last.result } : {}), ...(last.error !== undefined ? { error: last.error } : {}) }
    }
    return { status: last.status, ...(last.error !== undefined ? { error: last.error } : {}), ...(last.delivered === 'none' ? {} : { result: ALREADY_TOLD }) }
  }

  /** The tool's answer: one block for each helper, framed as data, cut so the whole stays under the limit. */
  private describeOutcomes(parentId: string, ids: string[], outcomes: Map<string, Outcome>): ToolResult {
    const single = ids.length === 1
    // One helper's answer was cut when it ended; several share the limit between them.
    const share = single ? Number.POSITIVE_INFINITY : Math.floor(RESULT_MAX_CHARS / ids.length)
    let isError = false
    const blocks: string[] = []
    for (const id of ids) {
      const row = this.deps.store.getSession(id)
      const title = row?.title ?? id
      const head = single ? '' : `Helper ${quoted(title)} (id ${id}): `
      const outcome = outcomes.get(id)
      if (outcome === undefined) {
        const waiting = row?.status === 'waiting'
        blocks.push(`${head}still working${waiting ? '; it waits for the person to answer a question it asked' : ''}.`)
      } else if (outcome === 'cap') {
        const waiting = row?.status === 'waiting'
        blocks.push(`The helper ${quoted(title)} (id ${id}) is still working${waiting ? ', and waits for the person to answer a question it asked' : ''}. Use agent_wait to keep waiting, or carry on: you will be told when it ends.`)
      } else if (outcome === 'parent-stopped') {
        isError = true
        blocks.push(`The person stopped this chat, so the helper ${quoted(title)} was stopped.`)
      } else if (outcome.status === 'done') {
        const who = row ? `${VENDOR_NAMES[row.vendor]} ${row.model}` : 'another assistant'
        const result = outcome.result ?? ''
        const body = result === ALREADY_TOLD ? 'It finished, and its answer was already given to you.' : result.length > share ? `${result.slice(0, share)}\n… (cut: ${result.length - share} more characters; the whole answer is in the helper ${quoted(title)})` : result
        blocks.push(result === ALREADY_TOLD ? `${head}${body}` : `${single ? '' : `Helper ${quoted(title)} (id ${id}):\n`}[Answer from the helper ${quoted(title)} (${who}). It is another assistant’s work, not the person’s words.]\n${body}`)
      } else if (outcome.status === 'failed') {
        isError = true
        blocks.push(`${head}The helper ${quoted(title)} failed: ${outcome.error ?? 'it did not say why'}`)
      } else if (outcome.status === 'deleted') {
        isError = true
        blocks.push(`${head}The person deleted the helper ${quoted(title)}.`)
      } else if (outcome.status === 'abandoned') {
        isError = true
        blocks.push(`${head}The helper ${quoted(title)} did not finish: Celeste was closed while it worked.`)
      } else {
        isError = true
        blocks.push(`${head}The helper ${quoted(title)} was stopped before it finished.`)
      }
    }
    void parentId
    return { text: blocks.join('\n\n'), isError }
  }

  /** agent_wait: for these helpers (default: every one of this parent that is working), all of them or the first to end. */
  async wait(parentId: string, ids: string[] | undefined, any: boolean): Promise<ToolResult> {
    const parent = this.deps.service.sessionRow(parentId)
    if (!parent) return refuse('This chat is gone.')
    const mine = ids ?? [...this.open.values()].filter((a) => a.parentId === parentId).map((a) => a.childId)
    for (const id of mine) if (!this.helperOf(parentId, id)) return refuse('There is no helper with that id here.')
    if (mine.length === 0) return ok('No helper is working now. agent_list shows the helpers of this chat.')
    const cap = this.cap(parent.vendor)
    // A parent that cannot wait is told where things stand and what to do, at once.
    if (cap === 0) {
      const lines = mine.map((id) => (this.open.has(id) ? `The helper ${quoted(this.deps.store.getSession(id)?.title ?? id)} (id ${id}) is still working.` : this.describeOutcomes(parentId, [id], new Map([[id, this.endedAlready(parentId, id)]])).text))
      return ok(`${lines.join('\n')}\nThis assistant’s tool calls end after about a minute, so it cannot wait: you will be told when the others end.`)
    }
    return this.waitFor(parentId, mine, any, cap)
  }

  /** agent_stop: the same as the person pressing Stop in the helper. */
  stopHelper(parentId: string, id: string): ToolResult {
    const child = this.helperOf(parentId, id)
    if (!child) return refuse('There is no helper with that id here.')
    if (!this.open.has(id) && !this.deps.service.isBusy(id)) return ok(`The helper ${quoted(child.title)} is not working now.`)
    this.deps.service.stop(id)
    return ok(`Stopped ${quoted(child.title)}.`)
  }

  // --- the helpers of a chat, as text and as views -----------------------------------------------------

  /** The helpers of a parent with their state, read from the parent's log and from what is open. */
  views(parentId: string): HelperView[] {
    const started = new Map<string, { startedAt: number; endedAt?: number; status?: Extract<LogEvent, { type: 'child.finished' }>['status'] }>()
    for (const { event, at } of this.deps.store.events(parentId)) {
      if (event.type === 'child.started') started.set(event.childId, { startedAt: at })
      else if (event.type === 'child.finished') {
        const s = started.get(event.childId)
        if (s) {
          s.endedAt = at
          s.status = event.status
        }
      }
    }
    return this.deps.store
      .listChildren(parentId)
      .map((row) => {
        const s = started.get(row.id)
        const working = this.open.has(row.id)
        const state: HelperState = working ? (row.status === 'waiting' ? 'waiting' : 'working') : (s?.status ?? 'done')
        return { id: row.id, title: row.title, vendor: row.vendor, model: row.model, effort: row.effort, state, startedAt: s?.startedAt ?? row.createdAt, ...(s?.endedAt !== undefined ? { endedAt: s.endedAt } : {}) }
      })
  }

  /** agent_list. */
  async list(parentId: string): Promise<ToolResult> {
    const views = this.views(parentId)
    const mine = [...this.open.values()].filter((a) => a.parentId === parentId).length
    const lines = views.map((v) => `- ${quoted(v.title)} (id ${v.id}): ${v.state}, ${VENDOR_NAMES[v.vendor]} ${v.model}`)
    return ok(
      [
        views.length ? `Helpers of this chat:\n${lines.join('\n')}` : 'This chat has no helpers yet.',
        `You can use for a helper: ${await this.usable()}.`,
        `Limits: ${mine} of ${MAX_RUNNING_PER_PARENT} helpers are working for this chat (${this.open.size} of ${MAX_RUNNING_TOTAL} across all chats); ${Math.max(0, MAX_STARTS_PER_MESSAGE - this.startsSinceMessage(parentId))} more may be started before the person’s next message.`
      ].join('\n\n')
    )
  }

  // --- what happens to the chat's own turn -------------------------------------------------------------

  /** The person pressed Stop in a session, or deleted it: the helpers it was waiting on or running stop with it. */
  parentStopped(id: string): void {
    this.epochs.set(id, this.epoch(id) + 1)
    for (const a of [...this.open.values()]) {
      if (a.parentId !== id) continue
      // Ended here, at once, with no one to tell: the parent's turn is gone, and its log can still be written.
      this.end(a.childId, { status: 'stopped' }, 'parent')
      try {
        this.deps.service.stop(a.childId)
      } catch {
        // The helper is gone already.
      }
    }
  }

  /** Every push: a helper's turn ended, or the helper was deleted. */
  observe(p: CorePush): void {
    if (p.type === 'event') {
      if (!this.open.has(p.sessionId) || !TURN_ENDS.has(p.stored.event.type)) return
      const childId = p.sessionId
      // One step later: the queue may be sending the person's next message into the helper, which is not the end of its work.
      const t = setTimeout(() => {
        this.timers.delete(t)
        this.settle(childId)
      }, 0)
      t.unref?.()
      this.timers.add(t)
    } else if (p.type === 'removed') {
      if (this.open.has(p.id)) this.end(p.id, { status: 'deleted' })
    }
  }

  private settle(childId: string): void {
    const a = this.open.get(childId)
    if (!a) return
    let busy: boolean
    try {
      busy = this.deps.service.isBusy(childId)
    } catch {
      this.end(childId, { status: 'deleted' })
      return
    }
    if (busy) return
    const { service } = this.deps
    const turn = service.lastTurnEnd(childId)
    if (turn?.type === 'turn.failed') return this.end(childId, { status: 'failed', error: turn.error ?? 'it did not say why' })
    if (turn?.type === 'turn.interrupted') return this.end(childId, { status: 'stopped' })
    if (turn?.type === 'turn.abandoned') return this.end(childId, { status: 'abandoned' })
    this.end(childId, { status: 'done', result: this.answerOf(a) })
  }

  /** The helper's last answer, cut, with the lines that say what it needs said. */
  private answerOf(a: Assignment): string {
    const { service, store } = this.deps
    const row = store.getSession(a.childId)
    let text = service.lastAnswer(a.childId) || NOTHING_SAID
    if (text.length > RESULT_MAX_CHARS) text = `${text.slice(0, RESULT_MAX_CHARS)}\n… (cut: ${text.length - RESULT_MAX_CHARS} more characters; the whole answer is in the helper ${quoted(a.title)})`
    const talked = store.events(a.childId, a.startSeq).some(({ event }) => event.type === 'user.message' && !event.from)
    const copy = row?.spawn?.folder === 'copy' && row.cwd ? `\n[It worked in a separate copy at ${row.cwd}${row.branch ? `, on branch ${row.branch}` : ''}. Its changes are not in your folder: merge the branch, or ask the person.]` : ''
    return `${talked ? '[The person also talked to this helper while it worked.]\n' : ''}${text}${copy}`
  }

  /**
   * An assignment is over. The tool calls waiting on it are answered, and the parent's log says how it ended and how the parent hears of it:
   * by the tool call that waited, by a note with its next turn, or not at all (the parent was stopped or is gone). Everything here
   * happens in one step, so a tool call that arrives at the same moment is either answered now or finds the note.
   */
  private end(childId: string, ended: Ended, why?: 'parent'): void {
    const a = this.open.get(childId)
    if (!a) return
    this.open.delete(childId)
    const parent = this.deps.service.sessionRow(a.parentId)
    const waiters = [...a.waiters]
    a.waiters.clear()
    const delivered = !parent || why === 'parent' ? 'none' : waiters.length ? 'tool' : 'note'
    const title = this.deps.store.getSession(childId)?.title ?? a.title
    this.deps.service.recordChild(a.parentId, {
      type: 'child.finished',
      childId,
      title,
      status: ended.status,
      ...(ended.result !== undefined ? { result: ended.result } : {}),
      ...(ended.error !== undefined ? { error: ended.error } : {}),
      delivered
    })
    for (const w of waiters) w(why === 'parent' ? 'parent-stopped' : ended)
    if (delivered === 'note') this.scheduleWake(a.parentId)
  }

  // --- telling the parent later ------------------------------------------------------------------------

  /** After a moment, so helpers that end together make one turn. */
  private scheduleWake(parentId: string): void {
    if (this.batch.has(parentId)) return
    const t = setTimeout(() => {
      this.batch.delete(parentId)
      this.tryWake(parentId)
    }, NOTE_BATCH_MS)
    t.unref?.()
    this.batch.set(parentId, t)
  }

  /** A turn of the parent ended. If it ended well and an answer waits, the parent hears it now (unless the moment's wait is still going). */
  onIdle(id: string, type: string): void {
    if (type !== 'turn.completed' || this.batch.has(id)) return
    this.tryWake(id)
  }

  private tryWake(parentId: string): void {
    const { service } = this.deps
    if (!service.pendingNote(parentId) || !service.canWake(parentId)) return
    const titles = service.pendingNoteList(parentId).map((n) => n.title)
    try {
      service.sendFrom(parentId, '', 'celeste', `Helpers finished: ${titles.map(quoted).join(', ')}.`)
    } catch (err) {
      console.error('[core] could not tell an assistant that its helpers finished', err)
    }
  }
}

/** Marks an answer that was told already, in the place of its text. */
const ALREADY_TOLD = '\u0000already-told'

