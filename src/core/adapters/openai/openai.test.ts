import { describe, expect, it } from 'vitest'
import type { AgentEvent, ApprovalMode } from '@shared/agent'
import type { AdapterContext } from '../types'
import { ChatgptAuth } from './auth'
import { OpenAiHost, TOKEN_VAR, toModels, toml, type Launch } from './host'
import { DEVICE_SERVER, decide, mcpConfig, policyFor, questionsFrom } from './permissions'
import { CODEX_VERSION, codexPlatform, registryVersion } from './program'
import { RpcClient, type Transport } from '../rpc'
import { OpenAiAgentSession } from './session'
import { Translator, diffOf, errorFrom } from './translate'

describe('the translator', () => {
  const run = (notes: [string, Record<string, unknown>][], cwd?: string) => {
    const t = new Translator(cwd)
    const events: AgentEvent[] = [t.begin('turn-1')]
    for (const [method, params] of notes) events.push(...t.handle(method, params))
    return events
  }
  const completed = (status: string, extra: Record<string, unknown> = {}): [string, Record<string, unknown>] => ['turn/completed', { threadId: 't', turn: { id: 'c1', status, ...extra } }]

  it('streams a message and ends the turn, adding up the usage of each request', () => {
    const events = run([
      ['turn/started', { turn: { id: 'c1' } }],
      ['item/started', { item: { type: 'agentMessage', id: 'm1' }, turnId: 'c1' }],
      ['item/agentMessage/delta', { itemId: 'm1', delta: 'Hello ', turnId: 'c1' }],
      ['item/agentMessage/delta', { itemId: 'm1', delta: 'there', turnId: 'c1' }],
      ['item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Hello there' }, turnId: 'c1' }],
      ['thread/tokenUsage/updated', { turnId: 'c1', tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } }],
      ['thread/tokenUsage/updated', { turnId: 'c1', tokenUsage: { last: { inputTokens: 30, outputTokens: 5 } } }],
      completed('completed')
    ])
    expect(events.map((e) => e.type)).toEqual(['turn.started', 'message.delta', 'message.delta', 'usage.updated', 'turn.completed'])
    expect(events.filter((e) => e.type === 'message.delta').map((e) => (e as { text: string }).text).join('')).toBe('Hello there')
    expect(events.find((e) => e.type === 'usage.updated')).toMatchObject({ usage: { inputTokens: 40, outputTokens: 7 } })
  })

  it('says a message that was never streamed when it is completed, and keeps two messages apart', () => {
    const events = run([
      ['item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'First.' } }],
      ['item/started', { item: { type: 'agentMessage', id: 'm2' } }],
      ['item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'Second.' } }],
      completed('completed')
    ])
    expect(events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')).toBe('First.\n\nSecond.')
  })

  it('shows a command as a tool call with its output and exit', () => {
    const item = { type: 'commandExecution', id: 'c1', command: 'powershell -Command "ls"', status: 'inProgress' }
    const events = run([
      ['item/started', { item }],
      ['item/commandExecution/outputDelta', { itemId: 'c1', delta: 'file.txt\r\n' }],
      ['item/completed', { item: { ...item, status: 'completed', aggregatedOutput: 'file.txt\r\n', exitCode: 0 } }],
      completed('completed')
    ])
    expect(events[1]).toMatchObject({ type: 'tool.started', id: 'c1', kind: 'shell', title: 'powershell -Command "ls"' })
    expect(events[2]).toMatchObject({ type: 'tool.output', id: 'c1', text: 'file.txt\r\n' })
    expect(events[3]).toMatchObject({ type: 'tool.completed', id: 'c1', ok: true, result: 'file.txt\r\n' })
  })

  it('marks a command that failed or was declined as not ok', () => {
    const base = { type: 'commandExecution', id: 'c1', command: 'x' }
    const failed = run([['item/started', { item: base }], ['item/completed', { item: { ...base, status: 'completed', exitCode: 2, aggregatedOutput: 'boom' } }]])
    expect(failed.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: false, result: 'boom' })
    const declined = run([['item/started', { item: base }], ['item/completed', { item: { ...base, status: 'declined', exitCode: null, aggregatedOutput: null } }]])
    expect(declined.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: false, result: 'Declined.' })
  })

  it('shows file changes with a diff the diff view can draw', () => {
    const changes = [
      { path: 'D:\\p\\src\\a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n' },
      { path: 'D:\\p\\src\\b.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' }
    ]
    const events = run(
      [
        ['item/started', { item: { type: 'fileChange', id: 'f1', changes, status: 'inProgress' } }],
        ['item/completed', { item: { type: 'fileChange', id: 'f1', changes, status: 'completed' } }]
      ],
      'D:\\p'
    )
    expect(events[1]).toMatchObject({ type: 'tool.started', kind: 'edit', title: 'Edit 2 files' })
    const done = events[2] as Extract<AgentEvent, { type: 'tool.completed' }>
    expect(done.diff?.map((d) => [d.path, d.status, d.added, d.removed])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['src/b.ts', 'added', 2, 0]
    ])
  })

  it('shows a single new file as a write, and a deleted one with its lines removed', () => {
    const add = run([['item/started', { item: { type: 'fileChange', id: 'f', changes: [{ path: 'n.md', kind: { type: 'add' }, diff: 'x' }] } }]])
    expect(add[1]).toMatchObject({ kind: 'write', title: 'Write n.md' })
    expect(diffOf({ path: 'gone.txt', kind: { type: 'delete' }, diff: 'a\nb\n' })).toMatchObject({ status: 'deleted', added: 0, removed: 2 })
  })

  it('shows tools of other servers, and web searches', () => {
    const events = run([
      ['item/started', { item: { type: 'mcpToolCall', id: 'm1', server: 'github', tool: 'list_issues', arguments: { repo: 'a/b' } } }],
      ['item/completed', { item: { type: 'mcpToolCall', id: 'm1', status: 'completed', result: { content: [{ type: 'text', text: '3 issues' }] }, error: null } }],
      ['item/started', { item: { type: 'webSearch', id: 'w1', query: 'celeste app' } }],
      ['item/completed', { item: { type: 'webSearch', id: 'w1' } }]
    ])
    expect(events[1]).toMatchObject({ kind: 'mcp', title: 'github: list_issues', input: { repo: 'a/b' } })
    expect(events[2]).toMatchObject({ ok: true, result: '3 issues' })
    expect(events[3]).toMatchObject({ kind: 'web', title: 'Search the web for celeste app' })
    expect(events[4]).toMatchObject({ type: 'tool.completed', ok: true })
  })

  it('shows reasoning as thinking, from the stream or, failing that, the finished item', () => {
    const streamed = run([['item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'Considering' }], ['item/completed', { item: { type: 'reasoning', id: 'r', summary: ['Considering'], content: [] } }]])
    expect(streamed.filter((e) => e.type === 'thinking.delta')).toHaveLength(1)
    const whole = run([['item/completed', { item: { type: 'reasoning', id: 'r2', summary: ['One'], content: ['Two'] } }]])
    expect(whole[1]).toMatchObject({ type: 'thinking.delta', text: 'One\n\nTwo' })
  })

  it('ends a stopped turn as interrupted, and a failed one with the reason', () => {
    expect(run([completed('interrupted')]).at(-1)).toMatchObject({ type: 'turn.interrupted' })
    const failed = run([completed('failed', { error: { message: 'Bad key', codexErrorInfo: 'unauthorized' } })]).at(-1) as Extract<AgentEvent, { type: 'turn.failed' }>
    expect(failed).toMatchObject({ type: 'turn.failed', error: { code: 'auth', message: 'Bad key', retryable: false } })
  })

  it('ignores an error Codex will retry, and uses the last one when the turn fails without saying why', () => {
    const events = run([
      ['error', { error: { message: 'stream dropped', codexErrorInfo: null }, willRetry: true }],
      ['error', { error: { message: 'Rate limit hit', codexErrorInfo: 'rateLimitExceeded' }, willRetry: false }],
      completed('failed')
    ])
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'rate_limit', retryable: true } })
  })

  it('does not take what belongs to another turn, such as the one that was stopped and is still winding down', () => {
    const t = new Translator()
    t.begin('turn-2')
    t.handle('turn/started', { turn: { id: 'new' } })
    expect(t.handle('item/agentMessage/delta', { itemId: 'm', delta: 'stale', turnId: 'old' })).toEqual([])
    expect(t.handle('turn/completed', { turn: { id: 'old', status: 'interrupted' } })).toEqual([])
    expect(t.running).toBe(true)
    expect(t.handle('turn/completed', { turn: { id: 'new', status: 'completed' } })).toMatchObject([{ type: 'turn.completed' }])
  })

  it('knows what a running item is, for the question that asks to allow it', () => {
    const t = new Translator()
    t.begin('x')
    t.handle('item/started', { item: { type: 'commandExecution', id: 'c', command: 'rm -rf build' } })
    expect(t.titleOf('c')).toBe('rm -rf build')
    expect(t.titleOf('nope')).toBeUndefined()
  })
})

describe('what Codex reports as errors', () => {
  it('words a usage limit on the plan plainly, and tells auth, rate, network and other failures apart', () => {
    expect(errorFrom(null, 'subscription_sharing_usage_limit_exceeded')).toMatchObject({ code: 'rate_limit', retryable: false })
    expect(errorFrom(null, 'subscription_sharing_usage_limit_exceeded').message).toMatch(/ChatGPT plan/)
    expect(errorFrom('unauthorized', 'nope').code).toBe('auth')
    expect(errorFrom(null, 'Incorrect API key provided').code).toBe('auth')
    expect(errorFrom('serverOverloaded', 'busy')).toMatchObject({ code: 'rate_limit', retryable: true })
    expect(errorFrom({ httpConnectionFailed: { httpStatusCode: null } }, 'x')).toMatchObject({ code: 'network', retryable: true })
    expect(errorFrom('contextWindowExceeded', 'too long')).toMatchObject({ code: 'unknown', retryable: false })
  })
})

describe('approval modes', () => {
  const modes: ApprovalMode[] = ['auto', 'edits', 'ask', 'plan']
  it('tell Codex to ask about everything but nothing in automatic mode, and to touch nothing in plan mode', () => {
    expect(policyFor('auto')).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
    expect(policyFor('ask').approvalPolicy).toBe('untrusted')
    expect(policyFor('edits').approvalPolicy).toBe('untrusted')
    expect(policyFor('plan')).toEqual({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
  })
  it('answer what Codex asks as the picker says they do', () => {
    expect(modes.map((m) => decide('command', m))).toEqual(['allow', 'ask', 'ask', 'deny'])
    expect(modes.map((m) => decide('files', m))).toEqual(['allow', 'allow', 'ask', 'deny'])
    expect(modes.map((m) => decide('tool', m))).toEqual(['allow', 'ask', 'ask', 'deny'])
    expect(modes.map((m) => decide('permissions', m))).toEqual(['allow', 'ask', 'ask', 'deny'])
  })
})

describe('the settings Codex is started with', () => {
  it('writes the person’s tools and the device server as TOML Codex accepts, and keeps the device server’s name for itself', () => {
    const config = mcpConfig(
      [
        { key: 'github', type: 'http', url: 'https://mcp.example/github', args: [], env: {}, headers: { Authorization: 'Bearer abc', 'X-Org': 'a"b' } },
        { key: 'files', type: 'stdio', command: 'C:\\tools\\mcp.exe', args: ['--root', 'D:\\p'], env: { TOKEN: 'x y' }, headers: {} },
        { key: DEVICE_SERVER, type: 'http', url: 'http://evil', args: [], env: {}, headers: {} },
        { key: 'my server', type: 'http', url: 'https://x', args: [], env: {}, headers: {} }
      ],
      { url: 'http://127.0.0.1:5000/mcp', token: 'tok-1' }
    )
    expect(config[0]).toBe('mcp_servers.celeste-devices.url="http://127.0.0.1:5000/mcp"')
    expect(config).toContain('mcp_servers.celeste-devices.http_headers={"Authorization"="Bearer tok-1"}')
    expect(config).toContain('mcp_servers.github.http_headers={"Authorization"="Bearer abc", "X-Org"="a\\"b"}')
    expect(config).toContain('mcp_servers.files.command="C:\\\\tools\\\\mcp.exe"')
    expect(config).toContain('mcp_servers.files.args=["--root", "D:\\\\p"]')
    expect(config).toContain('mcp_servers.files.env={"TOKEN"="x y"}')
    expect(config).toContain('mcp_servers."my server".url="https://x"')
    // Only one server answers to the device server's name, and it is Celeste's.
    expect(config.filter((c) => c.startsWith('mcp_servers.celeste-devices.url'))).toHaveLength(1)
    expect(config.filter((c) => c.endsWith('tool_timeout_sec=600'))).toHaveLength(4)
  })

  it('turns Codex’s questions into the question card and back', () => {
    const { questions, ids } = questionsFrom({
      questions: [
        { id: 'scope', header: 'Scope', question: 'Which folder?', isOther: true, isSecret: false, options: [{ label: 'src', description: 'the code' }, { label: 'docs', description: '' }] },
        { id: 'why', header: 'Why', question: 'Why?', options: null }
      ]
    })
    expect(ids).toEqual(['scope', 'why'])
    expect(questions[0]).toEqual({ header: 'Scope', question: 'Which folder?', multiSelect: false, options: [{ label: 'src', description: 'the code' }, { label: 'docs' }] })
    expect(questions[1]?.options).toEqual([])
  })

  it('quotes a string as TOML', () => {
    expect(toml('a "b" \\c')).toBe('"a \\"b\\" \\\\c"')
  })
})

describe('the program', () => {
  it('is one version of one package per platform', () => {
    expect(registryVersion('win32-x64')).toBe(`${CODEX_VERSION}-win32-x64`)
    expect(codexPlatform('win32', 'x64')).toBe('win32-x64')
    expect(codexPlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(codexPlatform('freebsd', 'x64')).toBeUndefined()
  })
})

describe('the models', () => {
  it('lists the ones that are shown, with the effort levels Celeste knows and whether they read images', () => {
    const models = toModels([
      { id: 'a', model: 'gpt-x', displayName: 'GPT-X', hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'ultra'].map((reasoningEffort) => ({ reasoningEffort })), inputModalities: ['text', 'image'] },
      { id: 'b', model: 'gpt-y', displayName: 'GPT-Y', hidden: false, supportedReasoningEfforts: [], inputModalities: ['text'] },
      { id: 'c', model: 'old', displayName: 'Old', hidden: true, supportedReasoningEfforts: [] }
    ])
    expect(models).toEqual([
      { id: 'openai:gpt-x', vendor: 'openai', label: 'GPT-X', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', images: true },
      { id: 'openai:gpt-y', vendor: 'openai', label: 'GPT-Y', efforts: [], images: false }
    ])
  })
})

// --- the host and the session, with a fake Codex ---------------------------------------------------------------

function fakeAuth(token = 'plan-token-1', record = false): ChatgptAuth & { token: string } {
  const a = {
    token,
    record: async () => (record ? ({ email: 'dana@example.com', access_token: token } as never) : undefined),
    accessToken: async () => a.token,
    remaining: async () => 3_000_000,
    refresh: async () => ({}) as never,
    signOut: async () => ({ revoked: true }),
    begin: async () => ({ url: 'https://auth.test/authorize', done: new Promise(() => undefined), cancel: () => undefined })
  }
  return a as unknown as ChatgptAuth & { token: string }
}

const hostWith = (over: Partial<ConstructorParameters<typeof OpenAiHost>[0]> = {}) =>
  new OpenAiHost({ program: () => 'C:\\programs\\codex.exe', auth: fakeAuth(), getKey: async () => null, codexHome: 'C:\\data\\codex-home', baseEnv: { PATH: 'p', OPENAI_API_KEY: 'sk-ambient', CODEX_API_KEY: 'sk-ambient-2' }, listModels: async () => [], ...over })

describe('the OpenAI host', () => {
  it('reports signed out, a key, a refused key and a missing program', async () => {
    expect(await hostWith().status()).toEqual({ state: 'signed-out' })
    expect(await hostWith({ getKey: async () => 'sk-abcdef1234' }).status()).toEqual({ state: 'signed-in', account: 'API key ending 1234' })
    expect(await hostWith({ getKey: async () => 'sk-abcdef1234', verifyKey: async () => 'rejected' }).status()).toEqual({ state: 'unavailable', message: 'OpenAI did not accept this API key.' })
    expect(await hostWith({ getKey: async () => 'sk-abcdef1234', verifyKey: async () => 'unknown' }).status()).toMatchObject({ state: 'signed-in' })
    expect(await hostWith({ program: () => undefined }).status()).toEqual({ state: 'runtime-missing' })
  })

  it('reports a ChatGPT sign-in by its account, and signed out once it has been ended', async () => {
    expect(await hostWith({ auth: fakeAuth('t', true) }).status()).toEqual({ state: 'signed-in', account: 'ChatGPT · dana@example.com' })
    const ended = fakeAuth('t', true)
    ended.remaining = async () => -1
    ended.refresh = async () => {
      const { AuthError } = await import('./auth')
      throw new AuthError('ended', true)
    }
    expect(await hostWith({ auth: ended }).status()).toEqual({ state: 'signed-out' })
  })

  it('starts Codex pointed at OpenAI’s Responses API with the credential in a variable, and no key from the person’s own environment', async () => {
    const launch = await hostWith({ getKey: async () => 'sk-pasted-9999' }).launch(['mcp_servers.x.url="http://x"'])
    expect(launch.via).toBe('key')
    expect(launch.file).toBe('C:\\programs\\codex.exe')
    expect(launch.args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://'])
    const settings = launch.args.filter((_, i) => launch.args[i - 1] === '-c')
    expect(settings).toContain('model_provider="celeste_openai"')
    expect(settings).toContain('model_providers.celeste_openai.base_url="https://api.openai.com/v1"')
    expect(settings).toContain(`model_providers.celeste_openai.env_key="${TOKEN_VAR}"`)
    expect(settings).toContain('model_providers.celeste_openai.wire_api="responses"')
    expect(settings).toContain('model_providers.celeste_openai.requires_openai_auth=false')
    expect(settings).toContain('model_providers.celeste_openai.supports_websockets=false')
    expect(settings).toContain('mcp_servers.x.url="http://x"')
    expect(launch.env[TOKEN_VAR]).toBe('sk-pasted-9999')
    expect(launch.env['CODEX_HOME']).toBe('C:\\data\\codex-home')
    expect(launch.env['OPENAI_API_KEY']).toBeUndefined()
    expect(launch.env['CODEX_API_KEY']).toBeUndefined()
    // A secret never goes on the command line, where other programs can read it.
    expect(JSON.stringify(launch.args)).not.toContain('sk-pasted-9999')
  })

  it('prefers the ChatGPT sign-in, and says to connect when there is neither', async () => {
    expect((await hostWith({ auth: fakeAuth('plan-abc', true), getKey: async () => 'sk-key' }).launch()).via).toBe('plan')
    await expect(hostWith().launch()).rejects.toThrow(/not signed in/)
    await expect(hostWith({ program: () => undefined, getKey: async () => 'k' }).launch()).rejects.toThrow(/not on this computer/)
  })

  it('picks the model and effort the session asks for, when the model takes it', async () => {
    const host = hostWith({
      getKey: async () => 'k',
      listModels: async () => [{ id: 'a', model: 'gpt-x', displayName: 'X', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }]
    })
    await host.models()
    expect(host.resolve('openai:gpt-x', 'high')).toEqual({ model: 'gpt-x', effort: 'high' })
    expect(host.resolve('openai:gpt-x', 'low')).toEqual({ model: 'gpt-x' })
    expect(host.resolve('openai:gpt-z', 'high')).toEqual({ model: 'gpt-z' })
  })
})

/** A Codex that follows a script: answers requests by method, and can send messages of its own. */
class FakeCodex implements Transport {
  readonly written: Record<string, unknown>[] = []
  private line: (l: string) => void = () => undefined
  private exit: (code: number | null) => void = () => undefined
  killed = false
  /** What to answer each method with. */
  answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    initialize: () => ({ userAgent: 'x', codexHome: 'h', platformFamily: 'windows', platformOs: 'windows' }),
    'thread/start': () => ({ thread: { id: 'thread-1' } }),
    'thread/resume': (p) => ({ thread: { id: p['threadId'] } }),
    'turn/start': () => ({ turn: { id: 'codex-turn-1' } })
  }
  write(line: string): void {
    const m = JSON.parse(line) as Record<string, unknown>
    this.written.push(m)
    if (typeof m['id'] === 'number' && typeof m['method'] === 'string') {
      const answer = this.answers[m['method']]
      queueMicrotask(() => {
        if (!answer) return this.line(JSON.stringify({ id: m['id'], error: { message: `no answer for ${m['method']}` } }))
        // An answer that rejects is an error reply, as Codex sends one.
        Promise.resolve()
          .then(() => answer((m['params'] ?? {}) as Record<string, unknown>))
          .then(
            (result) => this.line(JSON.stringify({ id: m['id'], result })),
            (err: unknown) => this.line(JSON.stringify({ id: m['id'], error: { message: err instanceof Error ? err.message : String(err) } }))
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
    this.line(JSON.stringify(message))
  }
  /** What the session wrote that answers one of Codex's own requests. */
  reply(id: number): Record<string, unknown> | undefined {
    return this.written.find((m) => m['id'] === id && m['method'] === undefined)
  }
  method(name: string): Record<string, unknown>[] {
    return this.written.filter((m) => m['method'] === name)
  }
}

function sessionWith(over: { approval?: ApprovalMode; token?: () => string; vendorSessionId?: string; answers?: FakeCodex['answers'] } = {}) {
  const processes: FakeCodex[] = []
  const remembered: string[] = []
  const options = { model: 'openai:gpt-x', effort: null as null, approval: over.approval ?? ('ask' as ApprovalMode), cwd: 'D:\\p' }
  const ctx: AdapterContext = {
    sessionId: 's',
    vendor: 'openai',
    mode: 'develop',
    options: () => ({ ...options }),
    getApproval: () => options.approval,
    ...(over.vendorSessionId ? { vendorSessionId: over.vendorSessionId } : {}),
    remember: (id) => remembered.push(id),
    transcript: () => '',
    attachmentPath: () => undefined
  }
  let launches = 0
  const session = new OpenAiAgentSession({
    ctx,
    launch: async () => ({ file: 'codex', args: [], env: { [TOKEN_VAR]: over.token?.() ?? 'tok-1' }, via: 'plan' }) satisfies Launch,
    connect: (_launch, handlers) => {
      launches++
      const p = new FakeCodex()
      Object.assign(p.answers, over.answers)
      processes.push(p)
      return new RpcClient(p, handlers)
    },
    resolveModel: (model) => ({ model: model.replace(/^openai:/, '') }),
    ...(over.token ? { currentToken: async () => (over.token as () => string)() } : {}),
    deviceServer: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'd' })
  })
  return { session, processes, remembered, options, launches: () => launches }
}

const collect = async (session: OpenAiAgentSession, until: string[], into: AgentEvent[] = []) => {
  const it = session.events[Symbol.asyncIterator]()
  for (;;) {
    const r = await it.next()
    if (r.done) break
    into.push(r.value)
    if (until.includes(r.value.type)) break
  }
  return into
}
const tick = () => new Promise((r) => setTimeout(r, 15))

describe('the session, with a fake Codex', () => {
  it('starts the program once, opens a thread with the session’s settings, and sends each message as a turn with them', async () => {
    const { session, processes, remembered, options } = sessionWith({ approval: 'ask' })
    session.send({ text: 'hi', attachments: [] })
    await tick()
    const codex = processes[0] as FakeCodex
    const thread = codex.method('thread/start')[0]?.['params'] as Record<string, unknown>
    expect(thread).toMatchObject({ cwd: 'D:\\p', model: 'gpt-x', approvalPolicy: 'untrusted', sandbox: 'danger-full-access', ephemeral: false })
    expect(codex.method('initialize')[0]?.['params']).toMatchObject({ clientInfo: { name: 'celeste', title: 'Celeste' } })
    expect(codex.method('initialized')).toHaveLength(1)
    expect(remembered).toEqual(['thread-1'])
    const turn = codex.method('turn/start')[0]?.['params'] as Record<string, unknown>
    expect(turn).toMatchObject({ threadId: 'thread-1', approvalPolicy: 'untrusted', sandboxPolicy: { type: 'dangerFullAccess' }, model: 'gpt-x' })
    expect((turn['input'] as { text: string }[])[0]?.text).toBe('hi')
    // A change in the window applies to the next message, on the same process.
    codex.say({ method: 'turn/completed', params: { turn: { id: 'codex-turn-1', status: 'completed' } } })
    await tick()
    options.approval = 'plan'
    session.send({ text: 'again', attachments: [] })
    await tick()
    expect(processes).toHaveLength(1)
    expect(codex.method('turn/start')[1]?.['params']).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    await session.close()
  })

  it('answers Codex’s approval request from the person’s answer, and releases it when the turn is stopped', async () => {
    const { session, processes } = sessionWith({ approval: 'ask' })
    const events: AgentEvent[] = []
    const done = collect(session, ['approval.requested'], events)
    session.send({ text: 'go', attachments: [] })
    await tick()
    const codex = processes[0] as FakeCodex
    codex.say({ method: 'turn/started', params: { turn: { id: 'codex-turn-1' } } })
    codex.say({ method: 'item/started', params: { turnId: 'codex-turn-1', item: { type: 'commandExecution', id: 'c1', command: 'npm test' } } })
    codex.say({ id: 90, method: 'item/commandExecution/requestApproval', params: { kind: 'command', itemId: 'c1', turnId: 'codex-turn-1', command: 'npm test', reason: 'Run the tests' } })
    await done
    const card = events.find((e) => e.type === 'approval.requested') as Extract<AgentEvent, { type: 'approval.requested' }>
    expect(card).toMatchObject({ kind: 'shell', title: 'Run the tests', detail: 'npm test' })
    session.respond(card.requestId, { allow: true, always: true })
    await tick()
    expect(codex.reply(90)).toEqual({ id: 90, result: { decision: 'acceptForSession' } })

    codex.say({ id: 91, method: 'item/commandExecution/requestApproval', params: { kind: 'command', itemId: 'c1', command: 'rm x' } })
    await tick()
    // Stopping the turn lets go of the question: Codex gets "decline", not silence.
    void session.interrupt()
    await tick()
    expect(codex.reply(91)).toEqual({ id: 91, result: { decision: 'decline' } })
    codex.say({ method: 'turn/completed', params: { turn: { id: 'codex-turn-1', status: 'interrupted' } } })
    await session.close()
  })

  it('answers without asking where the mode says so, and always lets the device server through', async () => {
    const { session, processes } = sessionWith({ approval: 'edits' })
    session.send({ text: 'go', attachments: [] })
    await tick()
    const codex = processes[0] as FakeCodex
    codex.say({ id: 1, method: 'item/fileChange/requestApproval', params: { itemId: 'f1' } })
    codex.say({ id: 2, method: 'mcpServer/elicitation/request', params: { serverName: 'celeste-devices', mode: 'form', message: 'Run?' } })
    codex.say({ id: 3, method: 'mcpServer/elicitation/request', params: { serverName: 'x', mode: 'url', message: 'Open', url: 'https://x' } })
    codex.say({ id: 4, method: 'item/tool/call', params: {} })
    await tick()
    expect(codex.reply(1)).toEqual({ id: 1, result: { decision: 'accept' } })
    expect(codex.reply(2)).toEqual({ id: 2, result: { action: 'accept', content: null, _meta: null } })
    expect(codex.reply(3)).toEqual({ id: 3, result: { action: 'decline', content: null, _meta: null } })
    expect((codex.reply(4) as { error?: { message: string } }).error?.message).toMatch(/does not handle item\/tool\/call/)
    await session.close()
  })

  it('shows Codex’s questions as a card and sends the answers by their ids', async () => {
    const { session, processes } = sessionWith()
    const events: AgentEvent[] = []
    const done = collect(session, ['ask_user.requested'], events)
    session.send({ text: 'go', attachments: [] })
    await tick()
    const codex = processes[0] as FakeCodex
    codex.say({ id: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'scope', header: 'Scope', question: 'Which folder?', options: [{ label: 'src', description: '' }] }] } })
    await done
    const ask = events.find((e) => e.type === 'ask_user.requested') as Extract<AgentEvent, { type: 'ask_user.requested' }>
    expect(ask.questions[0]?.question).toBe('Which folder?')
    session.respond(ask.requestId, { 'Which folder?': 'src' })
    await tick()
    expect(codex.reply(7)).toEqual({ id: 7, result: { answers: { scope: { answers: ['src'] } } } })
    await session.close()
  })

  it('starts the program again, resuming the thread, when the sign-in was renewed since it started', async () => {
    let token = 'tok-1'
    const { session, processes, launches } = sessionWith({ token: () => token })
    session.send({ text: 'one', attachments: [] })
    await tick()
    const first = processes[0] as FakeCodex
    first.say({ method: 'turn/completed', params: { turn: { id: 'codex-turn-1', status: 'completed' } } })
    await tick()
    token = 'tok-2'
    session.send({ text: 'two', attachments: [] })
    await tick()
    expect(launches()).toBe(2)
    expect(first.killed).toBe(true)
    const second = processes[1] as FakeCodex
    expect(second.method('thread/resume')[0]?.['params']).toMatchObject({ threadId: 'thread-1' })
    expect(second.method('thread/start')).toHaveLength(0)
    await session.close()
  })

  it('fails the turn, with the program’s last words, when it stops in the middle, and starts it again for the next message', async () => {
    const { session, processes, launches } = sessionWith()
    const events: AgentEvent[] = []
    const done = collect(session, ['turn.failed'], events)
    session.send({ text: 'one', attachments: [] })
    await tick()
    ;(processes[0] as FakeCodex).kill()
    await done
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', error: { retryable: true } })
    session.send({ text: 'two', attachments: [] })
    await tick()
    expect(launches()).toBe(2)
    await session.close()
  })

  it('opens a new thread from the log, and says so, when the one it was asked to resume is gone', async () => {
    const { session, processes, remembered } = sessionWith({ vendorSessionId: 'old-thread', answers: { 'thread/resume': () => Promise.reject(new Error('no rollout found for thread id old-thread')) } })
    const events: AgentEvent[] = []
    const done = collect(session, ['message.delta'], events)
    session.send({ text: 'hello', attachments: [] })
    await done
    const codex = processes[0] as FakeCodex
    expect(codex.method('thread/resume')).toHaveLength(1)
    expect(codex.method('thread/start')).toHaveLength(1)
    expect(remembered).toEqual(['thread-1'])
    expect(session.vendorSessionId).toBe('thread-1')
    expect(events.find((e) => e.type === 'message.delta')).toMatchObject({ text: expect.stringContaining('no longer had this conversation') })
    await session.close()
  })

  it('does not hide a resume that failed for another reason', async () => {
    const { session, processes } = sessionWith({ vendorSessionId: 'old-thread', answers: { 'thread/resume': () => Promise.reject(new Error('The program is out of memory')) } })
    const events: AgentEvent[] = []
    const done = collect(session, ['turn.failed'], events)
    session.send({ text: 'hello', attachments: [] })
    await done
    expect((processes[0] as FakeCodex).method('thread/start')).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed' })
    await session.close()
  })
})
