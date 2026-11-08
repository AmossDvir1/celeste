import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSession, ApprovalAnswer, AskAnswers, UserInput } from '@shared/agent'
import type { CorePush, CreateSessionInput, SessionSummary, StoredEvent } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { MemoryFileStore, MemoryStore } from './testing/memory-store'
import { SessionService, type AdapterFactory } from './service'
import type { Snapshots } from './snapshots'
import type { CheckpointChanges, CheckpointReview } from '@shared/api'

/** A scripted agent the tests drive by hand. */
class FakeAgent implements AgentSession {
  readonly vendorSessionId = 'fake'
  readonly sent: UserInput[] = []
  readonly responses: [string, unknown][] = []
  interrupted = 0
  closed = false
  private buffer: AgentEvent[] = []
  private waiting: ((r: IteratorResult<AgentEvent>) => void) | null = null

  readonly events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift() as AgentEvent, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => (this.waiting = resolve))
      }
    })
  }

  emit(e: AgentEvent): void {
    if (this.waiting) {
      this.waiting({ value: e, done: false })
      this.waiting = null
    } else this.buffer.push(e)
  }
  send(input: UserInput): void {
    this.sent.push(input)
  }
  respond(requestId: string, answer: ApprovalAnswer | AskAnswers): void {
    this.responses.push([requestId, answer])
  }
  async setModel(): Promise<void> {}
  async setApprovalMode(): Promise<void> {}
  async interrupt(): Promise<void> {
    this.interrupted++
  }
  async close(): Promise<void> {
    this.closed = true
    this.waiting?.({ value: undefined as never, done: true })
  }
}

const input: CreateSessionInput = { vendor: 'claude', mode: 'chat', title: 'Plan the rollout', model: 'copilot-auto', effort: null, approval: 'ask' }
const flush = () => new Promise<void>((r) => setImmediate(r))

function setup(store = new MemoryStore(), dataDir = '/data', extra: Partial<ConstructorParameters<typeof SessionService>[0]> = {}) {
  const pushes: CorePush[] = []
  const agents: FakeAgent[] = []
  const contexts: Parameters<AdapterFactory>[0][] = []
  const files = new MemoryFileStore()
  const removed: string[] = []
  const realRemove = files.remove.bind(files)
  files.remove = (f) => {
    removed.push(f)
    realRemove(f)
  }
  let clock = 1_000_000
  const adapter: AdapterFactory = (ctx) => {
    contexts.push(ctx)
    const a = new FakeAgent()
    agents.push(a)
    return a
  }
  const service = new SessionService({
    store,
    files,
    dataDir,
    adapter,
    push: (p) => pushes.push(p),
    defaults: { ...DEFAULT_SETTINGS, userName: 'Sam' },
    now: () => (clock += 10),
    undoMs: 5000,
    ...extra
  })
  service.init()
  return { service, api: service.api, store, pushes, agents, removed, contexts }
}

const pushedEvents = (pushes: CorePush[], id: string): StoredEvent[] =>
  pushes.flatMap((p) => (p.type === 'event' && p.sessionId === id ? [p.stored] : []))

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('the folder an agent works in', () => {
  it('gives a chat with no project folder a private folder of its own, and removes it with the session', async () => {
    const data = mkdtempSync(join(tmpdir(), 'celeste-svc-'))
    try {
      const { api, contexts } = setup(new MemoryStore(), data)
      const { id } = api['sessions.create'](input)
      expect(api['sessions.get'](id)?.summary.cwd).toBeUndefined()
      api['sessions.send'](id, { text: 'Write me a file', attachments: [] })
      const cwd = contexts[0].options().cwd
      expect(cwd).toBe(join(data, 'chats', id))
      expect(existsSync(cwd as string)).toBe(true)

      api['sessions.remove'](id)
      vi.advanceTimersByTime(6000)
      expect(existsSync(cwd as string)).toBe(false)
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })

  it('keeps a project folder when the session has one', () => {
    const { api, agents, contexts } = setup()
    const { id } = api['sessions.create']({ ...input, mode: 'develop', cwd: '/work/shop-web' })
    api['sessions.send'](id, { text: 'Go', attachments: [] })
    expect(agents).toHaveLength(1)
    expect(contexts[0].options().cwd).toBe('/work/shop-web')
  })
})

describe('sessions and their log', () => {
  it('writes every event to the log before pushing it, in order', async () => {
    const { api, agents, pushes } = setup()
    const { id } = api['sessions.create'](input)
    api['sessions.send'](id, { text: 'Roll it out', attachments: [] })
    const agent = agents[0]
    expect(agent.sent).toEqual([{ text: 'Roll it out', attachments: [] }])

    agent.emit({ type: 'turn.started', turnId: 't1' })
    agent.emit({ type: 'message.delta', text: 'Starting ' })
    agent.emit({ type: 'message.delta', text: 'now.' })
    agent.emit({ type: 'turn.completed', turnId: 't1' })
    await flush()

    const log = api['sessions.get'](id)?.events ?? []
    expect(log.map((e) => e.event.type)).toEqual(['user.message', 'turn.started', 'message.delta', 'message.delta', 'turn.completed'])
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    // What the window was told is exactly what is on record.
    expect(pushedEvents(pushes, id)).toEqual(log)
    expect(api['sessions.get'](id)?.summary).toMatchObject({ status: 'idle', lastSeq: 5 })
  })

  it('keeps the summary status in step: working, waiting for you, working, idle', async () => {
    const { api, agents, pushes } = setup()
    const { id } = api['sessions.create'](input)
    api['sessions.send'](id, { text: 'Do it', attachments: [] })
    const agent = agents[0]
    const statuses = () => pushes.flatMap((p) => (p.type === 'summary' && p.session.id === id ? [p.session.status] : []))

    agent.emit({ type: 'turn.started', turnId: 't' })
    agent.emit({ type: 'approval.requested', requestId: 'r1', kind: 'shell', title: 'npm test' })
    await flush()
    expect(api['app.bootstrap']().sessions[0].status).toBe('waiting')

    api['sessions.respondApproval'](id, 'r1', { allow: true })
    expect(api['app.bootstrap']().sessions[0].status).toBe('working')
    agent.emit({ type: 'turn.completed', turnId: 't' })
    await flush()
    // The first "idle" is the summary pushed when the session was created.
    expect(statuses()).toEqual(['idle', 'working', 'waiting', 'working', 'idle'])
    expect(api['app.bootstrap']().sessions[0].status).toBe('idle')
  })

  it('passes approvals and answers on to the running agent and records them', async () => {
    const { api, agents } = setup()
    const { id } = api['sessions.create'](input)
    api['sessions.send'](id, { text: 'Go', attachments: [] })
    const agent = agents[0]
    agent.emit({ type: 'approval.requested', requestId: 'r1', kind: 'edit', title: 'Edit files' })
    agent.emit({ type: 'ask_user.requested', requestId: 'q1', questions: [] })
    await flush()

    api['sessions.respondApproval'](id, 'r1', { allow: true, always: true })
    api['sessions.respondAsk'](id, 'q1', { Scope: 'Canary only' })
    expect(agent.responses).toEqual([
      ['r1', { allow: true, always: true }],
      ['q1', { Scope: 'Canary only' }]
    ])
    // "Always allow" switches the session to auto-approve.
    expect(api['app.bootstrap']().sessions[0].approval).toBe('auto')
    const types = (api['sessions.get'](id)?.events ?? []).map((e) => e.event.type)
    expect(types).toContain('approval.resolved')
    expect(types).toContain('ask.answered')
    // Nothing new was sent as a message: the live agent got the answers directly.
    expect(agent.sent).toHaveLength(1)
  })

  it('stops the agent on request', async () => {
    const { api, agents } = setup()
    const { id } = api['sessions.create'](input)
    api['sessions.send'](id, { text: 'Go', attachments: [] })
    api['sessions.interrupt'](id)
    expect(agents[0].interrupted).toBe(1)
  })

  it('updates the title and settings of a session and tells the windows', () => {
    const { api, pushes } = setup()
    const { id } = api['sessions.create'](input)
    const updated = api['sessions.update'](id, { title: '  Renamed  ', model: 'claude-opus', effort: 'high', approval: 'plan' })
    expect(updated).toMatchObject({ title: 'Renamed', model: 'claude-opus', effort: 'high', approval: 'plan' })
    expect(pushes.at(-1)).toEqual({ type: 'summary', session: updated })
    expect(api['sessions.update'](id, { title: '   ' }).title).toBe('Renamed')
    expect(api['sessions.update'](id, { effort: null }).effort).toBeNull()
    expect(() => api['sessions.update'](id, { approval: 'nope' as never })).toThrow(/approval/)
    expect(() => api['sessions.update']('missing', { title: 'x' })).toThrow(/no longer exists/)
  })

  it('rejects malformed requests', () => {
    const { api } = setup()
    expect(() => api['sessions.create']({ ...input, mode: 'both' as never })).toThrow()
    expect(() => api['sessions.create']({ ...input, title: 5 as never })).toThrow()
    const { id } = api['sessions.create'](input)
    expect(() => api['sessions.send'](id, { text: 1 as never, attachments: [] })).toThrow()
    expect(() => api['sessions.send'](id, { text: 'x', attachments: new Array(11).fill({ id: 'a' }) as never })).toThrow()
    expect(() => api['drafts.set']('../etc', { text: 'x', attachments: [] })).toThrow()
    expect(() => api['settings.patch']({ theme: 'neon' as never })).toThrow()
    expect(() => api['settings.patch']({ motion: 'none' as never })).toThrow()
  })

  it('keeps the motion setting, which starts as normal', () => {
    const first = setup()
    expect(first.api['app.bootstrap']().settings.motion).toBe('normal')
    first.api['settings.patch']({ motion: 'reduced' })
    first.service.close()
    expect(setup(first.store).api['app.bootstrap']().settings.motion).toBe('reduced')
  })
})

describe('delete and undo', () => {
  it('hides a deleted session at once, restores it within the window, and deletes it for good after', async () => {
    const { api, agents, pushes, store } = setup()
    const { id } = api['sessions.create'](input)
    api['sessions.send'](id, { text: 'Remember the canary hosts', attachments: [] })
    await flush()

    api['sessions.remove'](id)
    expect(pushes.at(-1)).toEqual({ type: 'removed', id })
    expect(agents[0].interrupted).toBe(1)
    expect(agents[0].closed).toBe(true)
    expect(api['app.bootstrap']().sessions).toEqual([])
    expect(api['sessions.get'](id)).toBeNull()
    expect(api['sessions.search']('canary')).toEqual([])
    expect(store.getSession(id)).toBeDefined() // still on disk, for Undo

    vi.advanceTimersByTime(3000)
    const back = api['sessions.restore'](id)
    expect(back?.id).toBe(id)
    expect(api['sessions.get'](id)?.events).toHaveLength(1)
    expect(api['sessions.search']('canary')).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    expect(store.getSession(id)).toBeDefined() // the pending delete was cancelled

    api['sessions.remove'](id)
    vi.advanceTimersByTime(5001)
    expect(store.getSession(id)).toBeUndefined()
    expect(api['sessions.restore'](id)).toBeNull()
  })

  it('deletes the files that belonged to a session, and only those', () => {
    const { api, removed } = setup()
    const a = api['sessions.create'](input)
    const b = api['sessions.create'](input)
    const mine = api['attachments.save']({ name: 'a.png', mime: 'image/png', data: new ArrayBuffer(4) })
    const theirs = api['attachments.save']({ name: 'b.png', mime: 'image/png', data: new ArrayBuffer(4) })
    api['sessions.send'](a.id, { text: 'see', attachments: [mine] })
    api['sessions.send'](b.id, { text: 'see', attachments: [theirs] })

    api['sessions.remove'](a.id)
    vi.advanceTimersByTime(6000)
    expect(removed).toEqual([`${mine.id}.png`])
  })

  it('deletes everything at once, with no undo', () => {
    const { api, store, pushes } = setup()
    const one = api['sessions.create'](input)
    const two = api['sessions.create'](input)
    api['sessions.remove'](two.id) // mid-undo
    const ids = api['sessions.removeAll']()
    expect(ids.sort()).toEqual([one.id, two.id].sort())
    expect(store.getSession(one.id)).toBeUndefined()
    expect(store.getSession(two.id)).toBeUndefined()
    expect(api['sessions.restore'](two.id)).toBeNull()
    expect(pushes.filter((p) => p.type === 'removed')).toHaveLength(3)
  })
})

describe('restarting', () => {
  /** Closes the first service and starts another on the same data, as a restart does. */
  const restart = (first: ReturnType<typeof setup>) => {
    first.service.close()
    return setup(first.store)
  }

  it('records that a running turn was cut off, and shows it as idle', async () => {
    const first = setup()
    const { id } = first.api['sessions.create'](input)
    first.api['sessions.send'](id, { text: 'Long job', attachments: [] })
    first.agents[0].emit({ type: 'turn.started', turnId: 't' })
    first.agents[0].emit({ type: 'tool.started', id: 'x', kind: 'shell', title: 'build' })
    await flush()
    expect(first.api['app.bootstrap']().sessions[0].status).toBe('working')

    const second = restart(first)
    const log = second.api['sessions.get'](id)?.events ?? []
    expect(log.at(-1)?.event).toEqual({ type: 'turn.abandoned' })
    expect(second.api['app.bootstrap']().sessions[0].status).toBe('idle')
    // Starting again leaves the log alone.
    expect(restart(second).api['sessions.get'](id)?.events).toHaveLength(log.length)
  })

  it('keeps a question waiting across a restart, and answering it continues the session', async () => {
    const first = setup()
    const { id } = first.api['sessions.create'](input)
    first.api['sessions.send'](id, { text: 'Roll out', attachments: [] })
    first.agents[0].emit({ type: 'ask_user.requested', requestId: 'q1', questions: [{ header: 'Scope', question: 'Which hosts?', options: [], multiSelect: false }] })
    await flush()

    const second = restart(first)
    expect(second.api['app.bootstrap']().sessions[0].status).toBe('waiting')

    second.api['sessions.respondAsk'](id, 'q1', { 'Which hosts?': 'Canary only' })
    const types = (second.api['sessions.get'](id)?.events ?? []).map((e) => e.event.type)
    expect(types.slice(-2)).toEqual(['ask.answered', 'user.message'])
    // A new agent received the answer as the next message.
    expect(second.agents).toHaveLength(1)
    expect(second.agents[0].sent[0].text).toContain('Canary only')
  })

  it('lets you stop a session that was waiting when Celeste closed', async () => {
    const first = setup()
    const { id } = first.api['sessions.create'](input)
    first.api['sessions.send'](id, { text: 'Edit', attachments: [] })
    first.agents[0].emit({ type: 'approval.requested', requestId: 'r', kind: 'edit', title: 'Edit' })
    await flush()

    const second = restart(first)
    second.api['sessions.interrupt'](id)
    expect(second.api['app.bootstrap']().sessions[0].status).toBe('idle')
    expect(second.agents).toHaveLength(0)
  })

  it('finishes deleting sessions that were still in their undo window', () => {
    const first = setup()
    const { id } = first.api['sessions.create'](input)
    first.api['sessions.remove'](id)
    const second = restart(first)
    expect(second.store.getSession(id)).toBeUndefined()
  })

  it('keeps pinned models in order, once each, and refuses a list that is not text', () => {
    const first = setup()
    expect(first.api['app.bootstrap']().settings.pinnedModels).toEqual([])
    first.api['settings.patch']({ pinnedModels: ['claude-opus', 'auto', 'claude-opus'] })
    expect(() => first.api['settings.patch']({ pinnedModels: 'auto' as never })).toThrow()
    expect(() => first.api['settings.patch']({ pinnedModels: [1] as never })).toThrow()
    expect(() => first.api['settings.patch']({ pinnedModels: new Array(101).fill('m') })).toThrow()
    expect(restart(first).api['app.bootstrap']().settings.pinnedModels).toEqual(['claude-opus', 'auto'])
  })

  it('keeps settings, vendors and drafts', () => {
    const first = setup()
    first.api['settings.patch']({ theme: 'light', userName: 'Dana', defaults: { approval: 'ask' } })
    first.api['vendors.set']('openai', { account: 'API key ending 4f2a', method: 'key' })
    first.api['vendors.set']('claude', null)
    first.api['drafts.set']('home:chat', { text: 'half a thought', attachments: [] })

    const boot = restart(first).api['app.bootstrap']()
    expect(boot.settings).toMatchObject({ theme: 'light', userName: 'Dana', wizardDone: false })
    expect(boot.settings.defaults).toMatchObject({ approval: 'ask', model: 'copilot-auto' })
    expect(boot.settingsStored).toBe(true)
    expect(boot.vendors).toEqual({ openai: { account: 'API key ending 4f2a', method: 'key' } })
    expect(boot.drafts['home:chat'].text).toBe('half a thought')
  })
})

describe('first start', () => {
  it('starts with defaults and says nothing was stored yet', () => {
    const { api } = setup()
    const boot = api['app.bootstrap']()
    expect(boot.settingsStored).toBe(false)
    expect(boot.settings.userName).toBe('Sam')
    expect(boot.vendors).toEqual({})
    expect(boot.sessions).toEqual([])
    expect(boot.dataDir).toBe('/data')
  })
})

describe('drafts and attachments', () => {
  it('stores a draft, and an empty one is the same as none', () => {
    const { api } = setup()
    api['drafts.set']('home:develop', { text: 'fix the build', attachments: [] })
    expect(api['app.bootstrap']().drafts).toEqual({ 'home:develop': { text: 'fix the build', attachments: [] } })
    api['drafts.set']('home:develop', { text: '', attachments: [] })
    expect(api['app.bootstrap']().drafts).toEqual({})
    api['drafts.set']('home:develop', null)
  })

  it('stores files inert, links them on send, and discards only unsent ones', () => {
    const { api, store, removed } = setup()
    const { id } = api['sessions.create'](input)
    const exe = api['attachments.save']({ name: 'run me.exe', mime: 'application/x-msdownload', data: new ArrayBuffer(3) })
    expect(store.attachment(exe.id)?.file).toBe(`${exe.id}.bin`)
    const img = api['attachments.save']({ name: 'shot.png', mime: 'image/png', data: new ArrayBuffer(8), width: 640.4, height: 360 })
    expect(img).toMatchObject({ name: 'shot.png', size: 8, width: 640, height: 360 })
    expect(() => api['attachments.save']({ name: 'huge', mime: 'text/plain', data: new ArrayBuffer(26 * 1024 * 1024) })).toThrow(/too large/)

    api['sessions.send'](id, { text: 'look', attachments: [img] })
    expect(store.attachment(img.id)?.sessionId).toBe(id)
    api['attachments.discard'](img.id) // already sent: stays
    expect(store.attachment(img.id)).toBeDefined()
    api['attachments.discard'](exe.id)
    expect(store.attachment(exe.id)).toBeUndefined()
    expect(removed).toEqual([`${exe.id}.bin`])
  })

  it('clears leftover files at start-up, but not the ones a draft still holds', () => {
    const first = setup()
    const keep = first.api['attachments.save']({ name: 'keep.txt', mime: 'text/plain', data: new ArrayBuffer(1) })
    const lose = first.api['attachments.save']({ name: 'lose.txt', mime: 'text/plain', data: new ArrayBuffer(1) })
    first.api['drafts.set']('home:chat', { text: '', attachments: [keep] })
    first.service.close()

    const second = setup(first.store)
    expect(second.store.attachment(keep.id)).toBeDefined()
    expect(second.store.attachment(lose.id)).toBeUndefined()
    expect(second.removed).toEqual([`${lose.id}.txt`])
  })
})

describe('search', () => {
  it('finds a session by its title, what you asked, or what the assistant answered', async () => {
    const { api, agents } = setup()
    const { id } = api['sessions.create']({ ...input, title: 'Quarterly numbers' })
    api['sessions.send'](id, { text: 'Summarize the revenue spreadsheet', attachments: [] })
    agents[0].emit({ type: 'turn.started', turnId: 't' })
    agents[0].emit({ type: 'message.delta', text: 'Revenue grew in the ' })
    agents[0].emit({ type: 'message.delta', text: 'northern region.' })
    agents[0].emit({ type: 'turn.completed', turnId: 't' })
    await flush()

    expect(api['sessions.search']('quarterly')[0]).toMatchObject({ sessionId: id, title: 'Quarterly numbers' })
    expect(api['sessions.search']('spreadsheet')[0].snippet).toContain('spreadsheet')
    expect(api['sessions.search']('northern region')[0].sessionId).toBe(id)
    expect(api['sessions.search']('absent')).toEqual([])

    api['sessions.update'](id, { title: 'Annual figures' })
    expect(api['sessions.search']('quarterly')[0]?.snippet).toBeUndefined()
    expect(api['sessions.search']('annual')[0].sessionId).toBe(id)
  })
})

describe('sample sessions from older builds', () => {
  const row = (id: string) => ({
    id,
    vendor: 'copilot' as const,
    mode: 'chat' as const,
    title: id,
    model: 'copilot-auto',
    effort: null,
    approval: 'auto' as const,
    status: 'idle' as const,
    createdAt: 1,
    updatedAt: 1,
    lastSeq: 0,
    deletedAt: null
  })

  it('removes them once, and keeps the conversations that are really the person’s', () => {
    const store = new MemoryStore()
    store.insertSession(row('seed-wfo'))
    store.insertSession(row('seed-kb'))
    store.insertSession(row('8f1c2d3e-real'))
    store.setSetting('samplesSeeded', true)
    store.index('seed-wfo', 'title', 'Analyze WFO logs')

    const first = setup(store)
    expect(first.api['app.bootstrap']().sessions.map((x) => x.id)).toEqual(['8f1c2d3e-real'])
    expect(first.api['sessions.search']('WFO')).toEqual([])
    expect(store.settings().samplesSeeded).toBe(false)

    // A conversation that merely starts with the same letters later is not touched: the flag is off now.
    first.service.close()
    store.insertSession(row('seed-later'))
    expect(setup(store).api['app.bootstrap']().sessions.map((x) => x.id).sort()).toEqual(['8f1c2d3e-real', 'seed-later'])
  })
})

// --- checkpoints ----------------------------------------------------------------------------------------

/** Stands in for the saved copies of the project folder, so the service's own behaviour can be tested without git. */
class FakeSnapshots implements Snapshots {
  taken: string[] = []
  restored: string[] = []
  forgotten: string[] = []
  previews: string[] = []
  failWith: string | null = null
  changesOut: CheckpointChanges = { files: [{ path: 'a.txt', status: 'modified', added: 2, removed: 1 }], more: 0 }
  private n = 0
  async take(): Promise<string> {
    if (this.failWith) throw new Error(this.failWith)
    const id = (++this.n).toString(16).padStart(40, '0')
    this.taken.push(id)
    return id
  }
  async changes(): Promise<CheckpointChanges> {
    return this.changesOut
  }
  async preview(_s: string, _c: string, to: string): Promise<CheckpointChanges> {
    this.previews.push(to)
    return this.changesOut
  }
  async restore(_s: string, _c: string, to: string) {
    this.restored.push(to)
    return { restored: 1, removed: 2, undoId: (1000 + this.restored.length).toString(16).padStart(40, '0') }
  }
  reviews: [string, string | null][] = []
  discarded: [string, string[]][] = []
  async diffs(_s: string, _c: string, from: string, to: string | null): Promise<CheckpointReview> {
    this.reviews.push([from, to])
    return { files: [{ path: 'a.txt', status: 'modified', added: 2, removed: 1, hunks: [] }], more: 0 }
  }
  async discard(_s: string, _c: string, to: string, paths: string[]) {
    this.discarded.push([to, paths])
    return { restored: paths.length, removed: 0, undoId: (2000 + this.discarded.length).toString(16).padStart(40, '0') }
  }
  forget(sessionId: string): void {
    this.forgotten.push(sessionId)
  }
}

const develop: CreateSessionInput = { ...input, mode: 'develop', cwd: '/work/shop-web' }
const typesOf = (api: ReturnType<typeof setup>['api'], id: string) => (api['sessions.get'](id)?.events ?? []).map((e) => e.event.type)

describe('checkpoints', () => {
  it('saves the folder before a Develop message reaches the agent, and logs where to go back to', async () => {
    const snapshots = new FakeSnapshots()
    const { api, agents } = setup(new MemoryStore(), '/data', { snapshots })
    const { id } = api['sessions.create'](develop)
    api['sessions.send'](id, { text: 'Fix the test', attachments: [] })
    expect(agents[0]?.sent).toEqual([])
    await flush()
    expect(agents[0]?.sent).toEqual([{ text: 'Fix the test', attachments: [] }])
    expect(typesOf(api, id)).toEqual(['user.message', 'checkpoint.created'])
    expect(api['sessions.get'](id)?.events[1]?.event).toEqual({ type: 'checkpoint.created', id: snapshots.taken[0] })
  })

  it('does not save anything for a chat, or when there is nothing to save with', async () => {
    const snapshots = new FakeSnapshots()
    const a = setup(new MemoryStore(), '/data', { snapshots })
    const chat = a.api['sessions.create'](input)
    a.api['sessions.send'](chat.id, { text: 'Hello', attachments: [] })
    // A chat is sent at once, with no queue.
    expect(a.agents[0]?.sent).toHaveLength(1)
    expect(snapshots.taken).toEqual([])

    const b = setup()
    const dev = b.api['sessions.create'](develop)
    b.api['sessions.send'](dev.id, { text: 'Hello', attachments: [] })
    expect(b.agents[0]?.sent).toHaveLength(1)
    expect(typesOf(b.api, dev.id)).toEqual(['user.message'])
  })

  it('writes what the turn changed when it ends, under the checkpoint it began at', async () => {
    const snapshots = new FakeSnapshots()
    const { api, agents } = setup(new MemoryStore(), '/data', { snapshots })
    const { id } = api['sessions.create'](develop)
    api['sessions.send'](id, { text: 'Fix the test', attachments: [] })
    await flush()
    agents[0]?.emit({ type: 'turn.started', turnId: 't1' })
    agents[0]?.emit({ type: 'turn.completed', turnId: 't1' })
    await flush()
    const events = api['sessions.get'](id)?.events.map((e) => e.event) ?? []
    expect(events.at(-1)).toEqual({ type: 'checkpoint.summary', id: snapshots.taken[0], ...snapshots.changesOut })
    // A second save, after the turn: the one before the message and the one after.
    expect(snapshots.taken).toHaveLength(2)
  })

  it('saves again for the next message, but not for one sent in the middle of an answer, and keeps the order', async () => {
    const snapshots = new FakeSnapshots()
    const { api, agents } = setup(new MemoryStore(), '/data', { snapshots })
    const { id } = api['sessions.create'](develop)
    api['sessions.send'](id, { text: 'one', attachments: [] })
    api['sessions.send'](id, { text: 'two, while one is running', attachments: [] })
    await flush()
    expect(agents[0]?.sent.map((m) => m.text)).toEqual(['one', 'two, while one is running'])
    expect(snapshots.taken).toHaveLength(1)

    agents[0]?.emit({ type: 'turn.completed', turnId: 't1' })
    await flush()
    api['sessions.send'](id, { text: 'three', attachments: [] })
    await flush()
    expect(agents[0]?.sent.map((m) => m.text)).toEqual(['one', 'two, while one is running', 'three'])
    // Before one, after the turn, and before three.
    expect(snapshots.taken).toHaveLength(3)
  })

  it('still sends the message when the folder cannot be saved, says so once, and says it again only for a new reason', async () => {
    const snapshots = new FakeSnapshots()
    snapshots.failWith = 'Git was not found on this computer, and checkpoints need it.'
    const { api, agents } = setup(new MemoryStore(), '/data', { snapshots })
    const { id } = api['sessions.create'](develop)
    api['sessions.send'](id, { text: 'one', attachments: [] })
    await flush()
    agents[0]?.emit({ type: 'turn.completed', turnId: 't1' })
    await flush()
    api['sessions.send'](id, { text: 'two', attachments: [] })
    await flush()
    expect(agents[0]?.sent.map((m) => m.text)).toEqual(['one', 'two'])
    expect(typesOf(api, id).filter((t) => t === 'checkpoint.skipped')).toHaveLength(1)

    agents[0]?.emit({ type: 'turn.completed', turnId: 't2' })
    await flush()
    snapshots.failWith = 'This folder is too large to checkpoint.'
    api['sessions.send'](id, { text: 'three', attachments: [] })
    await flush()
    expect(typesOf(api, id).filter((t) => t === 'checkpoint.skipped')).toHaveLength(2)
    expect(agents[0]?.sent).toHaveLength(3)
  })

  describe('reverting', () => {
    async function finished() {
      const snapshots = new FakeSnapshots()
      const t = setup(new MemoryStore(), '/data', { snapshots })
      const { id } = t.api['sessions.create'](develop)
      t.api['sessions.send'](id, { text: 'Fix the test', attachments: [] })
      await flush()
      t.agents[0]?.emit({ type: 'turn.completed', turnId: 't1' })
      await flush()
      return { ...t, snapshots, id, checkpoint: snapshots.taken[0] as string }
    }

    it('previews and then reverts, writing what happened to the log', async () => {
      const { api, snapshots, id, checkpoint } = await finished()
      expect(await api['sessions.revertPreview'](id, checkpoint)).toEqual(snapshots.changesOut)
      expect(snapshots.previews).toEqual([checkpoint])

      const result = await api['sessions.revert'](id, checkpoint)
      expect(result).toMatchObject({ restored: 1, removed: 2 })
      expect(snapshots.restored).toEqual([checkpoint])
      expect((api['sessions.get'](id)?.events.at(-1) as { event: unknown }).event).toEqual({ type: 'checkpoint.reverted', id: checkpoint, ...result })
    })

    it('can go back to the save made just before a revert, which is how a revert is undone', async () => {
      const { api, snapshots, id, checkpoint } = await finished()
      const first = await api['sessions.revert'](id, checkpoint)
      await api['sessions.revert'](id, first.undoId)
      expect(snapshots.restored).toEqual([checkpoint, first.undoId])
    })

    it('tells the agent about it with the next message, once, without changing what the person wrote', async () => {
      const { api, agents, id, checkpoint } = await finished()
      await api['sessions.revert'](id, checkpoint)
      api['sessions.send'](id, { text: 'Try again', attachments: [] })
      await flush()
      const sent = agents[0]?.sent.at(-1)?.text ?? ''
      expect(sent.startsWith('Try again')).toBe(true)
      expect(sent).toMatch(/reverted the project folder/)
      const logged = api['sessions.get'](id)?.events.find((e) => e.event.type === 'user.message' && e.event.text.startsWith('Try again'))?.event
      expect(logged).toMatchObject({ text: 'Try again' })

      agents[0]?.emit({ type: 'turn.completed', turnId: 't2' })
      await flush()
      api['sessions.send'](id, { text: 'And again', attachments: [] })
      await flush()
      expect(agents[0]?.sent.at(-1)?.text).toBe('And again')
    })

    it('still tells the agent after Celeste was restarted in between', async () => {
      const snapshots = new FakeSnapshots()
      const store = new MemoryStore()
      const first = setup(store, '/data', { snapshots })
      const { id } = first.api['sessions.create'](develop)
      first.api['sessions.send'](id, { text: 'Fix the test', attachments: [] })
      await flush()
      first.agents[0]?.emit({ type: 'turn.completed', turnId: 't1' })
      await flush()
      await first.api['sessions.revert'](id, snapshots.taken[0] as string)
      first.service.close()

      const second = setup(store, '/data', { snapshots })
      second.api['sessions.send'](id, { text: 'Carry on', attachments: [] })
      await flush()
      expect(second.agents[0]?.sent.at(-1)?.text).toMatch(/reverted the project folder/)
    })

    it('refuses while the agent is answering, until it is stopped', async () => {
      const { api, agents, id, checkpoint } = await finished()
      api['sessions.send'](id, { text: 'Next', attachments: [] })
      await flush()
      agents[0]?.emit({ type: 'turn.started', turnId: 't2' })
      await expect(api['sessions.revert'](id, checkpoint)).rejects.toThrow(/Wait for the answer/)
      agents[0]?.emit({ type: 'turn.interrupted', turnId: 't2' })
      await flush()
      await expect(api['sessions.revert'](id, checkpoint)).resolves.toMatchObject({ restored: 1 })
    })

    it('refuses a checkpoint that is not this session’s, not an id, a chat, or when there are no checkpoints', async () => {
      const { api, id } = await finished()
      await expect(api['sessions.revert'](id, 'f'.repeat(40))).rejects.toThrow(/does not belong to this session/)
      await expect(api['sessions.revert'](id, '../../x')).rejects.toThrow(/Invalid checkpoint/)
      await expect(api['sessions.revertPreview'](id, 'f'.repeat(40))).rejects.toThrow(/does not belong/)

      const chat = api['sessions.create'](input)
      await expect(api['sessions.revert'](chat.id, 'a'.repeat(40))).rejects.toThrow(/Only Develop sessions/)
      const plain = setup()
      const dev = plain.api['sessions.create'](develop)
      await expect(plain.api['sessions.revert'](dev.id, 'a'.repeat(40))).rejects.toThrow(/not available/)
    })

    it('says what differs now from before the first message, and nothing for a session that has no checkpoint', async () => {
      const { api, snapshots, id } = await finished()
      const before = snapshots.taken.length
      expect(await api['sessions.netChanges'](id)).toEqual(snapshots.changesOut)
      // It looked at the folder as it is now.
      expect(snapshots.taken).toHaveLength(before + 1)

      const plain = setup()
      const dev = plain.api['sessions.create'](develop)
      expect(await plain.api['sessions.netChanges'](dev.id)).toEqual({ files: [], more: 0 })
      const s = new FakeSnapshots()
      const other = setup(new MemoryStore(), '/data', { snapshots: s })
      const fresh = other.api['sessions.create'](develop)
      expect(await other.api['sessions.netChanges'](fresh.id)).toEqual({ files: [], more: 0 })
      expect(s.taken).toEqual([])
      const chat = other.api['sessions.create'](input)
      expect(await other.api['sessions.netChanges'](chat.id)).toEqual({ files: [], more: 0 })
    })

    it('reviews what changed between two of the session’s checkpoints, or from one up to now', async () => {
      const { api, snapshots, id, checkpoint } = await finished()
      api['sessions.send'](id, { text: 'Next', attachments: [] })
      await flush()
      // The place the next message was saved at: where the first turn ends.
      const later = (api['sessions.get'](id)?.events.map((e) => e.event).filter((e) => e.type === 'checkpoint.created')[1] as { id: string }).id
      expect((await api['sessions.review'](id, checkpoint, later)).files[0]?.path).toBe('a.txt')
      await api['sessions.review'](id, checkpoint, null)
      expect(snapshots.reviews).toEqual([
        [checkpoint, later],
        [checkpoint, null]
      ])
      await expect(api['sessions.review'](id, 'f'.repeat(40), null)).rejects.toThrow(/does not belong/)
      await expect(api['sessions.review'](id, checkpoint, 'f'.repeat(40))).rejects.toThrow(/does not belong/)
    })

    it('discards only the files asked for, logs it like a revert, tells the agent, and can be undone', async () => {
      const { api, agents, snapshots, id, checkpoint } = await finished()
      const result = await api['sessions.discardFiles'](id, checkpoint, ['a.txt', 'src/b.ts'])
      expect(snapshots.discarded).toEqual([[checkpoint, ['a.txt', 'src/b.ts']]])
      expect(result).toMatchObject({ restored: 2, removed: 0 })
      expect((api['sessions.get'](id)?.events.at(-1) as { event: unknown }).event).toEqual({ type: 'checkpoint.reverted', id: checkpoint, ...result })

      api['sessions.send'](id, { text: 'Go on', attachments: [] })
      await flush()
      expect(agents[0]?.sent.at(-1)?.text).toMatch(/reverted the project folder/)
      // The save made before the discard is one of the session's own, so going back to it is allowed.
      await expect(api['sessions.revert'](id, result.undoId)).rejects.toThrow(/Wait for the answer/)
    })

    it('refuses to discard while the agent is answering, nothing at all, a stranger’s checkpoint, or something that is not a list of names', async () => {
      const { api, agents, id, checkpoint } = await finished()
      await expect(api['sessions.discardFiles'](id, checkpoint, [])).rejects.toThrow(/Invalid files/)
      await expect(api['sessions.discardFiles'](id, checkpoint, [42 as unknown as string])).rejects.toThrow(/Invalid files/)
      await expect(api['sessions.discardFiles'](id, 'f'.repeat(40), ['a.txt'])).rejects.toThrow(/does not belong/)
      api['sessions.send'](id, { text: 'Next', attachments: [] })
      await flush()
      agents[0]?.emit({ type: 'turn.started', turnId: 't2' })
      await expect(api['sessions.discardFiles'](id, checkpoint, ['a.txt'])).rejects.toThrow(/Wait for the answer/)
    })

    it('forgets a session’s saved copies when the session is deleted for good', async () => {
      const { api, snapshots, id } = await finished()
      api['sessions.remove'](id)
      vi.advanceTimersByTime(6000)
      expect(snapshots.forgotten).toEqual([id])
    })
  })
})
