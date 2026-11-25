import { vi } from 'vitest'
import type { AgentEvent, FileDiff, UserInput } from '@shared/agent'
import type { CorePush, CreateSessionInput, LogEvent } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { MoonPattern } from '@shared/moons'
import type { SendMode } from '@shared/queue'
import { SubAgents } from '../agents/subagents'
import { Moons } from '../moons/moons'
import { SessionService, type AdapterFactory } from '../service'
import type { CheckpointReview } from '@shared/api'
import type { Snapshots } from '../snapshots'
import { FakeAgent } from './fake-agent'
import { MemoryFileStore, MemoryStore } from './memory-store'

/*
 * A Core with two-moon chats, for the tests of src/core/moons: the real session service on a memory store, agents the test drives by hand,
 * and the engine wired the way src/core/index.ts wires it. Needs vitest's fake timers (see `settle`).
 */

export const flush = () => new Promise<void>((r) => setImmediate(r))
/** Lets pushed events reach the engine, which looks one step after a turn ends, and lets what it started finish. */
export const settle = async () => {
  await flush()
  vi.advanceTimersByTime(1)
  await flush()
  vi.advanceTimersByTime(1)
  await flush()
}

/** An agent that can take a message into the turn that is running. */
export class SteerAgent extends FakeAgent {
  readonly steered: UserInput[] = []
  steer(input: UserInput): void {
    this.steered.push(input)
  }
}

/** Snapshots that a test controls: what `diffs` answers, and whether it answers at all. */
export class ScriptedSnapshots implements Snapshots {
  taken: string[] = []
  diffCalls: { from: string; to: string | null }[] = []
  files: FileDiff[] = []
  mode: 'ok' | 'hang' | 'throw' = 'ok'
  /** Saving the folder fails, so the person's message has no checkpoint. */
  takeFails = false
  private n = 0
  async take(): Promise<string> {
    if (this.takeFails) throw new Error('The folder is too large.')
    const id = (++this.n).toString(16).padStart(40, '0')
    this.taken.push(id)
    return id
  }
  async changes() {
    return { files: [], more: 0 }
  }
  async preview() {
    return { files: [], more: 0 }
  }
  async restore() {
    return { restored: 0, removed: 0, undoId: 'f'.repeat(40) }
  }
  async diffs(_id: string, _cwd: string, from: string, to: string | null): Promise<CheckpointReview> {
    this.diffCalls.push({ from, to })
    if (this.mode === 'hang') return new Promise<CheckpointReview>(() => undefined)
    if (this.mode === 'throw') throw new Error('git is gone')
    return { files: this.files, more: 0 }
  }
  async discard() {
    return { restored: 0, removed: 0, undoId: 'f'.repeat(40) }
  }
  forget(): void {}
}

export interface Options {
  store?: MemoryStore
  snapshots?: Snapshots
  /** The agents can take a message into a turn that is running. */
  steer?: boolean
}

/** A change to one file, with one added line. */
export const diff = (path: string, add = 'const x = 1'): FileDiff => ({
  path,
  status: 'modified',
  added: 1,
  removed: 0,
  hunks: [{ header: '@@ -1,1 +1,2 @@', lines: [{ type: 'ctx', text: 'start', oldNo: 1, newNo: 1 }, { type: 'add', text: add, newNo: 2 }] }]
})

/** A reply that ends with a block, as an agent writes it. */
export const block = (value: unknown, words = 'Here is what I found.'): string => `${words}\n\n\`\`\`moons\n${JSON.stringify(value)}\n\`\`\``

export function world(o: Options = {}) {
  const store = o.store ?? new MemoryStore()
  const pushes: CorePush[] = []
  const agents = new Map<string, FakeAgent>()
  let clock = 1_000_000
  let subs: SubAgents | undefined
  let moons: Moons | undefined
  let ids = 0
  /** What the engine answered each time the service asked whether a run goes on after the pen's turn. */
  const penDoneAnswers: boolean[] = []
  const adapter: AdapterFactory = (ctx) => {
    const a = o.steer ? new SteerAgent() : new FakeAgent()
    agents.set(ctx.sessionId, a)
    return a
  }
  const service = new SessionService({
    store,
    files: new MemoryFileStore(),
    dataDir: '/data',
    adapter,
    push: (p) => {
      pushes.push(p)
      subs?.observe(p)
      moons?.observe(p)
    },
    defaults: { ...DEFAULT_SETTINGS, userName: 'Sam' },
    now: () => (clock += 10),
    undoMs: 5000,
    ...(o.snapshots ? { snapshots: o.snapshots } : {}),
    onSessionStopped: (id) => {
      subs?.parentStopped(id)
      moons?.stopped(id)
    },
    onIdle: (id, type) => subs?.onIdle(id, type),
    moons: {
      takes: (id, input) => moons?.takes(id, input) ?? false,
      lineFor: (id) => moons?.lineFor(id) ?? '',
      penDone: (id) => {
        const goOn = moons?.penDone(id) ?? false
        // The other moon's own turns are asked about too (it is a session like any other); only the chats with two moons are of interest.
        if (store.getSession(id)?.moons) penDoneAnswers.push(goOn)
        return goOn
      },
      notSent: (id) => moons?.notSent(id)
    }
  })
  service.init()
  subs = new SubAgents({
    service,
    store,
    vendors: { ready: async () => true, models: async () => [] },
    defaultModel: () => 'openai:gpt',
    worktrees: { create: async () => ({ path: '/data/worktrees/x', branch: 'b' }) }
  })
  moons = new Moons({ service, store, newId: () => `m${++ids}` })
  const api = service.api

  const eventsOf = (id: string): LogEvent[] => (api['sessions.get'](id)?.events ?? []).map((e) => e.event)
  const statusOf = (id: string) => api['sessions.get'](id)?.summary.status
  /** The moons events of a chat in the order they happened, each as one line: easy to compare, and it reads like the story. */
  const trail = (id: string): string[] =>
    eventsOf(id).flatMap((e) => {
      switch (e.type) {
        case 'moons.turn':
          return [`turn ${e.seat} ${e.step}`]
        case 'moons.handed':
          return [`handed ${e.from}>${e.to} ${e.what}`]
        case 'moons.said':
          return [`said ${e.seat}${e.finding ? '!' : ''}${e.to ? ' to person' : ''}: ${e.text}`]
        case 'moons.fixed':
          return [`fixed ${e.ids.join(',')}`]
        case 'moons.plan':
          return [`plan ${e.steps.length} steps`]
        case 'moons.agreed':
          return ['agreed']
        case 'moons.compared':
          return [`compared ${e.both.length}/${e.first.length}/${e.second.length}`]
        case 'moons.ended':
          return [`ended ${e.why}${e.note ? ` (${e.note})` : ''}${e.left !== undefined ? ` left ${e.left}` : ''}`]
        default:
          return []
      }
    })
  const types = (id: string): string[] => eventsOf(id).map((e) => e.type)
  const endedOf = (id: string) => eventsOf(id).filter((e): e is Extract<LogEvent, { type: 'moons.ended' }> => e.type === 'moons.ended')

  /** A chat of a pattern. The pen is the chat's own agent (Claude here); the other moon is OpenAI's. */
  const make = (pattern: MoonPattern, over: Partial<CreateSessionInput> = {}) => {
    const chat = api['sessions.create']({ vendor: 'claude', mode: 'chat', title: 'Chat', model: 'claude:sonnet', effort: null, approval: 'auto', moons: { pattern, vendor: 'openai', model: 'openai:gpt', effort: null }, ...over })
    return { id: chat.id, childId: (chat.moons as { childId: string }).childId, summary: chat }
  }
  const say = (id: string, text: string, mode?: SendMode) => api['sessions.send'](id, { text, attachments: [] }, mode)
  const agent = (id: string): FakeAgent => agents.get(id) as FakeAgent
  const told = (id: string): string[] => agent(id).sent.map((s) => s.text)

  /** The pen's turn: it begins, edits files (what the tools report), says something, and ends. */
  const penBegins = async (id: string) => {
    agent(id).emit({ type: 'turn.started', turnId: 'p' })
    await settle()
  }
  const penEdits = (id: string, ...files: FileDiff[]) => {
    const a = agent(id)
    files.forEach((f, i) => {
      a.emit({ type: 'tool.started', id: `t${i}`, kind: 'edit', title: `Edit ${f.path}` })
      a.emit({ type: 'tool.completed', id: `t${i}`, ok: true, diff: [f] })
    })
  }
  const penEnds = async (id: string, said = '', end: 'turn.completed' | 'turn.interrupted' = 'turn.completed') => {
    const a = agent(id)
    if (said) a.emit({ type: 'message.delta', text: said })
    a.emit({ type: end, turnId: 'p' })
    await settle()
  }
  const penFails = async (id: string, message = 'The service said no.', code: 'unknown' | 'rate_limit' = 'unknown') => {
    agent(id).emit({ type: 'turn.failed', turnId: 'p', error: { code, message, retryable: false } })
    await settle()
  }
  /** The whole turn of the pen. */
  const penWorks = async (id: string, said = 'Done.', ...files: FileDiff[]) => {
    await penBegins(id)
    penEdits(id, ...files)
    await penEnds(id, said)
  }
  /** The other moon's whole turn. */
  const childBegins = async (childId: string) => {
    agent(childId).emit({ type: 'turn.started', turnId: 'c' })
    await settle()
  }
  const childEnds = async (childId: string, said = '', end: AgentEvent['type'] = 'turn.completed') => {
    const a = agent(childId)
    if (said) a.emit({ type: 'message.delta', text: said })
    if (end === 'turn.failed') a.emit({ type: 'turn.failed', turnId: 'c', error: { code: 'rate_limit', message: said || 'Out of messages until 3 pm.', retryable: false } })
    else a.emit({ type: end as 'turn.completed' | 'turn.interrupted', turnId: 'c' })
    await settle()
  }
  const childAnswers = async (childId: string, said: string, end: AgentEvent['type'] = 'turn.completed') => {
    await childBegins(childId)
    await childEnds(childId, said, end)
  }
  const queued = (id: string) => eventsOf(id).filter((e) => e.type === 'queue.added').length - eventsOf(id).filter((e) => e.type === 'queue.sent' || e.type === 'queue.removed').length

  return { store, service, api, pushes, agents, moons, subs, penDoneAnswers, make, say, agent, told, eventsOf, statusOf, trail, types, endedOf, penBegins, penEdits, penEnds, penFails, penWorks, childBegins, childEnds, childAnswers, queued }
}

export type World = ReturnType<typeof world>
