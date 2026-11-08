import { describe, expect, it } from 'vitest'
import type { CanUseTool, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, ApprovalMode, Effort } from '@shared/agent'
import type { AdapterContext } from '../types'
import { EventQueue } from '../event-queue'
import { ClaudeHost, toModels, type Env, type LoginProcess, type Probe } from './host'
import { DEVICE_SERVER, decide, describe as describeTool, questionsFrom, toolKind } from './permissions'
import { ClaudeAgentSession, RESUME_NOTICE, type ClaudeQuery, type StartQuery } from './session'
import { Translator, errorFrom } from './translate'
import { TOOLS } from '../../devices/tools'

/*
 * Claude Code's messages are written out by hand here in the shape the SDK documents (stream events for text and
 * thinking, whole messages for tool calls and results, a result to end the turn). The session is tested against a fake
 * query that plays them, calling the permission callback the way the real one does.
 */

const CWD = 'C:\\work\\demo'
const SID = 'claude-session-1'

const init = (): SDKMessage => ({ type: 'system', subtype: 'init', session_id: SID, model: 'sonnet' }) as never
const text = (t: string, id = 'm1'): SDKMessage[] => [
  { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } } as never,
  { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } } as never,
  { type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text: t }] } } as never
]
const thinking = (t: string): SDKMessage =>
  ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: t } } }) as never
const toolUse = (id: string, name: string, input: Record<string, unknown>): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } }) as never
const toolResult = (id: string, content: unknown, extra: { is_error?: boolean; result?: unknown } = {}): SDKMessage =>
  ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(extra.is_error ? { is_error: true } : {}) }] }, ...(extra.result ? { tool_use_result: extra.result } : {}) }) as never
const done = (usage = { input_tokens: 10, output_tokens: 4 }): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, session_id: SID, usage }) as never

const types = (events: AgentEvent[]) => events.map((e) => e.type)
const TERMINAL = ['turn.completed', 'turn.failed', 'turn.interrupted']

describe('what each tool is, and what to do about it', () => {
  it('sorts tools by what they touch', () => {
    expect(toolKind('Read')).toBe('read')
    expect(toolKind('Grep')).toBe('search')
    expect(toolKind('Edit')).toBe('edit')
    expect(toolKind('Write')).toBe('write')
    expect(toolKind('Bash')).toBe('shell')
    expect(toolKind('WebFetch')).toBe('web')
    expect(toolKind('mcp__celeste-devices__device_run')).toBe('mcp')
    expect(toolKind('Whatever')).toBe('other')
  })

  it('auto never asks; edits asks for commands; ask asks for everything but looking; plan allows only looking', () => {
    const outcomes = (mode: ApprovalMode) => ['Read', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'mcp__other__tool'].map((t) => decide(t, mode))
    expect(outcomes('auto')).toEqual(['allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'allow'])
    expect(outcomes('edits')).toEqual(['allow', 'allow', 'allow', 'allow', 'ask', 'ask', 'ask'])
    expect(outcomes('ask')).toEqual(['allow', 'allow', 'ask', 'ask', 'ask', 'ask', 'ask'])
    expect(outcomes('plan')).toEqual(['allow', 'allow', 'deny', 'deny', 'deny', 'deny', 'deny'])
  })

  it('lets Celeste\'s device tools through, since they raise their own card, but keeps plan mode to the ones that only look', () => {
    const tool = (name: string) => `mcp__${DEVICE_SERVER}__${name}`
    for (const mode of ['auto', 'edits', 'ask'] as const) expect(decide(tool('device_run'), mode)).toBe('allow')
    for (const [name, def] of Object.entries(TOOLS)) expect(decide(tool(name), 'plan')).toBe(def.needs === 'any' ? 'allow' : 'deny')
    expect(decide(tool('device_run'), 'plan')).toBe('deny')
    expect(decide('mcp__someone-else__device_run', 'ask')).toBe('ask')
  })

  it('words the approval card from the call', () => {
    expect(describeTool('Bash', { command: 'npm test', description: 'Run the tests' }, CWD)).toEqual({ kind: 'shell', title: 'Run the tests', detail: 'npm test' })
    expect(describeTool('Edit', { file_path: `${CWD}\\src\\a.ts` }, CWD)).toMatchObject({ kind: 'edit', detail: 'src/a.ts' })
    expect(describeTool('WebFetch', { url: 'https://example.com' }, CWD)).toMatchObject({ kind: 'web', detail: 'https://example.com' })
    expect(describeTool('Bash', { command: 'ls' }, CWD).title).toBe('Run a command')
  })

  it('reads the questions of an AskUserQuestion call', () => {
    const qs = questionsFrom({ questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }] })
    expect(qs).toEqual([{ header: 'Pick', question: 'Which?', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }])
    expect(questionsFrom({})).toEqual([])
  })
})

describe('the translator', () => {
  const run = (messages: SDKMessage[], cwd = CWD) => {
    const t = new Translator(cwd)
    return [t.begin('t1'), ...messages.flatMap((m) => t.handle(m))]
  }

  it('streams text and thinking, shows each streamed message once, and ends with usage and completion', () => {
    const events = run([init(), thinking('hmm'), ...text('Hello'), done()])
    expect(events).toEqual([
      { type: 'turn.started', turnId: 't1' },
      { type: 'thinking.delta', text: 'hmm' },
      { type: 'message.delta', text: 'Hello' },
      { type: 'usage.updated', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'turn.completed', turnId: 't1' }
    ])
  })

  it('shows a whole message when nothing was streamed for it', () => {
    const events = run([{ type: 'assistant', parent_tool_use_id: null, message: { id: 'x', content: [{ type: 'text', text: 'All at once' }] } } as never, done()])
    expect(events).toContainEqual({ type: 'message.delta', text: 'All at once' })
  })

  it('turns a tool call and its result into started and completed, with the output', () => {
    const events = run([toolUse('tu1', 'Bash', { command: 'dir', description: 'List files' }), toolResult('tu1', [{ type: 'text', text: 'a.txt' }]), done()])
    expect(events[1]).toMatchObject({ type: 'tool.started', id: 'tu1', kind: 'shell', title: 'List files' })
    expect(events[2]).toEqual({ type: 'tool.completed', id: 'tu1', ok: true, result: 'a.txt' })
  })

  it('marks a failed tool, and cuts a very long result', () => {
    const events = run([toolUse('a', 'Bash', { command: 'x' }), toolResult('a', 'boom', { is_error: true }), toolUse('b', 'Read', { file_path: `${CWD}\\big.txt` }), toolResult('b', 'z'.repeat(9000))])
    expect(events[2]).toMatchObject({ type: 'tool.completed', ok: false, result: 'boom' })
    const long = events[4] as { result: string }
    expect(long.result.length).toBeLessThan(4100)
    expect(events[3]).toMatchObject({ title: 'Read big.txt' })
  })

  it('shows an edit as a diff, from the patch Claude reports, or from the call when there is none', () => {
    const withPatch = run([
      toolUse('e1', 'Edit', { file_path: `${CWD}\\src\\a.ts`, old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok', { result: { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' keep', '-old', '+new'] }] } })
    ])
    const diff = (withPatch[2] as { diff: { path: string; status: string; added: number; removed: number; hunks: { header: string; lines: { type: string; oldNo?: number; newNo?: number }[] }[] }[] }).diff[0]
    expect(diff).toMatchObject({ path: 'src/a.ts', status: 'modified', added: 1, removed: 1 })
    expect(diff.hunks[0]).toMatchObject({ header: '@@ -3,2 +3,2 @@' })
    expect(diff.hunks[0]?.lines).toEqual([
      { type: 'ctx', text: 'keep', oldNo: 3, newNo: 3 },
      { type: 'del', text: 'old', oldNo: 4 },
      { type: 'add', text: 'new', newNo: 4 }
    ])

    const fromInput = run([toolUse('w1', 'Write', { file_path: `${CWD}\\new.txt`, content: 'one\ntwo\n' }), toolResult('w1', 'created')])
    expect((fromInput[2] as { diff: { status: string; added: number }[] }).diff[0]).toMatchObject({ status: 'added', added: 2 })
  })

  it('keeps plumbing tools and subagent chatter out of the timeline', () => {
    const events = run([
      toolUse('q', 'AskUserQuestion', { questions: [] }),
      toolUse('t', 'TodoWrite', { todos: [] }),
      { type: 'assistant', parent_tool_use_id: 'agent-1', message: { id: 's', content: [{ type: 'text', text: 'inner' }] } } as never,
      toolResult('q', 'x'),
      done()
    ])
    expect(types(events)).toEqual(['turn.started', 'usage.updated', 'turn.completed'])
  })

  it('ends a turn once, whatever arrives after', () => {
    const t = new Translator(CWD)
    t.begin('t1')
    expect(t.handle(done())).toHaveLength(2)
    expect(t.handle(done())).toEqual([])
    expect(t.fail({ code: 'unknown', message: 'x', retryable: false })).toEqual([])
    expect(t.interrupted()).toEqual([])
  })

  it('turns an error result into a failure with the right kind', () => {
    const failed = (result: string, code?: string) => {
      const t = new Translator(CWD)
      t.begin('t1')
      const events = t.handle({ type: 'assistant', parent_tool_use_id: null, ...(code ? { error: code } : {}), message: { id: 'e', content: [] } } as never)
      return [...events, ...t.handle({ type: 'result', subtype: 'success', is_error: true, result, session_id: SID } as never)].find((e) => e.type === 'turn.failed') as Extract<AgentEvent, { type: 'turn.failed' }>
    }
    expect(failed('Invalid API key · Please run /login').error).toMatchObject({ code: 'auth', retryable: false })
    expect(failed('Something', 'authentication_failed').error.code).toBe('auth')
    expect(failed('You have hit your usage limit').error).toMatchObject({ code: 'rate_limit', retryable: true })
    expect(failed('boom').error).toMatchObject({ code: 'unknown', message: 'boom' })
    expect(errorFrom('server_error', 'x').code).toBe('network')
  })
})

// --- the session, against a fake query ------------------------------------------------------------------

type Respond = (message: SDKUserMessage, q: FakeQuery) => Promise<void> | void

class FakeQuery implements ClaudeQuery {
  readonly out = new EventQueue<SDKMessage>()
  readonly received: SDKUserMessage[] = []
  readonly models: (string | undefined)[] = []
  readonly efforts: (Effort | null | undefined)[] = []
  interrupted = 0
  closed = false
  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
    private readonly respond: Respond
  ) {
    void (async () => {
      for await (const m of prompt) {
        this.received.push(m)
        await this.respond(m, this)
      }
    })()
  }
  emit(...messages: SDKMessage[]): void {
    for (const m of messages) this.out.push(m)
  }
  /** What the real query does with a tool: ask the permission callback, and only run it if allowed. */
  async tool(name: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const canUseTool = this.options.canUseTool as CanUseTool
    return (await canUseTool(name, input, { signal: new AbortController().signal, toolUseID: 'tu', requestId: 'r' } as never)) as PermissionResult
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]()
  }
  async interrupt(): Promise<void> {
    this.interrupted++
    this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: SID } as never)
  }
  async setModel(model?: string): Promise<void> {
    this.models.push(model)
  }
  async applyFlagSettings(s: { effortLevel?: Effort | null }): Promise<void> {
    this.efforts.push(s.effortLevel)
  }
  close(): void {
    this.closed = true
    this.out.close()
  }
}

interface Setup {
  session: ClaudeAgentSession
  queries: FakeQuery[]
  remembered: string[]
  set: (patch: Partial<ReturnType<AdapterContext['options']>>) => void
  launches: number
}

function setup(respond: Respond, over: { approval?: ApprovalMode; vendorSessionId?: string; transcript?: string; mode?: 'chat' | 'develop'; devices?: boolean; launch?: () => Promise<{ env: Env }> } = {}): Setup {
  const queries: FakeQuery[] = []
  const remembered: string[] = []
  const options: ReturnType<AdapterContext['options']> = { model: 'claude:sonnet', effort: null, approval: over.approval ?? 'auto', cwd: CWD }
  const ctx: AdapterContext = {
    sessionId: 's-1',
    vendor: 'claude',
    mode: over.mode ?? 'develop',
    options: () => ({ ...options }),
    getApproval: () => options.approval,
    ...(over.vendorSessionId ? { vendorSessionId: over.vendorSessionId } : {}),
    remember: (id) => remembered.push(id),
    transcript: () => over.transcript ?? '',
    attachmentPath: () => undefined,
  }
  const start: StartQuery = ({ prompt, options: o }) => {
    const q = new FakeQuery(o, prompt, respond)
    queries.push(q)
    return q
  }
  const s: Setup = {
    queries,
    remembered,
    launches: 0,
    set: (patch) => Object.assign(options, patch),
    session: new ClaudeAgentSession({
      ctx,
      start,
      launch: async () => {
        s.launches++
        return over.launch ? over.launch() : { env: { ANTHROPIC_API_KEY: '' }, executable: 'C:\\claude\\claude.exe' }
      },
      resolveModel: (model, effort) => ({ model: model.replace('claude:', ''), ...(effort ? { effort } : {}) }),
      ...(over.devices === false ? {} : { deviceServer: () => ({ url: 'http://127.0.0.1:5555/mcp', token: 'tok' }) })
    })
  }
  return s
}

/** Sends a message and collects events up to the end of the turn, answering cards as the test says. */
async function run(session: ClaudeAgentSession, message: string, react: (e: AgentEvent) => void = () => undefined): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  const it = session.events[Symbol.asyncIterator]()
  session.send({ text: message, attachments: [] })
  for (;;) {
    const r = await Promise.race([it.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out. Got: ${types(out).join(', ')}`)), 4000))])
    if (r.done) break
    out.push(r.value)
    react(r.value)
    if (TERMINAL.includes(r.value.type)) break
  }
  return out
}

const plain: Respond = (_m, q) => q.emit(init(), ...text('Hi there'), done())

describe('a Claude session', () => {
  it('starts Claude Code with the session settings, streams, and remembers the id', async () => {
    const t = setup(plain)
    const events = await run(t.session, 'Hello')
    expect(types(events)).toEqual(['turn.started', 'message.delta', 'usage.updated', 'turn.completed'])
    expect(t.queries).toHaveLength(1)
    const o = (t.queries[0] as FakeQuery).options
    expect(o).toMatchObject({ cwd: CWD, model: 'sonnet', permissionMode: 'default', includePartialMessages: true, settingSources: ['project'], pathToClaudeCodeExecutable: 'C:\\claude\\claude.exe' })
    expect(o.resume).toBeUndefined()
    expect(t.remembered).toEqual([SID])
    expect(t.session.vendorSessionId).toBe(SID)
    const sent = (t.queries[0] as FakeQuery).received[0]?.message.content as { type: string; text: string }[]
    expect(sent).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('keeps the same process for the next message, and starts nothing again', async () => {
    const t = setup(plain)
    await run(t.session, 'one')
    await run(t.session, 'two')
    expect(t.queries).toHaveLength(1)
    expect(t.launches).toBe(1)
    expect((t.queries[0] as FakeQuery).received).toHaveLength(2)
  })

  it('does not load a person\'s own Claude settings into a Chat session, so their allow rules cannot skip Celeste\'s approvals', async () => {
    const t = setup(plain, { mode: 'chat' })
    await run(t.session, 'hi')
    expect((t.queries[0] as FakeQuery).options.settingSources).toEqual([])
  })

  it('connects Claude to Celeste\'s device tools with this session\'s token', async () => {
    const t = setup(plain)
    await run(t.session, 'hi')
    expect((t.queries[0] as FakeQuery).options.mcpServers).toEqual({ [DEVICE_SERVER]: { type: 'http', url: 'http://127.0.0.1:5555/mcp', headers: { Authorization: 'Bearer tok' } } })
    const none = setup(plain, { devices: false })
    await run(none.session, 'hi')
    expect((none.queries[0] as FakeQuery).options.mcpServers).toBeUndefined()
  })

  it('resumes the conversation it had, when it has a vendor session id', async () => {
    const t = setup(plain, { vendorSessionId: 'earlier-1' })
    await run(t.session, 'again')
    expect((t.queries[0] as FakeQuery).options.resume).toBe('earlier-1')
    const sent = (t.queries[0] as FakeQuery).received[0]?.message.content as { text: string }[]
    expect(sent[0]?.text).toBe('again')
  })

  it('starts a new conversation from Celeste\'s log, and says so, when the old one is gone', async () => {
    let n = 0
    const t = setup(
      (_m, q) => {
        if (n++ === 0) q.emit({ type: 'result', subtype: 'success', is_error: true, result: 'No conversation found with session ID: earlier-1', session_id: '' } as never)
        else q.emit(init(), ...text('From the log'), done())
      },
      { vendorSessionId: 'earlier-1', transcript: 'User: first\n\nAssistant: ok\n\nUser: again' }
    )
    const events = await run(t.session, 'again')
    expect(t.queries).toHaveLength(2)
    expect((t.queries[1] as FakeQuery).options.resume).toBeUndefined()
    expect(events.filter((e) => e.type === 'message.delta').map((e) => (e as { text: string }).text).join('')).toBe(`${RESUME_NOTICE}From the log`)
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed' })
    const sent = (t.queries[1] as FakeQuery).received[0]?.message.content as { text: string }[]
    expect(sent[0]?.text).toContain('Earlier in this conversation')
    expect(sent[0]?.text).toContain('User: first')
    expect(sent[0]?.text.endsWith('again')).toBe(true)
    expect(types(events).filter((x) => x === 'turn.failed')).toHaveLength(0)
  })

  it('applies a model or effort changed in the window to the next message, only when it changed', async () => {
    const t = setup(plain)
    await run(t.session, 'one')
    const q = t.queries[0] as FakeQuery
    expect(q.models).toEqual([])
    t.set({ model: 'claude:opus', effort: 'high' })
    await run(t.session, 'two')
    expect(q.models).toEqual(['opus'])
    expect(q.efforts).toEqual(['high'])
    await run(t.session, 'three')
    expect(q.models).toEqual(['opus'])
  })

  it('asks before running a command in ask mode, and runs it on a yes', async () => {
    let result: PermissionResult | undefined
    const t = setup(
      async (_m, q) => {
        q.emit(init(), toolUse('tu', 'Bash', { command: 'npm test', description: 'Run the tests' }))
        result = await q.tool('Bash', { command: 'npm test', description: 'Run the tests' })
        q.emit(toolResult('tu', 'passed'), ...text('Done'), done())
      },
      { approval: 'ask' }
    )
    const events = await run(t.session, 'test it', (e) => {
      if (e.type === 'approval.requested') t.session.respond(e.requestId, { allow: true })
    })
    const card = events.find((e) => e.type === 'approval.requested')
    expect(card).toMatchObject({ kind: 'shell', title: 'Run the tests', detail: 'npm test' })
    expect(result).toMatchObject({ behavior: 'allow' })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed' })
  })

  it('tells Claude the user said no, when they did', async () => {
    let result: PermissionResult | undefined
    const t = setup(
      async (_m, q) => {
        q.emit(init())
        result = await q.tool('Bash', { command: 'rm -rf x' })
        q.emit(...text('Understood'), done())
      },
      { approval: 'ask' }
    )
    await run(t.session, 'delete', (e) => {
      if (e.type === 'approval.requested') t.session.respond(e.requestId, { allow: false })
    })
    expect(result).toMatchObject({ behavior: 'deny', message: 'The user denied this.' })
  })

  it('does not ask in auto mode, and in plan mode refuses a change without asking', async () => {
    const results: PermissionResult[] = []
    const t = setup(async (_m, q) => {
      q.emit(init())
      results.push(await q.tool('Edit', { file_path: 'a' }))
      q.emit(done())
    })
    const auto = await run(t.session, 'go')
    expect(types(auto)).not.toContain('approval.requested')
    t.set({ approval: 'plan' })
    const plan = await run(t.session, 'go again')
    expect(types(plan)).not.toContain('approval.requested')
    expect(results.map((r) => r.behavior)).toEqual(['allow', 'deny'])
    expect((results[1] as { message: string }).message).toMatch(/Plan mode/)
  })

  it('shows Claude\'s questions as a card, and hands the answers back keyed by question', async () => {
    let result: PermissionResult | undefined
    const input = { questions: [{ question: 'Which framework?', header: 'Framework', multiSelect: false, options: [{ label: 'React' }, { label: 'Vue' }] }, { question: 'Extras?', header: 'Extras', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] }
    const t = setup(async (_m, q) => {
      q.emit(init())
      result = await q.tool('AskUserQuestion', input)
      q.emit(done())
    })
    const events = await run(t.session, 'build', (e) => {
      if (e.type === 'ask_user.requested') t.session.respond(e.requestId, { 'Which framework?': 'React', 'Extras?': ['A', 'B'] })
    })
    const ask = events.find((e) => e.type === 'ask_user.requested') as Extract<AgentEvent, { type: 'ask_user.requested' }>
    expect(ask.questions.map((q) => q.question)).toEqual(['Which framework?', 'Extras?'])
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which framework?': 'React', 'Extras?': 'A, B' } } })
  })

  it('lets go of a question when the turn is stopped', async () => {
    let result: PermissionResult | undefined
    const t = setup(async (_m, q) => {
      q.emit(init())
      result = await q.tool('AskUserQuestion', { questions: [{ question: 'Q?', header: 'Q', multiSelect: false, options: [] }] })
    })
    const events = await run(t.session, 'ask', (e) => {
      if (e.type === 'ask_user.requested') void t.session.interrupt()
    })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.interrupted' })
    expect(result).toMatchObject({ behavior: 'deny' })
  })

  it('ends a stopped turn as interrupted, not failed', async () => {
    const t = setup((_m, q) => q.emit(init(), ...text('Working')))
    const events = await run(t.session, 'long', (e) => {
      if (e.type === 'message.delta') void t.session.interrupt()
    })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.interrupted' })
    expect(types(events)).not.toContain('turn.failed')
    expect((t.queries[0] as FakeQuery).interrupted).toBe(1)
  })

  it('ends the turn when Stop is pressed before Claude has even started', async () => {
    const t = setup(plain, { launch: () => new Promise(() => undefined) })
    const events = await run(t.session, 'hello', (e) => {
      if (e.type === 'turn.started') void t.session.interrupt()
    })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.interrupted' })
  })

  it('reports a failure to start as a failed turn with a readable reason', async () => {
    const t = setup(plain, { launch: async () => Promise.reject(new Error('Claude’s program is not installed.')) })
    const events = await run(t.session, 'hi')
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.failed', error: { message: 'Claude’s program is not installed.' } })
  })

  it('starts Claude Code again for the next message when it stopped on its own', async () => {
    let n = 0
    const t = setup((_m, q) => {
      if (n++ === 0) {
        q.emit(init())
        q.close()
      } else q.emit(init(), ...text('Back'), done())
    })
    const first = await run(t.session, 'one')
    expect(first[first.length - 1]).toMatchObject({ type: 'turn.failed', error: { retryable: true } })
    const second = await run(t.session, 'two')
    expect(second[second.length - 1]).toMatchObject({ type: 'turn.completed' })
    expect(t.queries).toHaveLength(2)
    expect((t.queries[1] as FakeQuery).options.resume).toBe(SID)
  })

  it('sends an image as an image block and other files by their place on disk', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'celeste-claude-'))
    try {
      writeFileSync(join(dir, 'a.png'), Buffer.from([137, 80, 78, 71]))
      writeFileSync(join(dir, 'b.pdf'), 'x')
      const t = setup(plain)
      const paths: Record<string, string> = { img: join(dir, 'a.png'), doc: join(dir, 'b.pdf') }
      const ctx = (t.session as unknown as { deps: { ctx: AdapterContext } }).deps.ctx
      ctx.attachmentPath = (id) => paths[id]
      t.session.send({
        text: 'look',
        attachments: [
          { id: 'img', name: 'a.png', mime: 'image/png', size: 4 },
          { id: 'doc', name: 'b.pdf', mime: 'application/pdf', size: 1 }
        ]
      })
      for await (const e of t.session.events) if (e.type === 'turn.completed') break
      const content = (t.queries[0] as FakeQuery).received[0]?.message.content as { type: string; text?: string; source?: { media_type: string; data: string } }[]
      expect(content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') } })
      expect(content[1]?.text).toContain('look')
      expect(content[1]?.text).toContain(join(dir, 'b.pdf'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('closes Claude Code when the session closes', async () => {
    const t = setup(plain)
    await run(t.session, 'hi')
    await t.session.close()
    expect((t.queries[0] as FakeQuery).closed).toBe(true)
  })
})

// --- the host ------------------------------------------------------------------------------------------

const MODELS = [
  { value: 'default', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'medium', 'high'] as Effort[] },
  { value: 'opus', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'high', 'max'] as Effort[] },
  { value: 'haiku', displayName: 'Haiku' }
]

function host(over: { account?: Probe['account']; key?: string | null; allowSubscription?: boolean; probe?: () => Promise<Probe>; login?: (env: Env) => LoginProcess; verify?: 'ok' | 'rejected' | 'unknown'; baseEnv?: Env } = {}) {
  const envs: Env[] = []
  const account = { current: over.account ?? { tokenSource: 'none' } }
  const h = new ClaudeHost({
    probe: over.probe ?? (async (env) => (envs.push(env), { account: account.current, models: MODELS })),
    getKey: async () => over.key ?? null,
    baseEnv: over.baseEnv ?? { PATH: 'p', ANTHROPIC_API_KEY: 'from-the-persons-own-environment' },
    ...(over.verify ? { verifyKey: async () => over.verify as 'ok' | 'rejected' | 'unknown' } : {}),
    configDir: 'C:\\data\\claude-config',
    allowSubscription: over.allowSubscription,
    startLogin: over.login ?? (() => new FakeLogin())
  })
  return { h, envs, account }
}

class FakeLogin implements LoginProcess {
  killed = false
  private exit: ((code: number | null) => void) | undefined
  onExit(cb: (code: number | null) => void): void {
    this.exit = cb
  }
  kill(): void {
    this.killed = true
  }
  finish(code: number | null): void {
    this.exit?.(code)
  }
}

describe('the Claude host', () => {
  it('runs Claude Code in Celeste\'s own settings folder, with no key from the person\'s environment', async () => {
    const { h, envs } = host()
    await h.status()
    expect(envs[0]).toMatchObject({ CLAUDE_CONFIG_DIR: 'C:\\data\\claude-config', ANTHROPIC_API_KEY: '', PATH: 'p' })
  })

  it('caps how often Claude Code retries a failed request, unless the person set their own limit', async () => {
    const a = host()
    await a.h.status()
    expect(a.envs[0]?.['CLAUDE_CODE_MAX_RETRIES']).toBe('3')
    const b = host({ baseEnv: { CLAUDE_CODE_MAX_RETRIES: '8' } })
    await b.h.status()
    expect(b.envs[0]?.['CLAUDE_CODE_MAX_RETRIES']).toBe('8')
  })

  it('refuses a pasted key that Anthropic rejects, and trusts one it could not check', async () => {
    expect(await host({ key: 'sk-ant-wrong0000', verify: 'rejected' }).h.status()).toEqual({ state: 'unavailable', message: 'Anthropic did not accept this API key.' })
    expect(await host({ key: 'sk-ant-right1111', verify: 'ok' }).h.status()).toEqual({ state: 'signed-in', account: 'API key ending 1111' })
    // Not reaching Anthropic (offline) says nothing about the key.
    expect(await host({ key: 'sk-ant-right2222', verify: 'unknown' }).h.status()).toEqual({ state: 'signed-in', account: 'API key ending 2222' })
  })

  it('hands a pasted key to Claude Code, and reports it by its last four characters', async () => {
    const { h, envs } = host({ key: 'sk-ant-abcdef1234' })
    expect(await h.status()).toEqual({ state: 'signed-in', account: 'API key ending 1234' })
    expect(envs[0]?.['ANTHROPIC_API_KEY']).toBe('sk-ant-abcdef1234')
  })

  it('tells signed out, a Console login, and a subscription login apart', async () => {
    expect(await host().h.status()).toEqual({ state: 'signed-out' })
    expect(await host({ account: { tokenSource: 'oauth', organization: 'Acme' } }).h.status()).toEqual({ state: 'signed-in', account: 'Console · Acme' })
    // Anthropic does not allow other apps to sign people in with a subscription, so it counts as nobody unless development says otherwise.
    expect(await host({ account: { tokenSource: 'claude.ai', subscriptionType: 'pro' } }).h.status()).toEqual({ state: 'signed-out' })
    expect(await host({ account: { tokenSource: 'claude.ai', subscriptionType: 'pro' }, allowSubscription: true }).h.status()).toEqual({ state: 'signed-in', account: 'Claude pro (development)' })
  })

  it('says why when Claude Code cannot start', async () => {
    const { h } = host({ probe: () => Promise.reject(new Error('Claude did not start in time.')) })
    expect(await h.status()).toEqual({ state: 'unavailable', message: 'Claude did not start in time.' })
  })

  it('lists Claude\'s own models with the effort each takes', async () => {
    const { h } = host()
    const models = await h.models()
    expect(models.map((m) => m.id)).toEqual(['claude:default', 'claude:opus', 'claude:haiku'])
    expect(models[0]).toMatchObject({ label: 'Default', vendor: 'claude', efforts: ['low', 'medium', 'high'], images: true })
    expect(models[2]?.efforts).toEqual([])
    expect(toModels([]).length).toBe(0)
  })

  it('picks the model and the effort it takes, and understands a name saved before Claude was real', async () => {
    const { h } = host()
    await h.models()
    expect(h.resolve('claude:opus', 'max')).toEqual({ model: 'opus', effort: 'max' })
    expect(h.resolve('claude:opus', 'medium')).toEqual({ model: 'opus' })
    expect(h.resolve('claude:haiku', 'high')).toEqual({ model: 'haiku' })
    expect(h.resolve('claude:default', 'low')).toEqual({ effort: 'low' })
    expect(h.resolve('claude-opus', null)).toEqual({ model: 'opus' })
    expect(h.resolve('claude-sonnet', null)).toEqual({ model: 'sonnet' })
    expect(h.resolve('copilot-auto', null)).toEqual({})
  })

  describe('signing in', () => {
    const wait = () => new Promise((r) => setTimeout(r, 10))

    it('finishes when the browser step does, reading the account from Claude Code', async () => {
      const login = new FakeLogin()
      const { h, account } = host({ login: () => login })
      const seen: unknown[] = []
      await h.signIn((p) => seen.push(p))
      account.current = { tokenSource: 'oauth', organization: 'Acme' }
      login.finish(0)
      await wait()
      expect(seen).toEqual([{ state: 'done', account: 'Console · Acme' }])
    })

    it('connects at once when someone is already signed in', async () => {
      let started = false
      const { h } = host({ account: { tokenSource: 'oauth', email: 'a@b.c' }, login: () => ((started = true), new FakeLogin()) })
      const seen: unknown[] = []
      await h.signIn((p) => seen.push(p))
      expect(seen).toEqual([{ state: 'done', account: 'Console · a@b.c' }])
      expect(started).toBe(false)
    })

    it('reports a sign-in that was not completed, and one that signed in a subscription', async () => {
      const first = new FakeLogin()
      const a = host({ login: () => first })
      const seenA: { state: string; message?: string }[] = []
      await a.h.signIn((p) => seenA.push(p))
      first.finish(1)
      await wait()
      expect(seenA).toEqual([{ state: 'failed', message: 'Signing in was not completed.' }])

      const second = new FakeLogin()
      const b = host({ login: () => second })
      const seenB: { state: string; message?: string }[] = []
      await b.h.signIn((p) => seenB.push(p))
      b.account.current = { tokenSource: 'claude.ai', subscriptionType: 'max' }
      second.finish(0)
      await wait()
      expect(seenB[0]?.state).toBe('failed')
      expect(seenB[0]?.message).toMatch(/subscription/)
    })

    it('stops the process and reports nothing when cancelled, and allows trying again', async () => {
      const login = new FakeLogin()
      const { h } = host({ login: () => login })
      const seen: unknown[] = []
      await h.signIn((p) => seen.push(p))
      await expect(h.signIn(() => undefined)).rejects.toThrow(/already/)
      await h.cancelSignIn()
      login.finish(0)
      await wait()
      expect(login.killed).toBe(true)
      expect(seen).toEqual([])
      const again = new FakeLogin()
      const second = host({ login: () => again })
      await expect(second.h.signIn(() => undefined)).resolves.toBeUndefined()
    })
  })
})
