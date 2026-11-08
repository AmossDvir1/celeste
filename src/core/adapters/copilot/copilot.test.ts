import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ResumeSessionConfig, SessionConfig, SessionEvent } from '@github/copilot-sdk'
import type { AgentEvent, ApprovalAnswer, ApprovalMode, Effort } from '@shared/agent'
import { describe, expect, it } from 'vitest'
import type { AdapterContext } from '../types'
import { displayPath, parseUnifiedDiff } from './diff'
import { CopilotHost, toModels, type SdkClientHandle } from './host'
import { decide, describe as describeRequest, DEVICE_SERVER, type PermissionLike } from './permissions'
import { CopilotAgentSession, RESUME_NOTICE, type SdkClient, type SdkSession } from './session'
import { Translator, errorFrom } from './translate'

/*
 * The fixtures are real turns recorded from the Copilot runtime (scripts/record/copilot-record.mjs) on a
 * small folder, with paths made anonymous. The adapter is tested against them and against a fake session
 * that plays them back, blocking on permission and question callbacks the way the real runtime does.
 */

interface Fixture {
  model: string
  prompt: string
  events: SessionEvent[]
  inputs: { question: string; choices?: string[] }[]
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8')) as Fixture

const CWD = 'C:\\work\\demo'
const TERMINAL = ['turn.completed', 'turn.interrupted', 'turn.failed']

function translate(events: SessionEvent[], cwd = CWD): AgentEvent[] {
  const t = new Translator(cwd)
  return [t.begin('turn-1'), ...events.flatMap((e) => t.handle(e))]
}
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')
const types = (events: AgentEvent[]) => events.map((e) => e.type)
const ev = (type: string, data: Record<string, unknown>) => ({ type, data, id: 'x', timestamp: '' }) as unknown as SessionEvent

describe('translating a recorded turn', () => {
  const events = translate(fixture('basic').events)

  it('starts a turn, ends it once, and puts nothing after the end', () => {
    expect(events[0]).toEqual({ type: 'turn.started', turnId: 'turn-1' })
    expect(events.filter((e) => TERMINAL.includes(e.type))).toEqual([{ type: 'turn.completed', turnId: 'turn-1' }])
    expect(TERMINAL).toContain(events[events.length - 1]?.type)
  })

  it('streams the answer and the reasoning', () => {
    expect(text(events)).toContain('notes.txt says')
    expect(events.some((e) => e.type === 'thinking.delta' && e.text.length > 0)).toBe(true)
    expect(types(events).indexOf('thinking.delta')).toBeLessThan(types(events).indexOf('message.delta'))
  })

  it('shows a command with its description as the title and the command itself as input', () => {
    const started = events.find((e) => e.type === 'tool.started' && e.kind === 'shell')
    expect(started).toMatchObject({ title: 'List files in current folder', input: 'Get-ChildItem' })
  })

  it('shows a read with a path relative to the folder, and does not repeat the file as output', () => {
    const read = events.find((e) => e.type === 'tool.started' && e.kind === 'read')
    expect(read).toMatchObject({ title: 'Read notes.txt', input: 'notes.txt' })
    const id = (read as { id: string }).id
    expect(events.find((e) => e.type === 'tool.completed' && e.id === id)).toEqual({ type: 'tool.completed', id, ok: true })
  })

  it('streams command output with plain line endings', () => {
    const output = events.filter((e) => e.type === 'tool.output').map((e) => (e as { text: string }).text).join('')
    expect(output).toContain('notes.txt')
    expect(output).not.toContain('\r')
  })

  it('finishes every tool it started, and no other', () => {
    const started = events.flatMap((e) => (e.type === 'tool.started' ? [e.id] : []))
    const done = events.flatMap((e) => (e.type === 'tool.completed' ? [e.id] : []))
    expect(done.sort()).toEqual(started.sort())
    expect(started).toHaveLength(2)
  })

  it('reports token use', () => {
    expect(events.filter((e) => e.type === 'usage.updated')).toHaveLength(2)
  })
})

describe('translating edits', () => {
  const events = translate(fixture('edit').events)

  it('shows what a created file holds, with its path relative to the folder', () => {
    const done = events.find((e) => e.type === 'tool.completed' && e.diff?.some((d) => d.path === 'hello.txt'))
    expect(done).toBeDefined()
    const diff = (done as { diff: { status: string; added: number; removed: number; hunks: { lines: { type: string; text: string }[] }[] }[] }).diff[0]
    expect(diff).toMatchObject({ status: 'added', added: 1, removed: 0 })
    expect(diff?.hunks[0]?.lines).toEqual([{ type: 'add', text: 'hi there', newNo: 1 }])
  })

  it('shows an edit as removed and added lines', () => {
    const done = events.find((e) => e.type === 'tool.completed' && e.diff?.some((d) => d.path === 'notes.txt'))
    const diff = (done as { diff: { status: string; added: number; removed: number; hunks: { lines: { type: string; text: string }[] }[] }[] }).diff[0]
    expect(diff).toMatchObject({ status: 'modified', added: 1, removed: 1 })
    const lines = diff?.hunks[0]?.lines.map((l) => `${l.type}:${l.text}`)
    expect(lines).toContain('del:hello from celeste')
    expect(lines).toContain('add:bye from celeste')
  })

  it('titles creating and editing', () => {
    const titles = events.flatMap((e) => (e.type === 'tool.started' ? [e.title] : []))
    expect(titles).toContain('Create hello.txt')
    expect(titles).toContain('Edit notes.txt')
  })
})

describe('translating other turns', () => {
  it('does not show ask_user as a tool: the question card is its place', () => {
    const events = translate(fixture('ask').events)
    expect(events.filter((e) => e.type === 'tool.started')).toEqual([])
    expect(events.filter((e) => e.type === 'tool.completed')).toEqual([])
  })

  it('says a file was changed when it has no diff to show', () => {
    const events = translate([
      ev('tool.execution_start', { toolCallId: 't1', toolName: 'edit', arguments: { path: 'C:\\work\\demo\\a.ts' } }),
      ev('tool.execution_complete', { toolCallId: 't1', success: true, fileEdits: [{ path: 'C:\\work\\demo\\a.ts', kind: 'edit' }], result: { content: 'ok' } })
    ])
    expect(events[2]).toMatchObject({ type: 'tool.completed', ok: true, diff: [{ path: 'a.ts', status: 'modified', hunks: [] }] })
  })

  it('reports a failed tool with its message', () => {
    const events = translate([
      ev('tool.execution_start', { toolCallId: 't1', toolName: 'mystery', arguments: {} }),
      ev('tool.execution_complete', { toolCallId: 't1', success: false, error: { message: 'It broke' } })
    ])
    expect(events[1]).toMatchObject({ type: 'tool.started', kind: 'other' })
    expect(events[2]).toEqual({ type: 'tool.completed', id: 't1', ok: false, result: 'It broke' })
  })

  it('cuts a very long result', () => {
    const events = translate([
      ev('tool.execution_start', { toolCallId: 't1', toolName: 'web_fetch', arguments: { url: 'https://example.com' } }),
      ev('tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'x'.repeat(10_000) } })
    ])
    const done = events[2] as { result: string }
    expect(done.result.length).toBeLessThan(4100)
    expect(done.result.endsWith('(cut)')).toBe(true)
  })

  it('shows a tool from an MCP server by its server and tool name', () => {
    const events = translate([ev('tool.execution_start', { toolCallId: 't1', toolName: 'devices_list', mcpServerName: DEVICE_SERVER, mcpServerDisplayName: 'Celeste devices', mcpToolName: 'devices_list', arguments: {} })])
    expect(events[1]).toMatchObject({ type: 'tool.started', kind: 'mcp', title: 'Celeste devices: devices_list' })
  })

  it('ends a stopped turn as interrupted', () => {
    const events = translate([ev('abort', { reason: 'user_initiated' }), ev('session.idle', { aborted: true })])
    expect(types(events)).toEqual(['turn.started', 'turn.interrupted'])
  })

  it('ends a failed turn once even though an idle follows', () => {
    const events = translate([ev('session.error', { errorType: 'rate_limit', statusCode: 429, message: 'Slow down' }), ev('session.idle', {})])
    expect(events).toEqual([
      { type: 'turn.started', turnId: 'turn-1' },
      { type: 'turn.failed', turnId: 'turn-1', error: { code: 'rate_limit', message: 'Slow down', retryable: true } }
    ])
  })

  it('shows a whole message when the runtime did not stream it, and not twice when it did', () => {
    const whole = translate([ev('assistant.message', { messageId: 'm', content: 'All at once.' })])
    expect(text(whole)).toBe('All at once.')
    const streamed = translate([ev('assistant.message_delta', { messageId: 'm', deltaContent: 'Hel' }), ev('assistant.message_delta', { messageId: 'm', deltaContent: 'lo' }), ev('assistant.message', { messageId: 'm', content: 'Hello' })])
    expect(text(streamed)).toBe('Hello')
  })

  it('leaves out what a helper agent says on its own', () => {
    const events = translate([ev('assistant.message_delta', { messageId: 'm', deltaContent: 'inner', parentToolCallId: 'task-1' })])
    expect(text(events)).toBe('')
  })

  it('maps errors to what the screen knows', () => {
    expect(errorFrom({ errorType: 'authentication', statusCode: 401, message: 'no' }).code).toBe('auth')
    expect(errorFrom({ errorType: 'x', statusCode: 429, message: 'no' })).toMatchObject({ code: 'rate_limit', retryable: true })
    expect(errorFrom({ errorType: 'x', message: 'read ECONNRESET' })).toMatchObject({ code: 'network', retryable: true })
    expect(errorFrom({ errorType: 'x', message: 'odd' })).toMatchObject({ code: 'unknown', retryable: false })
  })
})

describe('diffs and paths', () => {
  it('shows paths inside the folder relative to it, case-insensitively on Windows', () => {
    expect(displayPath('C:\\work\\demo\\src\\a.ts', 'c:\\work\\demo')).toBe('src/a.ts')
    expect(displayPath('C:\\work\\demonstration\\a.ts', 'C:\\work\\demo')).toBe('C:/work/demonstration/a.ts')
    expect(displayPath('/home/me/app/x.ts', '/home/me/app')).toBe('x.ts')
    expect(displayPath('/home/me/APP/x.ts', '/home/me/app')).toBe('/home/me/APP/x.ts')
    expect(displayPath('/etc/hosts')).toBe('/etc/hosts')
  })

  it('numbers the lines of a hunk from its header', () => {
    const diff = parseUnifiedDiff('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail\n', 'f')
    expect(diff.hunks[0]?.lines).toEqual([
      { type: 'ctx', text: 'keep', oldNo: 10, newNo: 10 },
      { type: 'del', text: 'old', oldNo: 11 },
      { type: 'add', text: 'new', newNo: 11 },
      { type: 'ctx', text: 'tail', oldNo: 12, newNo: 12 }
    ])
    expect(diff).toMatchObject({ status: 'modified', added: 1, removed: 1 })
  })

  it('knows a deleted file', () => {
    expect(parseUnifiedDiff('diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n', 'f').status).toBe('deleted')
  })
})

describe('what asks for approval in each mode', () => {
  const read: PermissionLike = { kind: 'read', path: '/a' }
  const write: PermissionLike = { kind: 'write', fileName: '/a' }
  const shell: PermissionLike = { kind: 'shell', fullCommandText: 'rm -rf x' }
  const web: PermissionLike = { kind: 'url', url: 'https://x.test' }
  const other: PermissionLike = { kind: 'mcp', serverName: 'github', toolName: 'create_issue', readOnly: false }
  const device: PermissionLike = { kind: 'mcp', serverName: DEVICE_SERVER, toolName: 'device_run', readOnly: false }
  const table: Record<ApprovalMode, [PermissionLike, string][]> = {
    auto: [[read, 'allow'], [write, 'allow'], [shell, 'allow'], [web, 'allow'], [other, 'allow'], [device, 'allow']],
    edits: [[read, 'allow'], [write, 'allow'], [shell, 'ask'], [web, 'ask'], [other, 'ask'], [device, 'allow']],
    ask: [[read, 'allow'], [write, 'ask'], [shell, 'ask'], [web, 'ask'], [other, 'ask'], [device, 'allow']],
    plan: [[read, 'allow'], [write, 'deny'], [shell, 'deny'], [web, 'deny'], [other, 'deny'], [device, 'deny']]
  }
  for (const [mode, rows] of Object.entries(table) as [ApprovalMode, [PermissionLike, string][]][]) {
    it(`${mode}`, () => {
      expect(rows.map(([r]) => decide(r, mode))).toEqual(rows.map(([, d]) => d))
    })
  }

  it('lets plan mode use a tool that only reads', () => {
    expect(decide({ kind: 'mcp', serverName: DEVICE_SERVER, toolName: 'device_read_file', readOnly: true }, 'plan')).toBe('allow')
  })

  it('words the card by what is asked', () => {
    expect(describeRequest({ kind: 'shell', intention: 'Delete the build', fullCommandText: 'rm -rf dist' })).toEqual({ kind: 'shell', title: 'Delete the build', detail: 'rm -rf dist' })
    expect(describeRequest({ kind: 'write', intention: 'Edit file', fileName: 'C:\\work\\demo\\a.ts' }, CWD)).toEqual({ kind: 'edit', title: 'Edit file', detail: 'a.ts' })
    expect(describeRequest({ kind: 'url', url: 'https://x.test' })).toMatchObject({ kind: 'web', detail: 'https://x.test' })
    expect(describeRequest({ kind: 'mcp', serverName: 's', toolName: 't', toolTitle: 'Make issue', args: { a: 1 } })).toMatchObject({ kind: 'mcp', title: 'Make issue' })
    expect(describeRequest({ kind: 'weird' })).toMatchObject({ kind: 'other' })
  })
})

// --- the session, against a fake runtime ---------------------------------------------------------------

type Handler = (e: SessionEvent) => void

class FakeSession implements SdkSession {
  readonly handlers = new Set<Handler>()
  readonly sent: { prompt: string; attachments?: { type: 'file'; path: string; displayName?: string }[] }[] = []
  readonly permissionResults: unknown[] = []
  readonly inputResults: unknown[] = []
  readonly models: { model: string; effort?: string }[] = []
  aborted = 0
  disconnected = false
  /** When set, the script waits here instead of ending, until aborted. */
  hang = false

  constructor(
    readonly sessionId: string,
    private readonly script: SessionEvent[],
    private readonly config: SessionConfig
  ) {}

  on(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  private emit(e: SessionEvent) {
    for (const h of [...this.handlers]) h(e)
  }
  async send(options: { prompt: string; attachments?: { type: 'file'; path: string; displayName?: string }[] }): Promise<string> {
    this.sent.push(options)
    void this.play()
    return 'message-1'
  }
  private async play(): Promise<void> {
    for (const e of this.script) {
      await new Promise((r) => setImmediate(r))
      if (this.aborted) return
      this.emit(e)
      const data = e.data as Record<string, unknown>
      if (e.type === 'permission.requested' && this.config.onPermissionRequest) {
        const result = await this.config.onPermissionRequest(data.permissionRequest as never, { sessionId: this.sessionId })
        this.permissionResults.push(result)
      }
      if (e.type === 'user_input.requested' && this.config.onUserInputRequest) {
        this.inputResults.push(await this.config.onUserInputRequest({ question: data.question as string, choices: data.choices as string[] }, { sessionId: this.sessionId }))
      }
    }
    if (this.hang) await new Promise<void>((r) => setInterval(() => this.aborted && r(), 5))
  }
  async abort(): Promise<void> {
    this.aborted++
    this.emit(ev('abort', { reason: 'user_initiated' }))
    this.emit(ev('session.idle', { aborted: true }))
  }
  async setModel(model: string, options?: { reasoningEffort?: string }): Promise<void> {
    this.models.push({ model, ...(options?.reasoningEffort ? { effort: options.reasoningEffort } : {}) })
  }
  async disconnect(): Promise<void> {
    this.disconnected = true
  }
}

class FakeSdk implements SdkClient {
  created: { config: SessionConfig; session: FakeSession }[] = []
  resumed: { id: string; config: ResumeSessionConfig }[] = []
  resumeFails = false
  constructor(public script: SessionEvent[]) {}
  async createSession(config: SessionConfig): Promise<SdkSession> {
    const session = new FakeSession(`copilot-${this.created.length + 1}`, this.script, config)
    this.created.push({ config, session })
    return session
  }
  async resumeSession(id: string, config: ResumeSessionConfig): Promise<SdkSession> {
    this.resumed.push({ id, config })
    if (this.resumeFails) throw new Error('Session not found')
    const session = new FakeSession(id, this.script, config as SessionConfig)
    this.created.push({ config: config as SessionConfig, session })
    return session
  }
}

interface Setup {
  session: CopilotAgentSession
  sdk: FakeSdk
  ctx: AdapterContext
  remembered: string[]
  set: (patch: Partial<ReturnType<AdapterContext['options']>>) => void
}

function setup(script: SessionEvent[], over: { approval?: ApprovalMode; vendorSessionId?: string; transcript?: string; client?: () => Promise<SdkClient>; devices?: boolean } = {}): Setup {
  const sdk = new FakeSdk(script)
  const remembered: string[] = []
  const options: ReturnType<AdapterContext['options']> = { model: 'claude-haiku-4.5', effort: null, approval: over.approval ?? 'auto', cwd: CWD }
  const ctx: AdapterContext = {
    sessionId: 's-1',
    vendor: 'copilot',
    mode: 'develop',
    options: () => ({ ...options }),
    getApproval: () => options.approval,
    ...(over.vendorSessionId ? { vendorSessionId: over.vendorSessionId } : {}),
    remember: (id) => remembered.push(id),
    transcript: () => over.transcript ?? '',
    attachmentPath: (id) => (id === 'att-1' ? 'D:\\attachments\\att-1.png' : undefined),
  }
  const session = new CopilotAgentSession({
    ctx,
    client: over.client ?? (async () => sdk),
    resolveModel: async (model, effort) => ({ model, ...(effort ? { effort } : {}) }),
    ...(over.devices === false ? {} : { deviceServer: () => ({ url: 'http://127.0.0.1:5555/mcp', token: 'tok' }) })
  })
  return { session, sdk, ctx, remembered, set: (patch) => Object.assign(options, patch) }
}

/** Sends a message and collects events up to the end of the turn, answering cards as the test says. */
async function run(session: CopilotAgentSession, message: string, react: (e: AgentEvent) => void = () => undefined, attachments: { id: string; name: string }[] = []): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  const it = session.events[Symbol.asyncIterator]()
  session.send({ text: message, attachments: attachments.map((a) => ({ ...a, mime: 'image/png', size: 1 })) })
  for (;;) {
    const r = await Promise.race([it.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out. Got: ${types(out).join(', ')}`)), 4000))])
    if (r.done) break
    out.push(r.value)
    react(r.value)
    if (TERMINAL.includes(r.value.type)) break
  }
  return out
}

describe('a Copilot session', () => {
  it('starts Copilot with the session settings, streams, and remembers the id', async () => {
    const t = setup(fixture('basic').events)
    const events = await run(t.session, 'List and read')
    expect(types(events)[0]).toBe('turn.started')
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed' })
    expect(t.sdk.created).toHaveLength(1)
    const { config, session } = t.sdk.created[0] as { config: SessionConfig; session: FakeSession }
    expect(config).toMatchObject({ model: 'claude-haiku-4.5', workingDirectory: CWD, streaming: true })
    expect(t.remembered).toEqual(['copilot-1'])
    expect(session.sent[0]?.prompt).toBe('List and read')
  })

  it('connects the agent to Celeste\'s device tools with this session\'s token', async () => {
    const t = setup(fixture('basic').events)
    await run(t.session, 'hi')
    expect(t.sdk.created[0]?.config.mcpServers).toEqual({
      [DEVICE_SERVER]: { type: 'http', url: 'http://127.0.0.1:5555/mcp', headers: { Authorization: 'Bearer tok' }, tools: ['*'] }
    })
  })

  it('leaves the device tools out when there is no tool server', async () => {
    const t = setup(fixture('basic').events, { devices: false })
    await run(t.session, 'hi')
    expect(t.sdk.created[0]?.config.mcpServers).toBeUndefined()
  })

  it('keeps one Copilot session across messages, and applies a changed model and effort to the next one', async () => {
    const t = setup(fixture('basic').events)
    await run(t.session, 'one')
    t.set({ model: 'gpt-6-sol', effort: 'high' as Effort })
    await run(t.session, 'two')
    expect(t.sdk.created).toHaveLength(1)
    const fake = t.sdk.created[0]?.session as FakeSession
    expect(fake.models).toEqual([{ model: 'gpt-6-sol', effort: 'high' }])
    expect(fake.sent.map((s) => s.prompt)).toEqual(['one', 'two'])
  })

  it('sends attachments by path', async () => {
    const t = setup(fixture('basic').events)
    await run(t.session, 'look', undefined, [{ id: 'att-1', name: 'shot.png' }])
    expect((t.sdk.created[0]?.session as FakeSession).sent[0]?.attachments).toEqual([{ type: 'file', path: 'D:\\attachments\\att-1.png', displayName: 'shot.png' }])
  })

  it('resumes the conversation it had, without seeding it', async () => {
    const t = setup(fixture('basic').events, { vendorSessionId: 'copilot-old', transcript: 'User: before\n\nAssistant: ok\n\nUser: next' })
    const events = await run(t.session, 'next')
    expect(t.sdk.resumed.map((r) => r.id)).toEqual(['copilot-old'])
    expect((t.sdk.created[0]?.session as FakeSession).sent[0]?.prompt).toBe('next')
    expect(text(events)).not.toContain(RESUME_NOTICE.trim())
  })

  it('starts a new conversation from the history, and says so, when the old one is gone', async () => {
    const t = setup(fixture('basic').events, { vendorSessionId: 'copilot-old', transcript: 'User: before\n\nAssistant: ok\n\nUser: next' })
    t.sdk.resumeFails = true
    const events = await run(t.session, 'next')
    expect(text(events).startsWith(RESUME_NOTICE)).toBe(true)
    const prompt = (t.sdk.created[0]?.session as FakeSession).sent[0]?.prompt ?? ''
    expect(prompt).toContain('User: before')
    expect(prompt).toContain('Assistant: ok')
    expect(prompt.endsWith('next')).toBe(true)
    expect(prompt.match(/User: next/g)).toBeNull()
    expect(t.remembered).toEqual(['copilot-1'])
  })

  it('seeds a first run that has history but no Copilot conversation, without saying anything', async () => {
    const t = setup(fixture('basic').events, { transcript: 'User: old question\n\nAssistant: old answer\n\nUser: new' })
    const events = await run(t.session, 'new')
    expect((t.sdk.created[0]?.session as FakeSession).sent[0]?.prompt).toContain('old question')
    expect(text(events)).not.toContain(RESUME_NOTICE.trim())
  })

  it('fails the turn with a readable message when Copilot cannot be reached', async () => {
    const t = setup([], { client: async () => Promise.reject(new Error('You are not signed in to GitHub Copilot. Open Settings and choose Connect.')) })
    const events = await run(t.session, 'hi')
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.failed', error: { code: 'auth', retryable: false } })
  })

  it('can send again after a failure', async () => {
    let signedIn = false
    const t = setup(fixture('basic').events, {
      client: async () => (signedIn ? t.sdk : Promise.reject(new Error('You are not signed in')))
    })
    expect((await run(t.session, 'one')).pop()).toMatchObject({ type: 'turn.failed' })
    signedIn = true
    expect((await run(t.session, 'two')).pop()).toMatchObject({ type: 'turn.completed' })
  })

  it('ends the stream when closed, and lets the Copilot session go', async () => {
    const t = setup(fixture('basic').events)
    await run(t.session, 'hi')
    await t.session.close()
    const fake = t.sdk.created[0]?.session as FakeSession
    expect(fake.disconnected).toBe(true)
    expect((await t.session.events[Symbol.asyncIterator]().next()).done).toBe(true)
  })
})

describe('approvals', () => {
  const edit = () => fixture('edit').events

  it('asks before a change in ask mode, and goes ahead when allowed', async () => {
    const t = setup(edit(), { approval: 'ask' })
    const cards: AgentEvent[] = []
    const events = await run(t.session, 'edit', (e) => {
      if (e.type === 'approval.requested') {
        cards.push(e)
        t.session.respond(e.requestId, { allow: true } as ApprovalAnswer)
      }
    })
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({ kind: 'edit', title: 'Create file', detail: 'hello.txt' })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed' })
    expect((t.sdk.created[0]?.session as FakeSession).permissionResults).toEqual([{ kind: 'approve-once' }, { kind: 'approve-once' }, { kind: 'approve-once' }])
  })

  it('tells the agent no, with a reason, when denied', async () => {
    const t = setup(edit(), { approval: 'ask' })
    await run(t.session, 'edit', (e) => {
      if (e.type === 'approval.requested') t.session.respond(e.requestId, { allow: false })
    })
    const results = (t.sdk.created[0]?.session as FakeSession).permissionResults as { kind: string; feedback?: string }[]
    expect(results.filter((r) => r.kind === 'reject')).toHaveLength(2)
    expect(results.find((r) => r.kind === 'reject')?.feedback).toMatch(/denied/i)
  })

  it('does not ask for a read in ask mode', async () => {
    const t = setup(fixture('basic').events, { approval: 'ask' })
    const cards: AgentEvent[] = []
    await run(t.session, 'read', (e) => e.type === 'approval.requested' && cards.push(e))
    expect(cards).toEqual([])
  })

  it('does not ask in auto mode', async () => {
    const t = setup(edit(), { approval: 'auto' })
    const cards: AgentEvent[] = []
    await run(t.session, 'edit', (e) => e.type === 'approval.requested' && cards.push(e))
    expect(cards).toEqual([])
  })

  it('refuses changes in plan mode without a card, and says why', async () => {
    const t = setup(edit(), { approval: 'plan' })
    const cards: AgentEvent[] = []
    await run(t.session, 'edit', (e) => e.type === 'approval.requested' && cards.push(e))
    expect(cards).toEqual([])
    const results = (t.sdk.created[0]?.session as FakeSession).permissionResults as { kind: string; feedback?: string }[]
    expect(results.filter((r) => r.kind === 'reject').every((r) => /plan mode/i.test(r.feedback ?? ''))).toBe(true)
  })

  it('reads the mode again for each request, so a change in the window applies at once', async () => {
    const t = setup(edit(), { approval: 'ask' })
    let answered = 0
    await run(t.session, 'edit', (e) => {
      if (e.type === 'approval.requested') {
        answered++
        t.set({ approval: 'auto' })
        t.session.respond(e.requestId, { allow: true })
      }
    })
    expect(answered).toBe(1)
  })

  it('lets a command on a device through, because Celeste asks for it itself', async () => {
    const script = [
      ev('tool.execution_start', { toolCallId: 'c1', toolName: 'device_run', mcpServerName: DEVICE_SERVER, mcpToolName: 'device_run', arguments: { command: 'uptime' } }),
      ev('permission.requested', { requestId: 'p1', permissionRequest: { kind: 'mcp', serverName: DEVICE_SERVER, toolName: 'device_run', toolTitle: 'Run a command', readOnly: false, toolCallId: 'c1' } }),
      ev('tool.execution_complete', { toolCallId: 'c1', success: true, result: { content: 'up 3 days' } }),
      ev('session.idle', {})
    ]
    const t = setup(script, { approval: 'ask' })
    const cards: AgentEvent[] = []
    const events = await run(t.session, 'uptime?', (e) => e.type === 'approval.requested' && cards.push(e))
    expect(cards).toEqual([])
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: true, result: 'up 3 days' })
  })
})

describe('questions from the agent', () => {
  it('shows the question with its choices and passes the answer back', async () => {
    const t = setup(fixture('ask').events)
    const events = await run(t.session, 'ask me', (e) => {
      if (e.type === 'ask_user.requested') t.session.respond(e.requestId, { 'Do you prefer red or blue?': ['Blue'] })
    })
    const ask = events.find((e) => e.type === 'ask_user.requested')
    expect(ask).toMatchObject({ questions: [{ question: 'Do you prefer red or blue?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] })
    expect((t.sdk.created[0]?.session as FakeSession).inputResults).toEqual([{ answer: 'Blue', wasFreeform: false }])
  })

  it('marks a typed answer as free-form', async () => {
    const t = setup(fixture('ask').events)
    await run(t.session, 'ask me', (e) => {
      if (e.type === 'ask_user.requested') t.session.respond(e.requestId, { 'Do you prefer red or blue?': 'green' })
    })
    expect((t.sdk.created[0]?.session as FakeSession).inputResults).toEqual([{ answer: 'green', wasFreeform: true }])
  })

  it('ignores an answer to a question nobody asked', () => {
    const t = setup([])
    expect(() => t.session.respond('nope', { allow: true })).not.toThrow()
  })
})

describe('stopping', () => {
  it('ends a running turn as interrupted and lets go of a card that was waiting', async () => {
    const t = setup(fixture('edit').events, { approval: 'ask' })
    let stopped = false
    const events = await run(t.session, 'edit', (e) => {
      if (e.type === 'approval.requested' && !stopped) {
        stopped = true
        void t.session.interrupt()
      }
    })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.interrupted' })
    expect((t.sdk.created[0]?.session as FakeSession).aborted).toBe(1)
    const results = (t.sdk.created[0]?.session as FakeSession).permissionResults as { kind: string }[]
    // The read before the edit was allowed; the edit that was waiting on the card was let go as a no.
    expect(results.map((r) => r.kind)).toEqual(['approve-once', 'reject'])
  })

  it('sends nothing when stopped while the session is still starting', async () => {
    let release: (c: SdkClient) => void = () => undefined
    const gate = new Promise<SdkClient>((resolve) => (release = resolve))
    const t = setup(fixture('basic').events, { client: () => gate })
    const out: AgentEvent[] = []
    const it = t.session.events[Symbol.asyncIterator]()
    t.session.send({ text: 'hi', attachments: [] })
    out.push((await it.next()).value as AgentEvent)
    await t.session.interrupt()
    out.push((await it.next()).value as AgentEvent)
    release(t.sdk)
    await new Promise((r) => setTimeout(r, 30))
    expect(types(out)).toEqual(['turn.started', 'turn.interrupted'])
    expect(t.sdk.created[0]?.session.sent ?? []).toEqual([])
  })
})

// --- the host ------------------------------------------------------------------------------------------

function fakeHandle(over: Partial<SdkClientHandle> & { authed?: boolean } = {}): SdkClientHandle & { starts: number; stops: number } {
  const state = { starts: 0, stops: 0 }
  const handle = {
    starts: 0,
    stops: 0,
    async start() {
      state.starts++
      handle.starts = state.starts
    },
    async stop() {
      state.stops++
      handle.stops = state.stops
      return []
    },
    async ping() {
      return {}
    },
    async getAuthStatus() {
      return over.authed === false ? { isAuthenticated: false, statusMessage: 'Not logged in' } : { isAuthenticated: true, login: 'octo' }
    },
    async listModels() {
      return [
        { id: 'auto', name: 'Auto', capabilities: { supports: {} } },
        { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', capabilities: { supports: { vision: true, reasoningEffort: true } }, supportedReasoningEfforts: ['none', 'low', 'high', 'ultra'], defaultReasoningEffort: 'high' },
        { id: 'old', name: 'Old', capabilities: { supports: { vision: false } }, policy: { state: 'disabled' } }
      ]
    },
    createSession: async () => Promise.reject(new Error('unused')),
    resumeSession: async () => Promise.reject(new Error('unused')),
    ...over
  } as unknown as SdkClientHandle & { starts: number; stops: number }
  return handle
}

describe('the Copilot host', () => {
  it('turns the runtime\'s models into Celeste\'s, with only the efforts Celeste knows, and leaves out disabled ones', () => {
    const models = toModels([
      { id: 'a', name: 'A', capabilities: { supports: { vision: true } }, supportedReasoningEfforts: ['none', 'low', 'max', 'ultra'], defaultReasoningEffort: 'low' },
      { id: 'b', name: 'B', policy: { state: 'disabled' } }
    ])
    expect(models).toEqual([{ id: 'a', vendor: 'copilot', label: 'A', efforts: ['low', 'max'], defaultEffort: 'low', images: true }])
  })

  it('reports signed in, with the account, and starts the runtime only when asked', async () => {
    const handle = fakeHandle()
    const host = new CopilotHost(() => handle)
    expect(handle.starts).toBe(0)
    expect(await host.status()).toEqual({ state: 'signed-in', account: 'octo' })
    expect(handle.starts).toBe(1)
  })

  it('reports signed out, and refuses sessions with a message about Connect', async () => {
    const host = new CopilotHost(() => fakeHandle({ authed: false }))
    expect(await host.status()).toMatchObject({ state: 'signed-out' })
    await expect(host.ready()).rejects.toThrow(/Connect/)
  })

  it('reports an unavailable runtime instead of throwing', async () => {
    const host = new CopilotHost(() => fakeHandle({ start: async () => Promise.reject(new Error('spawn ENOENT')) }))
    expect(await host.status()).toEqual({ state: 'unavailable', message: 'spawn ENOENT' })
    await expect(host.ready()).rejects.toThrow(/could not start: spawn ENOENT/)
  })

  it('starts once for two callers at the same time', async () => {
    const handle = fakeHandle()
    const host = new CopilotHost(() => handle)
    await Promise.all([host.status(), host.status(), host.models()])
    expect(handle.starts).toBe(1)
  })

  it('starts a new runtime when the old one stopped answering', async () => {
    const handles = [fakeHandle(), fakeHandle()]
    handles[0]!.ping = async () => Promise.reject(new Error('closed'))
    let n = 0
    const host = new CopilotHost(() => handles[n++]!)
    await host.status()
    await host.status()
    expect(handles.map((h) => h.starts)).toEqual([1, 1])
    expect(handles[0]?.stops).toBe(1)
  })

  it('picks the model asked for, with an effort it takes, and Auto for a name it does not know', async () => {
    const host = new CopilotHost(() => fakeHandle())
    expect(await host.resolve('claude-sonnet-5.5', 'high')).toEqual({ model: 'claude-sonnet-5.5', effort: 'high' })
    expect(await host.resolve('claude-sonnet-5.5', 'max')).toEqual({ model: 'claude-sonnet-5.5' })
    expect(await host.resolve('claude-sonnet-5.5', null)).toEqual({ model: 'claude-sonnet-5.5' })
    expect(await host.resolve('copilot-gpt', 'high')).toEqual({ model: 'auto' })
  })

  it('stops the runtime', async () => {
    const handle = fakeHandle()
    const host = new CopilotHost(() => handle)
    await host.status()
    await host.stop()
    expect(handle.stops).toBe(1)
  })
})
