import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, AgentSession, ApprovalAnswer, AskAnswers, UserInput } from '@shared/agent'
import type { WorkflowDefinition, WorkflowNode } from '@shared/workflow'
import type { AdapterContext } from '../adapters/types'
import { MemoryStore } from '../testing/memory-store'
import { createAgentStepRunner } from './agent-step'
import { WorkflowRunner, type AgentStepRequest } from './runner'
import { WorkflowService } from './service'

const start: WorkflowNode = { id: 'start', type: 'start', name: 'Start', inputs: [] }
const end: WorkflowNode = { id: 'end', type: 'end', name: 'End', output: 'done' }
const shell = (command: string): WorkflowNode => ({ id: 'a', type: 'tool', name: 'A', tool: { kind: 'file', op: 'write', path: 'x.txt', content: command } })
const def = (...mid: WorkflowNode[]): WorkflowDefinition => {
  const nodes = [start, ...mid, end]
  return { nodes, edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id })) }
}

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'celeste-wfs-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

function make() {
  const store = new MemoryStore()
  let clock = 100
  let changed = 0
  const runner = new WorkflowRunner({
    store,
    push: () => undefined,
    now: () => (clock += 1),
    agent: { run: async () => 'ok' },
    mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) }
  })
  const service = new WorkflowService(store, runner, () => (clock += 1), () => changed++)
  return { api: service.api, store, runner, changes: () => changed }
}

describe('saving workflows', () => {
  it('creates one, lists it, and gives back what was saved', () => {
    const { api, changes } = make()
    const saved = api['workflows.save']({ name: ' Update KBs ', description: 'Old ones', definition: def() })
    expect(saved).toMatchObject({ name: 'Update KBs', description: 'Old ones', version: 1, allowAssistant: false })
    expect(api['workflows.list']()).toHaveLength(1)
    expect(api['workflows.get'](saved.id)?.definition).toEqual(def())
    expect(api['workflows.get']('nope')).toBeNull()
    expect(changes()).toBe(1)
  })

  it('refuses what is not valid, with the first problem in words', () => {
    const { api } = make()
    expect(() => api['workflows.save']({ name: 'Broken', definition: { nodes: [start], edges: [] } })).toThrow('exactly one End')
    expect(() => api['workflows.save']({ name: '', definition: def() })).toThrow('needs a name')
    expect(() => api['workflows.save']({ name: 'x'.repeat(200), definition: def() })).toThrow('Invalid name')
  })

  it('uses a name once, capitals not counting, but lets a workflow keep its own', () => {
    const { api } = make()
    const a = api['workflows.save']({ name: 'Test the app', definition: def() })
    expect(() => api['workflows.save']({ name: 'test THE app', definition: def() })).toThrow('already have a workflow called “Test the app”')
    expect(api['workflows.save']({ id: a.id, name: 'TEST the app', definition: def() }).name).toBe('TEST the app')
  })

  it('makes a new version when the steps change, and not for a new name or a moved step', () => {
    const { api, store } = make()
    const a = api['workflows.save']({ name: 'W', definition: def(shell('one')) })
    const renamed = api['workflows.save']({ id: a.id, name: 'W2', definition: def(shell('one')) })
    expect(renamed.version).toBe(1)
    const moved = def({ ...shell('one'), position: { x: 5, y: 5 } })
    expect(api['workflows.save']({ id: a.id, name: 'W2', definition: moved }).version).toBe(1)
    expect(api['workflows.get'](a.id)?.definition.nodes[1]).toMatchObject({ position: { x: 5, y: 5 } })
    const changed = api['workflows.save']({ id: a.id, name: 'W2', definition: def(shell('two')) })
    expect(changed.version).toBe(2)
    expect(api['workflows.versions'](a.id).map((v) => v.version)).toEqual([2, 1])
    expect((api['workflows.version'](a.id, 1)?.nodes[1] as { tool: { content: string } }).tool.content).toBe('one')
    expect(api['workflows.version'](a.id, 9)).toBeNull()
    expect(store.getWorkflow(a.id)?.version).toBe(2)
  })

  it('keeps whether the assistant may run it across saves, off to begin with', () => {
    const { api } = make()
    const a = api['workflows.save']({ name: 'W', definition: def() })
    expect(api['workflows.setAssistant'](a.id, true).allowAssistant).toBe(true)
    expect(api['workflows.save']({ id: a.id, name: 'W', definition: def(shell('x')) }).allowAssistant).toBe(true)
    expect(api['workflows.setAssistant'](a.id, false).allowAssistant).toBe(false)
  })

  it('removes a workflow and its runs', async () => {
    const { api, store } = make()
    const a = api['workflows.save']({ name: 'W', definition: def() })
    const run = await api['workflows.run'](a.id, {}, { folder })
    for (let i = 0; i < 100 && store.getRun(run.id)?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 10))
    expect(api['runs.list'](a.id)).toHaveLength(1)
    await api['workflows.remove'](a.id)
    expect(api['workflows.list']()).toEqual([])
    expect(api['runs.list']()).toEqual([])
    await expect(api['workflows.remove'](a.id)).rejects.toThrow('no longer exists')
  })
})

describe('starting a run', () => {
  it('needs a folder that exists, and reports the run with its events', async () => {
    const { api, store } = make()
    const a = api['workflows.save']({ name: 'W', definition: def() })
    await expect(Promise.resolve().then(() => api['workflows.run'](a.id, {}, { folder: join(folder, 'missing') }))).rejects.toThrow('Choose a folder')
    await expect(Promise.resolve().then(() => api['workflows.run'](a.id, {}, { folder: 5 as never }))).rejects.toThrow('Invalid folder')
    const run = await api['workflows.run'](a.id, {}, { folder })
    for (let i = 0; i < 100 && store.getRun(run.id)?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 10))
    const got = api['runs.get'](run.id)
    expect(got?.summary).toMatchObject({ status: 'completed', output: 'done', startedBy: 'you', folder })
    expect(got?.events.map((e) => e.event.type)).toContain('run.completed')
    expect(api['runs.get']('nope')).toBeNull()
    expect(api['runs.list']().map((r) => r.id)).toEqual([run.id])
  })

  it('works in a private folder of the workflow’s own when none is given, made when it is needed', async () => {
    const data = mkdtempSync(join(tmpdir(), 'celeste-wfs-data-'))
    try {
      const store = new MemoryStore()
      const runner = new WorkflowRunner({ store, push: () => undefined, agent: { run: async () => 'ok' }, mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) } })
      const service = new WorkflowService(store, runner, undefined, undefined, data)
      const a = service.api['workflows.save']({ name: 'W', definition: def() })
      const run = await service.api['workflows.run'](a.id, {}, { folder: '' })
      expect(run.folder).toBe(join(data, 'workflows', a.id))
      expect(existsSync(run.folder)).toBe(true)
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })

  it('has no private folder to offer when it does not know where to keep one', async () => {
    const { api } = make()
    const a = api['workflows.save']({ name: 'W', definition: def() })
    await expect(Promise.resolve().then(() => api['workflows.run'](a.id, {}, { folder: '' }))).rejects.toThrow('Choose a folder')
  })

  it('started from a conversation, works where the conversation does, and says it was started from the menu', async () => {
    const store = new MemoryStore()
    const runner = new WorkflowRunner({ store, push: () => undefined, agent: { run: async () => 'ok' }, mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) } })
    const asked: string[] = []
    const service = new WorkflowService(store, runner, undefined, undefined, undefined, undefined, (id) => (asked.push(id), folder))
    const a = service.api['workflows.save']({ name: 'W', definition: def() })
    const run = await service.api['workflows.run'](a.id, {}, { folder: '', sessionId: 's-1', startedBy: 'menu' })
    expect(asked).toEqual(['s-1'])
    expect(run).toMatchObject({ folder, sessionId: 's-1', startedBy: 'menu' })
    // Anything other than "menu" is the person themselves: the window cannot claim to be the assistant.
    const other = await service.api['workflows.run'](a.id, {}, { folder, startedBy: 'assistant' as never })
    expect(other.startedBy).toBe('you')
  })

  it('does not answer a question that was already answered', async () => {
    const { api } = make()
    expect(() => api['runs.respondApproval']('nope', 'x', true)).toThrow('already been answered')
    expect(() => api['runs.respondAsk']('nope', 'x', {})).toThrow('already been answered')
  })
})

describe('an agent step uses the chat adapters', () => {
  /** An agent that says what it is told to, one event at a time. */
  function fakeAgent(script: (input: UserInput, respond: (id: string, a: ApprovalAnswer | AskAnswers) => void) => AgentEvent[]) {
    const contexts: AdapterContext[] = []
    const sent: UserInput[] = []
    const responses: [string, unknown][] = []
    let closed = 0
    let interrupted = 0
    const adapter = (ctx: AdapterContext): AgentSession => {
      contexts.push(ctx)
      let release: (() => void) | undefined
      const gate = new Promise<void>((r) => (release = r))
      let events: AgentEvent[] = []
      return {
        vendorSessionId: 'v',
        events: (async function* () {
          await gate
          for (const e of events) yield e
          await new Promise(() => undefined)
        })(),
        send: (input) => {
          sent.push(input)
          events = script(input, (id, a) => responses.push([id, a]))
          release?.()
        },
        respond: (id, a) => void responses.push([id, a]),
        setModel: async () => undefined,
        setApprovalMode: async () => undefined,
        interrupt: async () => void interrupted++,
        close: async () => void closed++
      }
    }
    return { adapter, contexts, sent, responses, closed: () => closed, interrupted: () => interrupted }
  }
  const request = (more: Partial<AgentStepRequest> = {}): AgentStepRequest => ({
    prompt: 'Say hi',
    approval: 'auto',
    cwd: folder,
    signal: new AbortController().signal,
    askApproval: async () => true,
    askQuestions: async () => ({}),
    ...more
  })
  const defaults = async () => ({ vendor: 'copilot' as const, model: 'auto' })

  it('asks in a session of its own, in the run’s folder, and returns what the agent said', async () => {
    const f = fakeAgent(() => [{ type: 'turn.started', turnId: 't' }, { type: 'message.delta', text: 'Hel' }, { type: 'message.delta', text: 'lo' }, { type: 'turn.completed', turnId: 't' }])
    const answer = await createAgentStepRunner({ adapter: f.adapter, defaults }).run(request({ effort: 'high', approval: 'edits' }))
    expect(answer).toBe('Hello')
    expect(f.sent).toEqual([{ text: 'Say hi', attachments: [] }])
    expect(f.contexts[0]).toMatchObject({ vendor: 'copilot', mode: 'chat' })
    expect(f.contexts[0]?.sessionId).toMatch(/^wf-/)
    expect(f.contexts[0]?.options()).toEqual({ model: 'auto', effort: 'high', approval: 'edits', cwd: folder })
    expect(f.closed()).toBe(1)
  })

  it('uses the model and vendor a step names, and works out the vendor from a Claude model', async () => {
    const f = fakeAgent(() => [{ type: 'turn.completed', turnId: 't' }])
    await createAgentStepRunner({ adapter: f.adapter, defaults }).run(request({ model: 'claude:sonnet' }))
    await createAgentStepRunner({ adapter: f.adapter, defaults }).run(request({ vendor: 'claude', model: 'opus' }))
    expect(f.contexts.map((c) => [c.vendor, c.options().model])).toEqual([['claude', 'claude:sonnet'], ['claude', 'opus']])
  })

  it('passes the agent’s requests for a tool and its questions to the person, and gives back the answers', async () => {
    const f = fakeAgent(() => [
      { type: 'approval.requested', requestId: 'a1', kind: 'shell', title: 'Run it', detail: 'ls' },
      { type: 'ask_user.requested', requestId: 'q1', questions: [{ header: 'H', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] },
      { type: 'message.delta', text: 'ok' },
      { type: 'turn.completed', turnId: 't' }
    ])
    const seen: unknown[] = []
    await createAgentStepRunner({ adapter: f.adapter, defaults }).run(
      request({
        askApproval: async (title, detail) => (seen.push([title, detail]), false),
        askQuestions: async () => ({ 'Q?': ['B'] })
      })
    )
    expect(seen).toEqual([['Run it', 'ls']])
    expect(f.responses).toEqual([['a1', { allow: false }], ['q1', { 'Q?': ['B'] }]])
  })

  it('fails with the vendor’s own message when the turn fails, and stops the agent when the run is cancelled', async () => {
    const failing = fakeAgent(() => [{ type: 'turn.failed', turnId: 't', error: { code: 'auth', message: 'Sign in again.', retryable: false } }])
    await expect(createAgentStepRunner({ adapter: failing.adapter, defaults }).run(request())).rejects.toThrow('Sign in again.')
    expect(failing.closed()).toBe(1)

    const waiting = fakeAgent(() => [])
    const abort = new AbortController()
    const pending = createAgentStepRunner({ adapter: waiting.adapter, defaults }).run(request({ signal: abort.signal }))
    await new Promise((r) => setTimeout(r, 20))
    abort.abort()
    expect(waiting.interrupted()).toBe(1)
    void pending.catch(() => undefined)
  })
})
