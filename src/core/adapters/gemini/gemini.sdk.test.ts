import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, ApprovalMode } from '@shared/agent'
import type { AdapterContext } from '../types'
import { FakeGemini, type Script } from './fake-gemini'
import { createGeminiHost, createGeminiSession, downloadGemini, findGemini } from './index'
import type { GeminiAgentSession } from './session'

/*
 * The adapter against the real Gemini CLI, with a stand-in for Google's API on this computer (fake-gemini.ts): no account, no key, no
 * cost. It proves that the updates the real program sends are the ones the translator reads, that its approval questions are answered
 * by the approval modes, and that a conversation loads again. Gemini CLI is not in node_modules, so it runs where
 * `CELESTE_GEMINI_PROGRAM` names the program or an earlier run left one in scripts/.output/gemini; `npm run verify:gemini` downloads
 * the pinned one (19 MB, once) and runs this.
 */

// The program: the one named, or the one an earlier run downloaded, or (when asked to) the pinned one, downloaded now the way the app does it.
const cache = join(process.cwd(), 'scripts', '.output', 'gemini')
const program: string | undefined =
  process.env['CELESTE_GEMINI_PROGRAM'] ?? findGemini({ dataDir: cache }) ?? (process.env['CELESTE_DOWNLOAD_GEMINI'] === '1' ? await downloadGemini({ dataDir: cache }) : undefined)
if (program) process.env['CELESTE_GEMINI_PROGRAM'] = program
const TERMINAL = ['turn.completed', 'turn.failed', 'turn.interrupted']
/** A named model: Auto makes the program ask the model about the task first, which a stand-in cannot answer. */
const MODEL = 'gemini:gemini-3-flash-preview'

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

describe.skipIf(!program || !existsSync(program))('the Gemini adapter with the real Gemini CLI', () => {
  const api = new FakeGemini(() => [])
  let dir: string
  let data: string
  const saved: Record<string, string | undefined> = {}
  const open: GeminiAgentSession[] = []

  beforeAll(async () => {
    await api.start()
    dir = mkdtempSync(join(tmpdir(), 'celeste-gemini-work-'))
    data = mkdtempSync(join(tmpdir(), 'celeste-gemini-data-'))
    for (const k of ['CELESTE_GEMINI_BASE_URL']) saved[k] = process.env[k]
    process.env['CELESTE_GEMINI_BASE_URL'] = api.url
  }, 30_000)

  afterAll(async () => {
    // A program that is still running holds its folder on Windows.
    await Promise.all(open.map((s) => s.close()))
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await api.stop()
    await removeWhenFree(dir)
    await removeWhenFree(data)
  })

  const KEY = 'AIza-test-key-for-the-checks-1234'
  const host = () => createGeminiHost({ dataDir: data, getKey: async () => KEY })

  interface Made {
    session: GeminiAgentSession
    remembered: string[]
  }
  const make = (over: { approval?: ApprovalMode; vendorSessionId?: string; transcript?: string; model?: string } = {}): Made => {
    const remembered: string[] = []
    const options: ReturnType<AdapterContext['options']> = { model: over.model ?? MODEL, effort: null, approval: over.approval ?? 'auto', cwd: dir }
    const ctx: AdapterContext = {
      sessionId: 's-1',
      vendor: 'gemini',
      mode: 'develop',
      options: () => ({ ...options }),
      getApproval: () => options.approval,
      ...(over.vendorSessionId ? { vendorSessionId: over.vendorSessionId } : {}),
      remember: (id) => remembered.push(id),
      transcript: () => over.transcript ?? '',
      attachmentPath: () => undefined
    }
    const session = createGeminiSession(host(), ctx)
    open.push(session)
    return { session, remembered }
  }

  async function turn(session: GeminiAgentSession, text: string, react: (e: AgentEvent) => void = () => undefined): Promise<AgentEvent[]> {
    const out: AgentEvent[] = []
    const it = session.events[Symbol.asyncIterator]()
    session.send({ text, attachments: [] })
    for (;;) {
      const r = await Promise.race([it.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out. Got: ${out.map((e) => e.type).join(', ')}`)), 90_000))])
      if (r.done) break
      out.push(r.value)
      react(r.value)
      if (TERMINAL.includes(r.value.type)) break
    }
    return out
  }

  const said = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')
  const types = (events: AgentEvent[]) => events.map((e) => e.type)
  const echo: Script = (r) => [{ type: 'text', text: r.last.kind === 'text' ? `Echo: ${r.last.text}` : 'Finished' }]
  /** Calls a tool once, then reports what came back. */
  const calls =
    (name: string, args: Record<string, unknown>): Script =>
    (r) =>
      r.last.kind === 'tool_result' ? [{ type: 'text', text: `Result: ${r.last.text.replace(/\s+/g, ' ').slice(0, 200)}` }] : [{ type: 'call', name, args }]

  it('is connected with the key, and says so when Google refuses it', async () => {
    const h = host()
    expect(await h.status()).toEqual({ state: 'signed-in', account: 'API key ending 1234' })
    api.rejectKeys = true
    try {
      expect(await h.status()).toEqual({ state: 'unavailable', message: 'Google did not accept this API key.' })
    } finally {
      api.rejectKeys = false
    }
  })

  it('lists the models Gemini offers, with Auto first', async () => {
    const models = await host().models()
    expect(models.length).toBeGreaterThan(1)
    expect(models[0]).toMatchObject({ id: 'gemini:auto', label: 'Auto', vendor: 'gemini', efforts: [] })
    for (const m of models) expect(m.id.startsWith('gemini:')).toBe(true)
    expect(models.some((m) => /^Gemini \d/.test(m.label))).toBe(true)
  }, 90_000)

  it('answers a message, streaming the text, with the key sent to Google and no statistics or updates switched on', async () => {
    api.setScript(echo)
    const { session, remembered } = make()
    const events = await turn(session, 'Say hello')
    expect(types(events)[0]).toBe('turn.started')
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(said(events)).toBe('Echo: Say hello')
    expect(events.some((e) => e.type === 'usage.updated')).toBe(true)
    expect(api.requests.at(-1)?.key).toBe(KEY)
    expect(api.requests.at(-1)?.model).toBe('gemini-3-flash-preview')
    expect(remembered).toHaveLength(1)
    expect(session.vendorSessionId).toBe(remembered[0])
    const settings = JSON.parse(readFileSync(join(data, 'gemini-home', '.gemini', 'settings.json'), 'utf8')) as { privacy: { usageStatisticsEnabled: boolean }; general: { enableAutoUpdate: boolean }; security: { folderTrust: { enabled: boolean } } }
    expect(settings.privacy.usageStatisticsEnabled).toBe(false)
    expect(settings.general.enableAutoUpdate).toBe(false)
    expect(settings.security.folderTrust.enabled).toBe(false)
  }, 90_000)

  it('runs a command without asking when approval is automatic', async () => {
    api.setScript(calls('run_shell_command', { command: 'echo hi-from-gemini', description: 'Say hi' }))
    const { session } = make({ approval: 'auto' })
    const events = await turn(session, 'Run it')
    expect(events.find((e) => e.type === 'tool.started')).toMatchObject({ kind: 'shell', title: 'echo hi-from-gemini' })
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: true })
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(said(events)).toContain('hi-from-gemini')
  }, 90_000)

  it('asks first, and runs the command only when allowed', async () => {
    api.setScript(calls('run_shell_command', { command: 'Set-Content -Path allowed.txt -Value yes', description: 'Write a file' }))
    const { session } = make({ approval: 'ask' })
    const asked: AgentEvent[] = []
    const events = await turn(session, 'Run it', (e) => {
      if (e.type === 'approval.requested') {
        asked.push(e)
        session.respond(e.requestId, { allow: true })
      }
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'shell', title: 'Run a command' })
    expect((asked[0] as { detail?: string }).detail).toContain('allowed.txt')
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: true })
    expect(existsSync(join(dir, 'allowed.txt'))).toBe(true)
  }, 90_000)

  it('does not run the command when the person says no, and the model is told', async () => {
    api.setScript(calls('run_shell_command', { command: 'Set-Content -Path never.txt -Value no', description: 'Write a file' }))
    const { session } = make({ approval: 'edits' })
    const events = await turn(session, 'Run it', (e) => {
      if (e.type === 'approval.requested') session.respond(e.requestId, { allow: false })
    })
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: false })
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(existsSync(join(dir, 'never.txt'))).toBe(false)
    expect(api.requests.at(-1)?.last.kind).toBe('tool_result')
  }, 90_000)

  it('lets a file change through without asking when edits are approved, with a diff to show', async () => {
    api.setScript(calls('write_file', { file_path: 'note.txt', content: 'one\ntwo\n' }))
    const { session } = make({ approval: 'edits' })
    const events = await turn(session, 'Write it')
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
    // A new file is a write when Gemini says so in its first update, and an edit when it does not: the diff says which it was.
    const started = events.find((e) => e.type === 'tool.started') as Extract<AgentEvent, { type: 'tool.started' }>
    expect(['edit', 'write']).toContain(started.kind)
    const done = events.find((e) => e.type === 'tool.completed') as Extract<AgentEvent, { type: 'tool.completed' }>
    expect(done.ok).toBe(true)
    expect(done.diff?.[0]).toMatchObject({ path: 'note.txt', status: 'added', added: 2, removed: 0 })
    // Gemini writes the line endings of the computer it runs on.
    expect(readFileSync(join(dir, 'note.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\ntwo\n')
  }, 90_000)

  it('plan mode changes nothing', async () => {
    api.setScript(calls('write_file', { file_path: 'planned.txt', content: 'no' }))
    const { session } = make({ approval: 'plan' })
    const events = await turn(session, 'Do it')
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(existsSync(join(dir, 'planned.txt'))).toBe(false)
  }, 90_000)

  it('stops an answer in the middle', async () => {
    api.setScript(() => [{ type: 'hold' }])
    const { session } = make()
    const events = await turn(session, 'Take your time', (e) => {
      if (e.type === 'message.delta') void session.interrupt()
    })
    expect(events.at(-1)?.type).toBe('turn.interrupted')
  }, 90_000)

  it('loads a conversation in a new process without showing it again, and the earlier turn is in what the model is sent', async () => {
    api.setScript(echo)
    const first = make()
    await turn(first.session, 'Remember the word pineapple')
    const id = first.session.vendorSessionId
    await first.session.close()
    const second = make({ vendorSessionId: id })
    const events = await turn(second.session, 'What was the word?')
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(second.session.vendorSessionId).toBe(id)
    // What Gemini replays while it loads is not shown: only this turn's answer is.
    expect(said(events)).toBe('Echo: What was the word?')
    expect(JSON.stringify(api.requests.at(-1)?.body['contents'])).toContain('pineapple')
  }, 120_000)

  it('starts a new conversation from the log, and says so, when Gemini no longer has the old one', async () => {
    api.setScript(echo)
    const { session, remembered } = make({ vendorSessionId: '00000000-0000-4000-8000-000000000000', transcript: 'User: Earlier question\n\nAssistant: Earlier answer\n\nUser: And now?' })
    const events = await turn(session, 'And now?')
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(said(events)).toContain('no longer had this conversation')
    expect(remembered).toHaveLength(1)
    expect(JSON.stringify(api.requests.at(-1)?.body['contents'])).toContain('Earlier question')
  }, 90_000)
})
