import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, ApprovalMode } from '@shared/agent'
import type { AdapterContext } from '../types'
import { FakeOpenAi, type Script } from './fake-openai'
import { createOpenAiHost, createOpenAiSession, downloadCodex, findCodex } from './index'
import type { OpenAiAgentSession } from './session'

/*
 * The adapter against the real Codex program, with a stand-in for OpenAI's Responses API on this computer (fake-openai.ts): no account,
 * no cost. It proves that the notifications the real program sends are the ones the translator reads, that its approval questions
 * are answered by the approval modes, and that a conversation resumes. Codex is not in node_modules, so it runs where
 * `CELESTE_CODEX_PROGRAM` names the program or an earlier run left one in scripts/.output/codex; `npm run verify:openai` downloads the
 * pinned one (about 180 MB, once) and runs this.
 */

// The program: the one named, or the one an earlier run downloaded, or (when asked to) the pinned one, downloaded now the way the app does it.
const cache = join(process.cwd(), 'scripts', '.output', 'codex')
const program: string | undefined =
  process.env['CELESTE_CODEX_PROGRAM'] ?? findCodex({ dataDir: cache }) ?? (process.env['CELESTE_DOWNLOAD_CODEX'] === '1' ? await downloadCodex({ dataDir: cache }) : undefined)
if (program) process.env['CELESTE_CODEX_PROGRAM'] = program
const TERMINAL = ['turn.completed', 'turn.failed', 'turn.interrupted']

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

describe.skipIf(!program || !existsSync(program))('the OpenAI adapter with the real Codex', () => {
  const api = new FakeOpenAi(() => [])
  let dir: string
  let data: string
  const saved: Record<string, string | undefined> = {}
  const open: OpenAiAgentSession[] = []

  beforeAll(async () => {
    await api.start()
    dir = mkdtempSync(join(tmpdir(), 'celeste-openai-work-'))
    data = mkdtempSync(join(tmpdir(), 'celeste-openai-data-'))
    for (const k of ['CELESTE_OPENAI_BASE_URL']) saved[k] = process.env[k]
    process.env['CELESTE_OPENAI_BASE_URL'] = api.url
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

  const KEY = 'sk-test-key-for-the-checks-1234'
  const host = () => {
    const kept = new Map<string, string>()
    return createOpenAiHost({
      dataDir: data,
      tokens: { get: async () => kept.get('t') ?? null, set: async (v) => (kept.set('t', v), true), remove: async () => void kept.delete('t') },
      getKey: async () => KEY
    })
  }
  // Test runs point the host at the program the test names. (Development does the same through the environment.)
  const withProgram = <T>(fn: () => T): T => {
    const was = process.env['CELESTE_CODEX_PROGRAM']
    process.env['CELESTE_CODEX_PROGRAM'] = program as string
    try {
      return fn()
    } finally {
      if (was === undefined) delete process.env['CELESTE_CODEX_PROGRAM']
    }
  }

  interface Made {
    session: OpenAiAgentSession
    remembered: string[]
    set: (patch: Partial<ReturnType<AdapterContext['options']>>) => void
  }
  const make = (over: { approval?: ApprovalMode; vendorSessionId?: string; transcript?: string; model?: string } = {}): Made => {
    const remembered: string[] = []
    const options: ReturnType<AdapterContext['options']> = { model: over.model ?? 'openai:fake-model', effort: null, approval: over.approval ?? 'auto', cwd: dir }
    const ctx: AdapterContext = {
      sessionId: 's-1',
      vendor: 'openai',
      mode: 'develop',
      options: () => ({ ...options }),
      getApproval: () => options.approval,
      ...(over.vendorSessionId ? { vendorSessionId: over.vendorSessionId } : {}),
      remember: (id) => remembered.push(id),
      transcript: () => over.transcript ?? '',
      attachmentPath: () => undefined
    }
    const session = withProgram(() => createOpenAiSession(host(), ctx))
    open.push(session)
    return { session, remembered, set: (patch) => Object.assign(options, patch) }
  }

  async function turn(session: OpenAiAgentSession, text: string, react: (e: AgentEvent) => void = () => undefined): Promise<AgentEvent[]> {
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
  /** Runs the command once, then reports what came back. */
  const runs = (cmd: string): Script => (r) => (r.last.kind === 'tool_result' ? [{ type: 'text', text: `Result: ${r.last.text.replace(/\s+/g, ' ').slice(0, 160)}` }] : [{ type: 'call', name: 'exec_command', arguments: { cmd } }])

  it('is signed in with the key, and says so when OpenAI refuses it', async () => {
    const h = withProgram(host)
    expect(await h.status()).toEqual({ state: 'signed-in', account: 'API key ending 1234' })
    api.rejectKeys = true
    try {
      expect(await h.status()).toEqual({ state: 'unavailable', message: 'OpenAI did not accept this API key.' })
    } finally {
      api.rejectKeys = false
    }
  })

  it('lists the models Codex has, with their effort settings', async () => {
    const models = await withProgram(host).models()
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) {
      expect(m.id.startsWith('openai:')).toBe(true)
      expect(m.vendor).toBe('openai')
      expect(m.label.length).toBeGreaterThan(0)
    }
    expect(models.some((m) => m.efforts.includes('high'))).toBe(true)
  }, 60_000)

  it('answers a message, streaming the text, with the key as the bearer token', async () => {
    api.setScript(echo)
    const { session, remembered } = make()
    const events = await turn(session, 'Say hello')
    expect(types(events)[0]).toBe('turn.started')
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(said(events)).toBe('Echo: Say hello')
    expect(events.some((e) => e.type === 'usage.updated')).toBe(true)
    expect(api.requests.at(-1)?.authorization).toBe(`Bearer ${KEY}`)
    expect(remembered).toHaveLength(1)
    expect(session.vendorSessionId).toBe(remembered[0])
  }, 90_000)

  it('runs a command without asking when approval is automatic', async () => {
    api.setScript(runs('echo hi-from-codex'))
    const { session } = make({ approval: 'auto' })
    const events = await turn(session, 'Run it')
    const started = events.find((e) => e.type === 'tool.started')
    expect(started).toMatchObject({ kind: 'shell' })
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
    expect(events.filter((e) => e.type === 'tool.output').map((e) => (e as { text: string }).text).join('')).toContain('hi-from-codex')
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: true })
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(said(events)).toContain('hi-from-codex')
  }, 90_000)

  it('asks first, and runs the command only when allowed', async () => {
    api.setScript(runs('echo allowed-by-person'))
    const { session } = make({ approval: 'ask' })
    const asked: AgentEvent[] = []
    const events = await turn(session, 'Run it', (e) => {
      if (e.type === 'approval.requested') {
        asked.push(e)
        session.respond(e.requestId, { allow: true })
      }
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'shell' })
    expect((asked[0] as { detail?: string }).detail).toContain('allowed-by-person')
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: true })
    expect(said(events)).toContain('allowed-by-person')
  }, 90_000)

  it('does not run the command when the person says no, and tells the model', async () => {
    api.setScript(runs('echo never-runs'))
    const { session } = make({ approval: 'edits' })
    const events = await turn(session, 'Run it', (e) => {
      if (e.type === 'approval.requested') session.respond(e.requestId, { allow: false })
    })
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: false })
    expect(events.filter((e) => e.type === 'tool.output')).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(api.requests.at(-1)?.last.kind).toBe('tool_result')
    expect((api.requests.at(-1)?.last as { text: string }).text).toMatch(/reject/i)
  }, 90_000)

  it('plan mode declines what would change things, without a question', async () => {
    api.setScript(runs('Set-Content -Path planned.txt -Value no'))
    const { session } = make({ approval: 'plan' })
    const events = await turn(session, 'Do it')
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ ok: false })
    expect(events.at(-1)?.type).toBe('turn.completed')
  }, 90_000)

  it('stops an answer in the middle', async () => {
    api.setScript(() => [{ type: 'hold' }])
    const { session } = make()
    const events = await turn(session, 'Take your time', (e) => {
      if (e.type === 'message.delta') void session.interrupt()
    })
    expect(events.at(-1)?.type).toBe('turn.interrupted')
  }, 90_000)

  it('resumes a conversation in a new process, with the earlier turn in what the model is sent', async () => {
    api.setScript(echo)
    const first = make()
    await turn(first.session, 'Remember the word pineapple')
    const id = first.session.vendorSessionId
    await first.session.close()
    const second = make({ vendorSessionId: id })
    const events = await turn(second.session, 'What was the word?')
    expect(events.at(-1)?.type).toBe('turn.completed')
    // The thread is the same, and its earlier turn is part of what the model is sent.
    expect(second.session.vendorSessionId).toBe(id)
    expect(JSON.stringify(api.requests.at(-1)?.body['input'])).toContain('pineapple')
  }, 120_000)

  it('starts a new conversation from the log, and says so, when Codex no longer has the old one', async () => {
    api.setScript(echo)
    const { session, remembered } = make({ vendorSessionId: '01a1d9a4-0000-7000-8000-000000000000', transcript: 'User: Earlier question\n\nAssistant: Earlier answer\n\nUser: And now?' })
    const events = await turn(session, 'And now?')
    expect(events.at(-1)?.type).toBe('turn.completed')
    expect(said(events)).toContain('no longer had this conversation')
    expect(remembered).toHaveLength(1)
    expect(JSON.stringify(api.requests.at(-1)?.body['input'])).toContain('Earlier question')
  }, 90_000)
})
