import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Resvg } from '@resvg/resvg-js'
import type { AgentEvent, ApprovalMode } from '@shared/agent'
import type { AdapterContext } from '../types'
import { FakeAnthropic, type Script } from './fake-anthropic'
import { claudeProgram, createClaudeHost, createClaudeSession, createClaudeTitler } from './index'
import { RESUME_NOTICE, type ClaudeAgentSession } from './session'

/*
 * The adapter against the real SDK and the real Claude Code program, with a stand-in for Anthropic's API on this
 * computer (fake-anthropic.ts): no account, no cost. It proves the messages the real program sends are the ones the
 * translator reads, that the permission callback is called and obeyed, and that a conversation resumes. Skipped where
 * Claude Code's program is not installed beside the SDK.
 */

/** Windows keeps a folder while the program that had it open is still shutting down. Waits for it, and never fails a test over it. */
async function removeWhenFree(path: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

const program = claudeProgram(require.resolve.paths('@anthropic-ai/claude-agent-sdk') ?? [])
const TERMINAL = ['turn.completed', 'turn.failed', 'turn.interrupted']

describe.skipIf(!program)('the Claude adapter with the real Claude Code', () => {
  const api = new FakeAnthropic(() => [])
  let dir: string
  let config: string
  let savedBase: string | undefined

  beforeAll(async () => {
    await api.start()
    dir = mkdtempSync(join(tmpdir(), 'celeste-claude-work-'))
    config = mkdtempSync(join(tmpdir(), 'celeste-claude-config-'))
    savedBase = process.env['ANTHROPIC_BASE_URL']
    process.env['ANTHROPIC_BASE_URL'] = api.url
  }, 30_000)

  const open: ClaudeAgentSession[] = []

  afterAll(async () => {
    // A program that is still running holds its folder on Windows.
    await Promise.all(open.map((s) => s.close()))
    if (savedBase === undefined) delete process.env['ANTHROPIC_BASE_URL']
    else process.env['ANTHROPIC_BASE_URL'] = savedBase
    await api.stop()
    await removeWhenFree(dir)
    await removeWhenFree(config)
  })

  const host = () => createClaudeHost({ installedAt: require.resolve.paths('@anthropic-ai/claude-agent-sdk') ?? [], getKey: async () => 'sk-ant-api03-not-a-real-key', configDir: config })

  interface Made {
    session: ClaudeAgentSession
    remembered: string[]
    set: (patch: Partial<ReturnType<AdapterContext['options']>>) => void
  }
  const make = (over: { approval?: ApprovalMode; vendorSessionId?: string; transcript?: string; model?: string; attachmentPath?: (id: string) => string | undefined } = {}): Made => {
    const remembered: string[] = []
    const options: ReturnType<AdapterContext['options']> = { model: over.model ?? 'claude:haiku', effort: null, approval: over.approval ?? 'auto', cwd: dir }
    const ctx: AdapterContext = {
      sessionId: 's-1',
      vendor: 'claude',
      mode: 'develop',
      options: () => ({ ...options }),
      getApproval: () => options.approval,
      ...(over.vendorSessionId ? { vendorSessionId: over.vendorSessionId } : {}),
      remember: (id) => remembered.push(id),
      transcript: () => over.transcript ?? '',
      attachmentPath: over.attachmentPath ?? (() => undefined),
    }
    const session = createClaudeSession(host(), ctx)
    open.push(session)
    return { session, remembered, set: (patch) => Object.assign(options, patch) }
  }

  async function turn(
    session: ClaudeAgentSession,
    text: string,
    react: (e: AgentEvent) => void = () => undefined,
    attachments: { id: string; name: string; mime: string; size: number }[] = []
  ): Promise<AgentEvent[]> {
    const out: AgentEvent[] = []
    const it = session.events[Symbol.asyncIterator]()
    session.send({ text, attachments })
    for (;;) {
      const r = await Promise.race([it.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out. Got: ${out.map((e) => e.type).join(', ')}`)), 150_000))])
      if (r.done) break
      out.push(r.value)
      react(r.value)
      if (TERMINAL.includes(r.value.type)) break
    }
    return out
  }

  const said = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')
  const echo: Script = (r) => [{ type: 'text', text: r.last.kind === 'text' ? `Echo: ${r.last.text}` : 'Finished' }]

  it('names a conversation with the smallest model, with no tools, and nothing kept as a session', async () => {
    api.naming = () => '"Plan the KB rollout."'
    const before = api.requests.length
    const reply = await createClaudeTitler(host())('Help me plan how we roll out the KB updates to the canary hosts first')
    // The raw reply comes back; turning it into a title is the service's job.
    expect(reply).toBe('"Plan the KB rollout."')
    const asked = api.requests.slice(before).filter((r) => r.last.kind === 'text' && r.last.text.includes('canary hosts'))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.model).toMatch(/haiku/i)
    expect(asked[0]?.body['tools'] ?? []).toEqual([])
    expect(asked[0]?.last.kind === 'text' && asked[0].last.text).toContain('at most 6 words')
  }, 90_000)

  it('names nothing, quietly, when Claude is not ready', async () => {
    const lost = createClaudeHost({ installedAt: [], getKey: async () => null, configDir: config })
    expect(await createClaudeTitler(lost)('Anything at all')).toBeUndefined()
  })

  it('streams an answer in parts, reports usage, ends the turn, and remembers the session', async () => {
    api.setScript(echo)
    const t = make()
    const events = await turn(t.session, 'hello there')
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('turn.started')
    expect(types[types.length - 1]).toBe('turn.completed')
    expect(types.filter((x) => x === 'message.delta').length).toBeGreaterThan(1)
    expect(said(events)).toBe('Echo: hello there')
    expect(types).toContain('usage.updated')
    expect(t.remembered[0]).toMatch(/^[0-9a-f-]{36}$/)
    await t.session.close()
  }, 90_000)

  it('keeps one process for a conversation, and sends the history with the second message', async () => {
    api.setScript(echo)
    const t = make()
    await turn(t.session, 'first')
    const events = await turn(t.session, 'second')
    expect(said(events)).toBe('Echo: second')
    const last = api.main[api.main.length - 1]
    expect(JSON.stringify(last?.body['messages'])).toContain('first')
    await t.session.close()
  }, 90_000)

  it('asks before writing a file in ask mode: a yes writes it, with a diff', async () => {
    const target = join(dir, 'made.txt')
    api.setScript((r) => (r.last.kind === 'text' ? [{ type: 'tool_use', name: 'Write', input: { file_path: target, content: 'hi\nthere\n' } }] : [{ type: 'text', text: 'Finished' }]))
    const t = make({ approval: 'ask' })
    const events = await turn(t.session, 'make the file', (e) => {
      if (e.type === 'approval.requested') t.session.respond(e.requestId, { allow: true })
    })
    expect(events.find((e) => e.type === 'approval.requested')).toMatchObject({ kind: 'write', detail: 'made.txt' })
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('hi\nthere\n')
    expect(events.find((e) => e.type === 'tool.started')).toMatchObject({ kind: 'write', title: 'Write made.txt' })
    const done = events.find((e) => e.type === 'tool.completed') as Extract<AgentEvent, { type: 'tool.completed' }>
    expect(done.ok).toBe(true)
    expect(done.diff?.[0]).toMatchObject({ path: 'made.txt', status: 'added', added: 2 })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed' })
    await t.session.close()
  }, 90_000)

  it('does not write the file when the answer is no, and Claude is told', async () => {
    const target = join(dir, 'refused.txt')
    api.setScript((r) => (r.last.kind === 'text' ? [{ type: 'tool_use', name: 'Write', input: { file_path: target, content: 'x' } }] : [{ type: 'text', text: 'Finished' }]))
    const t = make({ approval: 'ask' })
    const events = await turn(t.session, 'make the file', (e) => {
      if (e.type === 'approval.requested') t.session.respond(e.requestId, { allow: false })
    })
    expect(existsSync(target)).toBe(false)
    const done = events.find((e) => e.type === 'tool.completed') as Extract<AgentEvent, { type: 'tool.completed' }>
    expect(done.ok).toBe(false)
    expect(api.main[api.main.length - 1]?.last).toMatchObject({ kind: 'tool_result', isError: true })
    expect(api.main[api.main.length - 1]?.last.text).toContain('The user denied this.')
    await t.session.close()
  }, 90_000)

  it('refuses a change in plan mode without asking, and tells Claude why', async () => {
    const target = join(dir, 'planned.txt')
    api.setScript((r) => (r.last.kind === 'text' ? [{ type: 'tool_use', name: 'Write', input: { file_path: target, content: 'x' } }] : [{ type: 'text', text: 'Finished' }]))
    const t = make({ approval: 'plan' })
    const events = await turn(t.session, 'make the file')
    expect(events.map((e) => e.type)).not.toContain('approval.requested')
    expect(existsSync(target)).toBe(false)
    expect(api.main[api.main.length - 1]?.last.text).toMatch(/Plan mode/)
    await t.session.close()
  }, 90_000)

  it('shows Claude\'s question as a card and hands the answer back', async () => {
    api.setScript((r) =>
      r.last.kind === 'text'
        ? [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Red or blue?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] } }]
        : [{ type: 'text', text: `You chose: ${r.last.text}` }]
    )
    const t = make()
    const events = await turn(t.session, 'ask me', (e) => {
      if (e.type === 'ask_user.requested') t.session.respond(e.requestId, { 'Red or blue?': 'Blue' })
    })
    const ask = events.find((e) => e.type === 'ask_user.requested') as Extract<AgentEvent, { type: 'ask_user.requested' }>
    expect(ask.questions[0]).toMatchObject({ question: 'Red or blue?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }] })
    expect(api.main[api.main.length - 1]?.last.text).toContain('Blue')
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed' })
    await t.session.close()
  }, 90_000)

  it('sends an attached image to the model', async () => {
    const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e11d1d"/></svg>').render().asPng()
    const file = join(dir, 'square.png')
    writeFileSync(file, png)
    api.setScript(echo)
    const t = make({ attachmentPath: (id) => (id === 'img' ? file : undefined) })
    await turn(t.session, 'what is this', undefined, [{ id: 'img', name: 'square.png', mime: 'image/png', size: png.length }])
    expect(api.main.some((r) => r.image)).toBe(true)
    await t.session.close()
  }, 90_000)

  it('changes the model for the next message', async () => {
    api.setScript(echo)
    const t = make({ model: 'claude:haiku' })
    await turn(t.session, 'one')
    const first = api.main[api.main.length - 1]?.model ?? ''
    t.set({ model: 'claude:opus' })
    await turn(t.session, 'two')
    const second = api.main[api.main.length - 1]?.model ?? ''
    expect(first).toMatch(/haiku/i)
    expect(second).toMatch(/opus/i)
    await t.session.close()
  }, 90_000)

  it('ends a stopped answer as interrupted, and answers the next message', async () => {
    api.setScript((r) => (r.last.kind === 'text' && r.last.text.includes('HOLD') ? [{ type: 'hold' }] : [{ type: 'text', text: 'Back again' }]))
    const t = make()
    let stopped = false
    const events = await turn(t.session, 'HOLD on', (e) => {
      if (e.type === 'message.delta' && !stopped) {
        stopped = true
        void t.session.interrupt()
      }
    })
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.interrupted' })
    expect(events.map((e) => e.type)).not.toContain('turn.failed')
    const next = await turn(t.session, 'are you there')
    expect(said(next)).toBe('Back again')
    await t.session.close()
  }, 120_000)

  it('picks the conversation up in a new process after a restart, with no notice', async () => {
    api.setScript(echo)
    const first = make()
    await turn(first.session, 'remember tangerine')
    const id = first.remembered[0] as string
    await first.session.close()

    const second = make({ vendorSessionId: id })
    const events = await turn(second.session, 'what did I say')
    expect(events[events.length - 1]).toMatchObject({ type: 'turn.completed' })
    expect(said(events)).not.toContain(RESUME_NOTICE.trim())
    expect(JSON.stringify(api.main[api.main.length - 1]?.body['messages'])).toContain('tangerine')
    await second.session.close()
  }, 120_000)

  it('continues from Celeste\'s log, and says so, when Claude no longer has the conversation', async () => {
    api.setScript(echo)
    const t = make({ vendorSessionId: '00000000-0000-4000-8000-000000000000', transcript: 'User: remember kumquat\n\nAssistant: ok\n\nUser: what was it' })
    const events = await turn(t.session, 'what was it')
    expect(events[events.length - 1], JSON.stringify(events)).toMatchObject({ type: 'turn.completed' })
    expect(events.map((e) => e.type)).not.toContain('turn.failed')
    expect(said(events)).toContain(RESUME_NOTICE.trim())
    expect(JSON.stringify(api.main[api.main.length - 1]?.body['messages'])).toContain('kumquat')
    await t.session.close()
  }, 120_000)

  it('reports a rejected key as an auth failure with the real message', async () => {
    api.setScript(echo)
    const savedFetch = api.requests.length
    void savedFetch
    // The real program turns a 401 from the API into a result that says the key is wrong.
    const rejecting = new FakeAnthropic(() => [])
    await rejecting.start()
    const stub = rejecting as unknown as { handle: (req: unknown, res: { writeHead: (c: number, h: object) => void; end: (b: string) => void }) => Promise<void> }
    stub.handle = async (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
    }
    const prior = process.env['ANTHROPIC_BASE_URL']
    process.env['ANTHROPIC_BASE_URL'] = rejecting.url
    try {
      const t = make()
      const events = await turn(t.session, 'hello')
      expect(events[events.length - 1]).toMatchObject({ type: 'turn.failed', error: { code: 'auth' } })
      await t.session.close()
    } finally {
      process.env['ANTHROPIC_BASE_URL'] = prior
      await rejecting.stop()
    }
  }, 90_000)
})
