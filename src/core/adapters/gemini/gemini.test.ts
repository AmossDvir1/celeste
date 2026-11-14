import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent, ApprovalMode } from '@shared/agent'
import type { AdapterContext } from '../types'
import { RpcClient, type Transport } from '../rpc'
import { GeminiHost, labelOf, settingsFor, toModels, type Launch } from './host'
import { GEMINI_VERSION } from './program'
import { DEVICE_SERVER, GeminiAgentSession, MODE, acpServers, decide } from './session'
import { Translator, diffOfTexts, errorFrom, toolKind } from './translate'

describe('the translator', () => {
  const run = (updates: Record<string, unknown>[], cwd?: string) => {
    const t = new Translator(cwd)
    const events: AgentEvent[] = [t.begin('turn-1')]
    for (const u of updates) events.push(...t.handle(u))
    return { t, events }
  }
  const text = (sessionUpdate: string, value: string) => ({ sessionUpdate, content: { type: 'text', text: value } })

  it('streams the message, and the thinking apart from it', () => {
    const { events } = run([text('agent_thought_chunk', 'Hmm'), text('agent_message_chunk', 'Hello '), text('agent_message_chunk', 'there')])
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'thinking.delta', 'message.delta', 'message.delta'])
  })

  it('does not show what Gemini announces about its own mode, nor the conversation it replays while loading', () => {
    const { t, events } = run([text('agent_message_chunk', '[MODE_UPDATE] yolo'), text('agent_message_chunk', 'Hi')])
    expect(events.filter((e) => e.type === 'message.delta')).toHaveLength(1)
    t.loading = true
    expect(t.handle(text('agent_message_chunk', 'an old answer'))).toEqual([])
    expect(t.handle(text('user_message_chunk', 'an old question'))).toEqual([])
    t.loading = false
    expect(t.handle(text('agent_message_chunk', 'new'))).toHaveLength(1)
  })

  it('shows a command as a tool call with its output and result', () => {
    const call = { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', title: 'npm test', status: 'in_progress', content: [], rawInput: { command: 'npm test' } }
    const { events } = run([
      call,
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: '3 passed' } }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '3 passed' } }] }
    ])
    expect(events[1]).toMatchObject({ type: 'tool.started', id: 'c1', kind: 'shell', title: 'npm test', input: { command: 'npm test' } })
    expect(events[2]).toMatchObject({ type: 'tool.output', id: 'c1', text: '3 passed' })
    expect(events[3]).toMatchObject({ type: 'tool.completed', id: 'c1', ok: true, result: '3 passed' })
  })

  it('marks a call that failed or was refused as not ok, and ignores updates for calls it never saw', () => {
    const { events } = run([
      { sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'execute', title: 'rm -rf', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool "run_shell_command" was canceled by the user.' } }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed' }
    ])
    expect(events.at(-1)).toMatchObject({ type: 'tool.completed', id: 'x', ok: false, result: expect.stringContaining('canceled') })
    expect(events).toHaveLength(3)
  })

  it('shows an edit with a diff, a new file as a write, and says nothing for a call that only thinks', () => {
    const diff = { type: 'diff', path: 'D:\\p\\src\\a.ts', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' }
    const { events } = run(
      [
        { sessionUpdate: 'tool_call', toolCallId: 'e1', kind: 'edit', title: 'Editing a.ts', status: 'pending', content: [diff] },
        { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', content: [diff] },
        { sessionUpdate: 'tool_call', toolCallId: 'n1', kind: 'edit', title: 'Writing n.ts', status: 'pending', content: [{ type: 'diff', path: 'n.ts', oldText: '', newText: 'x\n', _meta: { kind: 'add' } }] },
        { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'think', title: 'Thinking', status: 'in_progress' }
      ],
      'D:\\p'
    )
    expect(events[1]).toMatchObject({ kind: 'edit', title: 'Editing a.ts' })
    const done = events[2] as Extract<AgentEvent, { type: 'tool.completed' }>
    expect(done.diff?.[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', added: 1, removed: 1 })
    expect(events[3]).toMatchObject({ kind: 'write' })
    expect(events).toHaveLength(4)
  })

  it('ends the turn by why Gemini stopped, with the tokens it used', () => {
    const end = (result: Record<string, unknown>) => {
      const { t } = run([])
      return t.finish(result)
    }
    expect(end({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } })).toMatchObject([{ type: 'usage.updated', usage: { inputTokens: 10, outputTokens: 2 } }, { type: 'turn.completed' }])
    expect(end({ stopReason: 'cancelled' })).toMatchObject([{ type: 'turn.interrupted' }])
    expect(end({ stopReason: 'refusal' })).toMatchObject([{ type: 'turn.failed', error: { message: expect.stringContaining('declined') } }])
    expect(end({ stopReason: 'max_tokens' })[0]).toMatchObject({ type: 'turn.failed' })
    // Said once: a turn that already ended is not ended again.
    const { t } = run([])
    t.finish({ stopReason: 'end_turn' })
    expect(t.finish({ stopReason: 'end_turn' })).toEqual([])
    expect(t.fail({ code: 'unknown', message: 'x', retryable: false })).toEqual([])
  })

  it('knows what kind of call each of Gemini’s kinds is', () => {
    expect([toolKind('read'), toolKind('delete'), toolKind('move'), toolKind('search'), toolKind('execute'), toolKind('fetch'), toolKind('mystery')]).toEqual(['read', 'edit', 'edit', 'search', 'shell', 'web', 'other'])
  })
})

describe('the diff of a changed file', () => {
  it('shows what changed with a few lines around it', () => {
    const old = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    const next = old.replace('line 6', 'line six')
    const d = diffOfTexts('f.txt', old, next)
    expect(d).toMatchObject({ status: 'modified', added: 1, removed: 1 })
    expect(d.hunks).toHaveLength(1)
    const lines = d.hunks[0]?.lines ?? []
    expect(lines.filter((l) => l.type === 'ctx')).toHaveLength(6)
    expect(lines.find((l) => l.type === 'del')).toMatchObject({ text: 'line 6', oldNo: 6 })
    expect(lines.find((l) => l.type === 'add')).toMatchObject({ text: 'line six', newNo: 6 })
    expect(d.hunks[0]?.header).toBe('@@ -3,7 +3,7 @@')
  })

  it('shows a new file as all added and an emptied one as all removed', () => {
    expect(diffOfTexts('n.txt', '', 'a\nb\n', 'add')).toMatchObject({ status: 'added', added: 2, removed: 0 })
    expect(diffOfTexts('g.txt', 'a\nb\n', '', 'delete')).toMatchObject({ status: 'deleted', added: 0, removed: 2 })
    expect(diffOfTexts('same.txt', 'a\n', 'a\n').hunks).toEqual([])
  })
})

describe('what Gemini reports as errors', () => {
  it('tells a wrong key, a limit, the network and the rest apart', () => {
    expect(errorFrom('API key not valid. Please pass a valid API key.').code).toBe('auth')
    expect(errorFrom('Quota exceeded for this model')).toMatchObject({ code: 'rate_limit', retryable: true })
    expect(errorFrom('fetch failed: ENOTFOUND')).toMatchObject({ code: 'network', retryable: true })
    expect(errorFrom('Something odd')).toMatchObject({ code: 'unknown', retryable: false })
  })
})

describe('approval modes', () => {
  const modes: ApprovalMode[] = ['auto', 'edits', 'ask', 'plan']
  it('are Gemini’s own modes, so it asks, or does not, by itself', () => {
    expect(modes.map((m) => MODE[m])).toEqual(['yolo', 'autoEdit', 'default', 'plan'])
  })
  it('answer what Gemini asks as the picker says they do', () => {
    expect(modes.map((m) => decide('shell', m))).toEqual(['allow', 'ask', 'ask', 'deny'])
    expect(modes.map((m) => decide('edit', m))).toEqual(['allow', 'allow', 'ask', 'deny'])
    expect(modes.map((m) => decide('web', m))).toEqual(['allow', 'ask', 'ask', 'deny'])
    expect(modes.map((m) => decide('read', m))).toEqual(['allow', 'allow', 'allow', 'allow'])
  })
})

describe('what Gemini is told about tools', () => {
  it('lists the device server first and in its own name, and the person’s tools in the protocol’s form', () => {
    const list = acpServers(
      [
        { key: 'github', type: 'http', url: 'https://mcp.example', args: [], env: {}, headers: { 'X-Org': 'a' } },
        { key: 'files', type: 'stdio', command: 'mcp.exe', args: ['--root', 'D:\\p'], env: { TOKEN: 'x' }, headers: {} },
        { key: DEVICE_SERVER, type: 'http', url: 'http://evil', args: [], env: {}, headers: {} }
      ],
      { url: 'http://127.0.0.1:5000/mcp', token: 'tok' }
    )
    expect(list).toEqual([
      { type: 'http', name: 'celeste-devices', url: 'http://127.0.0.1:5000/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok' }] },
      { type: 'http', name: 'github', url: 'https://mcp.example', headers: [{ name: 'X-Org', value: 'a' }] },
      { name: 'files', command: 'mcp.exe', args: ['--root', 'D:\\p'], env: [{ name: 'TOKEN', value: 'x' }] }
    ])
  })
})

describe('the models', () => {
  it('are labelled the way people say them, with Auto as Gemini’s own choice and no effort setting', () => {
    expect(labelOf('gemini-3.1-pro-preview')).toBe('Gemini 3.1 Pro Preview')
    expect(toModels([{ modelId: 'auto', name: 'Auto' }, { modelId: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview' }])).toEqual([
      { id: 'gemini:auto', vendor: 'gemini', label: 'Auto', efforts: [], images: true },
      { id: 'gemini:gemini-3-flash-preview', vendor: 'gemini', label: 'Gemini 3 Flash Preview', efforts: [], images: true }
    ])
  })
  it('is pinned to the version Celeste was tried with', () => {
    expect(GEMINI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// --- the host and the session, with a fake Gemini ---------------------------------------------------------------

const hostWith = (over: Partial<ConstructorParameters<typeof GeminiHost>[0]> = {}) =>
  new GeminiHost({ program: () => 'C:\\programs\\gemini.js', getKey: async () => null, geminiHome: mkdtempSync(join(tmpdir(), 'celeste-gemini-unit-')), baseEnv: { PATH: 'p', GOOGLE_API_KEY: 'ambient', GOOGLE_GENAI_USE_VERTEXAI: 'true', GEMINI_SANDBOX: 'docker' }, node: 'C:\\electron\\celeste.exe', listModels: async () => [], ...over })

describe('the Gemini host', () => {
  it('reports signed out, a key, a refused key and a missing program', async () => {
    expect(await hostWith().status()).toEqual({ state: 'signed-out' })
    expect(await hostWith({ getKey: async () => 'AIza-abcdef1234' }).status()).toEqual({ state: 'signed-in', account: 'API key ending 1234' })
    expect(await hostWith({ getKey: async () => 'AIza-abcdef1234', verifyKey: async () => 'rejected' }).status()).toEqual({ state: 'unavailable', message: 'Google did not accept this API key.' })
    expect(await hostWith({ getKey: async () => 'AIza-abcdef1234', verifyKey: async () => 'unknown' }).status()).toMatchObject({ state: 'signed-in' })
    expect(await hostWith({ program: () => undefined }).status()).toEqual({ state: 'runtime-missing' })
  })

  it('starts the CLI with Electron’s Node, its own settings folder, and the key in a variable, not the person’s other Google settings', async () => {
    const host = hostWith({ getKey: async () => 'AIza-pasted-9999', baseUrl: 'http://127.0.0.1:1' })
    const launch: Launch = await host.launch()
    try {
      expect(launch.file).toBe('C:\\electron\\celeste.exe')
      expect(launch.args).toEqual(['C:\\programs\\gemini.js', '--acp'])
      expect(launch.env['ELECTRON_RUN_AS_NODE']).toBe('1')
      expect(launch.env['GEMINI_API_KEY']).toBe('AIza-pasted-9999')
      expect(launch.env['GOOGLE_GEMINI_BASE_URL']).toBe('http://127.0.0.1:1')
      expect(launch.env['GEMINI_CLI_NO_RELAUNCH']).toBe('true')
      for (const name of ['GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_SANDBOX']) expect(launch.env[name]).toBeUndefined()
      // A secret never goes on the command line, where other programs can read it.
      expect(JSON.stringify(launch.args)).not.toContain('AIza-pasted-9999')
      const written = JSON.parse(readFileSync(join(launch.env['GEMINI_CLI_HOME'] as string, '.gemini', 'settings.json'), 'utf8')) as unknown
      expect(written).toEqual(settingsFor())
    } finally {
      rmSync(launch.env['GEMINI_CLI_HOME'] as string, { recursive: true, force: true })
    }
  })

  it('says to connect when there is no key, and to download when there is no program', async () => {
    await expect(hostWith().launch()).rejects.toThrow(/not connected to Gemini/)
    await expect(hostWith({ program: () => undefined, getKey: async () => 'k' }).launch()).rejects.toThrow(/not on this computer/)
  })

  it('picks the model the session asks for', () => {
    const host = hostWith()
    expect(host.resolve('gemini:gemini-2.5-pro')).toBe('gemini-2.5-pro')
    expect(host.resolve('gemini:auto')).toBe('auto')
    expect(host.resolve('openai:gpt-x')).toBeUndefined()
  })
})

/** A Gemini that follows a script: answers requests by method, and can send messages of its own. */
class FakeAcp implements Transport {
  readonly written: Record<string, unknown>[] = []
  private line: (l: string) => void = () => undefined
  private exit: (code: number | null) => void = () => undefined
  killed = false
  answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    initialize: () => ({ protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } }),
    authenticate: () => ({}),
    'session/new': () => ({ sessionId: 'session-1', modes: { currentModeId: 'default', availableModes: ['default', 'autoEdit', 'yolo', 'plan'].map((id) => ({ id })) }, models: { currentModelId: 'auto', availableModels: [] } }),
    'session/load': () => ({ modes: { currentModeId: 'default', availableModes: ['default', 'autoEdit', 'yolo', 'plan'].map((id) => ({ id })) }, models: { currentModelId: 'auto' } }),
    'session/set_model': () => ({}),
    'session/set_mode': () => ({}),
    'session/prompt': () => new Promise(() => undefined)
  }
  write(line: string): void {
    const m = JSON.parse(line) as Record<string, unknown>
    this.written.push(m)
    if (typeof m['id'] === 'number' && typeof m['method'] === 'string') {
      const answer = this.answers[m['method']]
      queueMicrotask(() => {
        if (!answer) return this.line(JSON.stringify({ jsonrpc: '2.0', id: m['id'], error: { message: `no answer for ${m['method']}` } }))
        Promise.resolve()
          .then(() => answer((m['params'] ?? {}) as Record<string, unknown>))
          .then(
            (result) => this.line(JSON.stringify({ jsonrpc: '2.0', id: m['id'], result })),
            (err: unknown) => this.line(JSON.stringify({ jsonrpc: '2.0', id: m['id'], error: { message: 'Internal error', data: { details: err instanceof Error ? err.message : String(err) } } }))
          )
      })
    }
  }
  onLine(cb: (l: string) => void): void {
    this.line = cb
  }
  onExit(cb: (c: number | null) => void): void {
    this.exit = cb
  }
  stderr(): string {
    return ''
  }
  kill(): void {
    this.killed = true
    this.exit(null)
  }
  say(message: unknown): void {
    this.line(JSON.stringify({ jsonrpc: '2.0', ...(message as object) }))
  }
  reply(id: number): Record<string, unknown> | undefined {
    return this.written.find((m) => m['id'] === id && m['method'] === undefined)
  }
  method(name: string): Record<string, unknown>[] {
    return this.written.filter((m) => m['method'] === name)
  }
}

function sessionWith(over: { approval?: ApprovalMode; vendorSessionId?: string; answers?: FakeAcp['answers']; model?: string } = {}) {
  const processes: FakeAcp[] = []
  const remembered: string[] = []
  const options = { model: over.model ?? 'gemini:gemini-3-flash-preview', effort: null as null, approval: over.approval ?? ('ask' as ApprovalMode), cwd: 'D:\\p' }
  const ctx: AdapterContext = {
    sessionId: 's',
    vendor: 'gemini',
    mode: 'develop',
    options: () => ({ ...options }),
    getApproval: () => options.approval,
    ...(over.vendorSessionId ? { vendorSessionId: over.vendorSessionId } : {}),
    remember: (id) => remembered.push(id),
    transcript: () => '',
    attachmentPath: () => undefined
  }
  const session = new GeminiAgentSession({
    ctx,
    launch: async () => ({ file: 'node', args: [], env: {} }),
    connect: (_launch, handlers, o) => {
      const p = new FakeAcp()
      Object.assign(p.answers, over.answers)
      processes.push(p)
      return new RpcClient(p, handlers, o)
    },
    resolveModel: (model) => (model.startsWith('gemini:') ? model.slice(7) : undefined),
    deviceServer: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'd' })
  })
  return { session, processes, remembered, options }
}

const collect = async (session: GeminiAgentSession, until: string[], into: AgentEvent[] = []) => {
  const it = session.events[Symbol.asyncIterator]()
  for (;;) {
    const r = await it.next()
    if (r.done) break
    into.push(r.value)
    if (until.includes(r.value.type)) break
  }
  return into
}
const tick = () => new Promise((r) => setTimeout(r, 25))

describe('the session, with a fake Gemini', () => {
  it('opens a session with the person’s tools, sets the model and mode, and sends the message in the protocol’s form', async () => {
    const { session, processes, remembered } = sessionWith({ approval: 'auto' })
    session.send({ text: 'hi', attachments: [] })
    await tick()
    const gemini = processes[0] as FakeAcp
    expect(gemini.written.every((m) => m['jsonrpc'] === '2.0')).toBe(true)
    expect(gemini.method('initialize')[0]?.['params']).toMatchObject({ protocolVersion: 1 })
    expect(gemini.method('authenticate')[0]?.['params']).toEqual({ methodId: 'gemini-api-key' })
    expect(gemini.method('session/new')[0]?.['params']).toMatchObject({ cwd: 'D:\\p', mcpServers: [{ type: 'http', name: 'celeste-devices' }] })
    expect(gemini.method('session/set_model')[0]?.['params']).toEqual({ sessionId: 'session-1', modelId: 'gemini-3-flash-preview' })
    expect(gemini.method('session/set_mode')[0]?.['params']).toEqual({ sessionId: 'session-1', modeId: 'yolo' })
    expect(remembered).toEqual(['session-1'])
    expect(gemini.method('session/prompt')[0]?.['params']).toEqual({ sessionId: 'session-1', prompt: [{ type: 'text', text: 'hi' }] })
    await session.close()
  })

  it('changes the model and mode only when the window changed them, on the same process', async () => {
    const { session, processes, options } = sessionWith({ approval: 'ask', answers: { 'session/prompt': () => ({ stopReason: 'end_turn' }) } })
    session.send({ text: 'one', attachments: [] })
    await tick()
    const gemini = processes[0] as FakeAcp
    // "ask" is the mode the session opened in, so it is not set again.
    expect(gemini.method('session/set_mode')).toHaveLength(0)
    options.approval = 'plan'
    options.model = 'gemini:gemini-2.5-pro'
    session.send({ text: 'two', attachments: [] })
    await tick()
    expect(processes).toHaveLength(1)
    expect(gemini.method('session/set_mode').at(-1)?.['params']).toMatchObject({ modeId: 'plan' })
    expect(gemini.method('session/set_model').at(-1)?.['params']).toMatchObject({ modelId: 'gemini-2.5-pro' })
    await session.close()
  })

  it('answers a permission request from the person’s answer', async () => {
    const { session, processes } = sessionWith({ approval: 'ask' })
    const events: AgentEvent[] = []
    const done = collect(session, ['approval.requested'], events)
    session.send({ text: 'go', attachments: [] })
    await tick()
    const gemini = processes[0] as FakeAcp
    const options = [
      { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }
    ]
    gemini.say({ id: 90, method: 'session/request_permission', params: { sessionId: 'session-1', options, toolCall: { toolCallId: 'run_shell_command__1', kind: 'execute', title: 'npm test', status: 'pending' } } })
    await done
    const card = events.find((e) => e.type === 'approval.requested') as Extract<AgentEvent, { type: 'approval.requested' }>
    expect(card).toMatchObject({ kind: 'shell', title: 'Run a command', detail: 'npm test' })
    session.respond(card.requestId, { allow: true })
    await tick()
    expect(gemini.reply(90)).toEqual({ jsonrpc: '2.0', id: 90, result: { outcome: { outcome: 'selected', optionId: 'proceed_once' } } })

    gemini.say({ id: 91, method: 'session/request_permission', params: { options, toolCall: { toolCallId: 'write_file__1', kind: 'edit', title: 'Writing a.ts', locations: [{ path: 'D:\\p\\src\\a.ts' }] } } })
    await tick()
    // Stopping the turn lets go of the question: Gemini gets "reject", not silence.
    void session.interrupt()
    await tick()
    expect(gemini.reply(91)).toMatchObject({ result: { outcome: { outcome: 'selected', optionId: 'cancel' } } })
    gemini.say({ id: undefined })
    await session.close()
  })

  it('answers without asking where the mode says so, and always lets the device server through', async () => {
    const { session, processes, options } = sessionWith({ approval: 'edits' })
    session.send({ text: 'go', attachments: [] })
    await tick()
    const gemini = processes[0] as FakeAcp
    const opts = [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }]
    gemini.say({ id: 1, method: 'session/request_permission', params: { options: opts, toolCall: { toolCallId: 'write_file__1', kind: 'edit', title: 'Writing a.ts' } } })
    gemini.say({ id: 2, method: 'session/request_permission', params: { options: opts, toolCall: { toolCallId: 'mcp_celeste-devices_run__1', kind: 'other', title: 'celeste-devices: run' } } })
    gemini.say({ id: 3, method: 'fs/read_text_file', params: {} })
    options.approval = 'plan'
    gemini.say({ id: 4, method: 'session/request_permission', params: { options: opts, toolCall: { toolCallId: 'x', kind: 'execute', title: 'rm x' } } })
    await tick()
    expect(gemini.reply(1)).toMatchObject({ result: { outcome: { optionId: 'ok' } } })
    expect(gemini.reply(2)).toMatchObject({ result: { outcome: { optionId: 'ok' } } })
    expect((gemini.reply(3) as { error?: { message: string } }).error?.message).toMatch(/does not handle fs\/read_text_file/)
    expect(gemini.reply(4)).toMatchObject({ result: { outcome: { optionId: 'no' } } })
    await session.close()
  })

  it('cancels with the protocol’s own message, and ends the turn as stopped', async () => {
    const { session, processes } = sessionWith({ answers: { 'session/prompt': () => new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'cancelled' }), 200)) } })
    const events: AgentEvent[] = []
    const done = collect(session, ['turn.interrupted', 'turn.completed', 'turn.failed'], events)
    session.send({ text: 'go', attachments: [] })
    await tick()
    void session.interrupt()
    await done
    expect(events.at(-1)?.type).toBe('turn.interrupted')
    expect((processes[0] as FakeAcp).method('session/cancel')[0]?.['params']).toEqual({ sessionId: 'session-1' })
    // A notification has no id, so Gemini does not answer it.
    expect((processes[0] as FakeAcp).method('session/cancel')[0]).not.toHaveProperty('id')
    await session.close()
  })

  it('loads the conversation it was given, and shows nothing of what Gemini replays while it does', async () => {
    const { session, processes, remembered } = sessionWith({
      vendorSessionId: 'old-session',
      answers: { 'session/prompt': () => ({ stopReason: 'end_turn' }) }
    })
    const events: AgentEvent[] = []
    const done = collect(session, ['turn.completed'], events)
    session.send({ text: 'again', attachments: [] })
    await tick()
    const gemini = processes[0] as FakeAcp
    expect(gemini.method('session/load')[0]?.['params']).toMatchObject({ sessionId: 'old-session', cwd: 'D:\\p' })
    expect(gemini.method('session/new')).toHaveLength(0)
    expect(remembered).toEqual([])
    await done
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'turn.completed'])
    await session.close()
  })

  it('opens a new session from the log, and says so, when the one it was asked to load is gone', async () => {
    const { session, processes, remembered } = sessionWith({
      vendorSessionId: 'old-session',
      answers: { 'session/load': () => Promise.reject(new Error('Invalid session identifier "old-session".')), 'session/prompt': () => ({ stopReason: 'end_turn' }) }
    })
    const events: AgentEvent[] = []
    const done = collect(session, ['turn.completed'], events)
    session.send({ text: 'hello', attachments: [] })
    await done
    expect((processes[0] as FakeAcp).method('session/new')).toHaveLength(1)
    expect(remembered).toEqual(['session-1'])
    expect(events.find((e) => e.type === 'message.delta')).toMatchObject({ text: expect.stringContaining('no longer had this conversation') })
    await session.close()
  })

  it('does not hide a load that failed for another reason', async () => {
    const { session, processes } = sessionWith({ vendorSessionId: 'old-session', answers: { 'session/load': () => Promise.reject(new Error('The program ran out of memory')) } })
    const events: AgentEvent[] = []
    const done = collect(session, ['turn.failed'], events)
    session.send({ text: 'hello', attachments: [] })
    await done
    expect((processes[0] as FakeAcp).method('session/new')).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed' })
    await session.close()
  })

  it('fails the turn, with the program’s last words, when it stops in the middle, and starts it again for the next message', async () => {
    const { session, processes } = sessionWith()
    const events: AgentEvent[] = []
    const done = collect(session, ['turn.failed'], events)
    session.send({ text: 'one', attachments: [] })
    await tick()
    ;(processes[0] as FakeAcp).kill()
    await done
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', error: { retryable: true } })
    session.send({ text: 'two', attachments: [] })
    await tick()
    expect(processes).toHaveLength(2)
    await session.close()
  })
})
