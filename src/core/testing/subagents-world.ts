import { expect, vi } from 'vitest'
import type { ModelInfo, VendorId } from '@shared/agent'
import type { CorePush, CreateSessionInput, LogEvent } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { FakeAgent } from './fake-agent'
import { MemoryFileStore, MemoryStore } from './memory-store'
import { SessionService, type AdapterFactory } from '../service'
import type { Snapshots } from '../snapshots'
import { SubAgents, type StartInput } from '../agents/subagents'

/*
 * A Core with helpers, for the tests of helpers (src/core/agents): the real session service on a memory store, with agents the test drives
 * by hand, and the helper bookkeeping wired the way src/core/index.ts wires it. Needs vitest's fake timers (see \`settle\`).
 */

const model = (id: string, vendor: VendorId, efforts: ModelInfo['efforts'] = []): ModelInfo => ({ id, vendor, label: id, efforts, ...(efforts.length ? { defaultEffort: efforts[0] } : {}), images: true })
export const MODELS: Record<VendorId, ModelInfo[]> = {
  claude: [model('claude:sonnet', 'claude', ['low', 'high']), model('claude:haiku', 'claude')],
  openai: [model('openai:gpt', 'openai')],
  copilot: [],
  gemini: [model('gemini:flash', 'gemini')]
}

export const flush = () => new Promise<void>((r) => setImmediate(r))
/** Lets pushed events reach the helper bookkeeping, which looks one step after a turn ends. */
export const settle = async () => {
  await flush()
  vi.advanceTimersByTime(1)
  await flush()
}

export class FakeSnapshots implements Snapshots {
  taken: string[] = []
  private n = 0
  async take(): Promise<string> {
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
  async diffs() {
    return { files: [], more: 0 }
  }
  async discard() {
    return { restored: 0, removed: 0, undoId: 'f'.repeat(40) }
  }
  forget(): void {}
}

export interface Options {
  ready?: VendorId[]
  store?: MemoryStore
  dataDir?: string
  snapshots?: Snapshots
  caps?: (v: VendorId) => number
  worktree?: () => Promise<{ path: string; branch: string }>
}

export function world(o: Options = {}) {
  const store = o.store ?? new MemoryStore()
  const pushes: CorePush[] = []
  const agents = new Map<string, FakeAgent>()
  const contexts = new Map<string, Parameters<AdapterFactory>[0]>()
  const ready = new Set<VendorId>(o.ready ?? ['claude', 'openai'])
  let clock = 1_000_000
  let subs: SubAgents | undefined
  const adapter: AdapterFactory = (ctx) => {
    const a = new FakeAgent()
    agents.set(ctx.sessionId, a)
    contexts.set(ctx.sessionId, ctx)
    return a
  }
  const service = new SessionService({
    store,
    files: new MemoryFileStore(),
    dataDir: o.dataDir ?? '/data',
    adapter,
    push: (p) => {
      pushes.push(p)
      subs?.observe(p)
    },
    defaults: { ...DEFAULT_SETTINGS, userName: 'Sam' },
    now: () => (clock += 10),
    undoMs: 5000,
    ...(o.snapshots ? { snapshots: o.snapshots } : {}),
    onSessionStopped: (id) => subs?.parentStopped(id),
    onIdle: (id, type) => subs?.onIdle(id, type)
  })
  service.init()
  const sub = new SubAgents({
    service,
    store,
    vendors: { ready: async (v) => ready.has(v), models: async (v) => MODELS[v] },
    defaultModel: () => 'openai:gpt',
    worktrees: { create: o.worktree ?? (async () => ({ path: '/data/worktrees/shop-1', branch: 'celeste/helper-1' })) },
    ...(o.caps ? { waitCapMs: o.caps } : {})
  })
  subs = sub
  const api = service.api
  const make = (over: Partial<CreateSessionInput> = {}) => api['sessions.create']({ vendor: 'claude', mode: 'chat', title: 'Parent', model: 'claude:sonnet', effort: null, approval: 'auto', ...over })
  const eventsOf = (id: string): LogEvent[] => (api['sessions.get'](id)?.events ?? []).map((e) => e.event)
  const finished = (id: string) => eventsOf(id).filter((e): e is Extract<LogEvent, { type: 'child.finished' }> => e.type === 'child.finished')
  const startedEvents = (id: string) => eventsOf(id).filter((e): e is Extract<LogEvent, { type: 'child.started' }> => e.type === 'child.started')
  /** The parent is in the middle of a turn, as it is when it calls a tool. */
  const parentBegins = async (id: string, text = 'Please get this done') => {
    api['sessions.send'](id, { text, attachments: [] })
    agents.get(id)?.emit({ type: 'turn.started', turnId: 'p' })
    await settle()
  }
  const parentEnds = async (id: string, type: 'turn.completed' | 'turn.interrupted' = 'turn.completed') => {
    agents.get(id)?.emit({ type, turnId: 'p' })
    await settle()
  }
  const start = (parentId: string, over: Partial<StartInput> = {}) => sub.start(parentId, { task: 'Look at the logs', title: 'Looker', wait: false, ...over })
  const idOf = (text: string) => /id (s-[0-9a-f-]+)/.exec(text)?.[1] as string
  /** A helper's turn, from its first token to its end. */
  const run = async (childId: string, said = 'Found it.', end: 'turn.completed' | 'turn.interrupted' = 'turn.completed') => {
    const a = agents.get(childId) as FakeAgent
    a.emit({ type: 'turn.started', turnId: 'c' })
    if (said) a.emit({ type: 'message.delta', text: said })
    a.emit({ type: end, turnId: 'c' })
    await settle()
  }
  /** A background helper that has been started and is working. */
  const working = async (parentId: string, over: Partial<StartInput> = {}) => {
    const r = await start(parentId, over)
    expect(r.isError).toBe(false)
    const id = idOf(r.text)
    agents.get(id)?.emit({ type: 'turn.started', turnId: 'c' })
    await settle()
    return id
  }
  return { store, service, api, sub, pushes, agents, contexts, ready, make, eventsOf, finished, startedEvents, parentBegins, parentEnds, start, idOf, run, working }
}

