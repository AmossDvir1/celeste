import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskAnswers, AttachmentInfo } from '@shared/agent'
import type { LogEvent, StoredEvent } from '@shared/api'
import { Resvg } from '@resvg/resvg-js'
import { DEFAULT_SETTINGS, DEFAULT_VENDORS } from '@shared/defaults'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeConnectorFactory } from '../../devices/fake-connector'
import { DeviceService, type FileOps } from '../../devices/device-service'
import { DeviceToolServer } from '../../devices/mcp-server'
import { DeviceTools } from '../../devices/tools'
import { DiskFileStore } from '../../disk-files'
import { MemoryStore } from '../../memory-store'
import { SessionService } from '../../service'
import { createClaudeHost, createClaudeSession } from './index'
import { RESUME_NOTICE } from './session'

/*
 * Talks to the real Claude Code, as whoever is signed in to Claude on this computer. It spends a little of that
 * account's usage (about ten short turns on a small model), so it only runs when asked:
 *
 *   CELESTE_LIVE_CLAUDE=1 node node_modules/vitest/vitest.mjs run src/core/adapters/claude/claude.live.test.ts
 *
 * Development only: it uses the person's own sign-in, subscription included, which a released Celeste never does
 * (see host.ts). It goes through the whole path the app uses: SessionService, the adapter, the SDK, and Celeste's
 * own device tool server with a pretend device behind it.
 */

const live = process.env['CELESTE_LIVE_CLAUDE'] === '1'
const MODEL = process.env['CELESTE_LIVE_MODEL'] ?? 'claude:haiku'

const noDisk = (): FileOps => ({ join: (...p) => p.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/'), mkdirp: async () => undefined, remove: async () => undefined })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!live)('Claude, for real', () => {
  const host = createClaudeHost({ installedAt: require.resolve.paths('@anthropic-ai/claude-agent-sdk') ?? [], getKey: async () => null, allowSubscription: true })
  const store = new MemoryStore()
  const connectors = fakeConnectorFactory()
  let dir: string
  let server: DeviceToolServer
  let sessions: SessionService
  let tools: DeviceTools
  let devices: DeviceService

  const build = () =>
    new SessionService({
      store,
      files: new DiskFileStore(join(dir, '.attachments')),
      dataDir: '/data',
      adapter: (ctx) => createClaudeSession(host, ctx, (id) => server.info(id)),
      push: () => undefined,
      defaults: DEFAULT_SETTINGS,
      defaultVendors: DEFAULT_VENDORS,
      onSessionStopped: (id) => tools.cancel(id)
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'celeste-live-claude-'))
    writeFileSync(join(dir, 'notes.txt'), 'hello from celeste\n')
    devices = new DeviceService({ store, dataDir: '/data', getSecret: async () => 'pw', connectorFor: connectors, push: () => undefined, fs: noDisk() })
    // Both services need each other: the tools ask the session service for approval cards.
    tools = new DeviceTools(store, devices, { requestApproval: (...a) => sessions.requestApproval(...a) }, noDisk(), '/data')
    server = new DeviceToolServer(tools)
    await server.start()
    sessions = build()
  }, 30_000)

  afterAll(async () => {
    sessions.close()
    await server.stop()
    await host.stop()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  const log = (id: string): LogEvent[] => store.events(id).map((e: StoredEvent) => e.event)
  const answerText = (id: string) =>
    log(id)
      .flatMap((e) => (e.type === 'message.delta' ? [e.text] : []))
      .join('')
  const create = (over: Record<string, unknown> = {}) =>
    sessions.api['sessions.create']({ vendor: 'claude', mode: 'develop', title: 'live', model: MODEL, effort: null, approval: 'auto', cwd: dir, ...over } as never).id

  /** Sends a message and answers every card the way `decide` says, until the turn ends. Returns how it ended. */
  async function turn(
    id: string,
    message: string,
    decide: (e: Extract<LogEvent, { type: 'approval.requested' }>) => boolean = () => true,
    extra: { attachments?: AttachmentInfo[]; answer?: (e: Extract<LogEvent, { type: 'ask_user.requested' }>) => AskAnswers } = {}
  ): Promise<LogEvent> {
    const before = log(id).length
    sessions.api['sessions.send'](id, { text: message, attachments: extra.attachments ?? [] })
    const answered = new Set<string>()
    for (let i = 0; i < 1800; i++) {
      await sleep(100)
      const events = log(id).slice(before)
      for (const e of events) {
        if (e.type === 'approval.requested' && !answered.has(e.requestId)) {
          answered.add(e.requestId)
          sessions.api['sessions.respondApproval'](id, e.requestId, { allow: decide(e) })
        }
        if (e.type === 'ask_user.requested' && extra.answer && !answered.has(e.requestId)) {
          answered.add(e.requestId)
          sessions.api['sessions.respondAsk'](id, e.requestId, extra.answer(e))
        }
      }
      const end = events.find((e) => ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(e.type))
      if (end) return end
    }
    throw new Error(`The turn did not end. Log: ${log(id).slice(before).map((e) => e.type).join(', ')}`)
  }

  it('reports who is signed in, and Claude\'s own models with the effort each takes', async () => {
    const status = await host.status()
    expect(status.state, JSON.stringify(status)).toBe('signed-in')
    const models = await host.models()
    expect(models.length).toBeGreaterThan(2)
    expect(models.map((m) => m.id)).toContain('claude:sonnet')
    expect(models.find((m) => m.id === 'claude:sonnet')?.efforts.length).toBeGreaterThan(0)
  }, 90_000)

  it('answers, streams, and remembers its Claude session', async () => {
    const id = create()
    const end = await turn(id, 'Reply with exactly the one word: pong')
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(answerText(id).toLowerCase()).toContain('pong')
    expect(log(id).filter((e) => e.type === 'message.delta').length).toBeGreaterThan(0)
    expect(store.getSession(id)?.vendorSessionId).toMatch(/[0-9a-f-]{36}/)
    expect(store.getSession(id)?.status).toBe('idle')
  }, 120_000)

  it('asks the person a question with AskUserQuestion, and uses the answer', async () => {
    const id = create()
    let asked: string | undefined
    const end = await turn(id, 'Use the AskUserQuestion tool to ask me whether I prefer red or blue, offering exactly those two options. Then reply with just my answer.', undefined, {
      answer: (e) => {
        const q = e.questions[0]
        asked = JSON.stringify(q?.options.map((o) => o.label))
        return { [q?.question ?? '']: 'Blue' }
      }
    })
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(asked, 'the question had choices').toMatch(/red/i)
    expect(answerText(id).toLowerCase()).toContain('blue')
  }, 120_000)

  it('shows the agent an attached image', async () => {
    // A plain red square, drawn here so nothing is downloaded.
    const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#e11d1d"/></svg>').render().asPng()
    const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
    const info = sessions.api['attachments.save']({ name: 'square.png', mime: 'image/png', data: bytes, width: 96, height: 96 })
    const id = create()
    const end = await turn(id, 'What colour is the attached image? Reply with just the colour name.', undefined, { attachments: [info] })
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(answerText(id).toLowerCase()).toContain('red')
  }, 120_000)

  it('switches model and effort in the middle of a conversation', async () => {
    const id = create()
    await turn(id, 'Remember this word: lantern. Reply only with: ok')
    sessions.api['sessions.update'](id, { model: 'claude:sonnet', effort: 'low' })
    const end = await turn(id, 'What word did I ask you to remember? Reply with just the word.')
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(answerText(id).toLowerCase().split('ok').pop()).toContain('lantern')
  }, 180_000)

  it('picks up the same conversation after Celeste restarts, with no fallback notice', async () => {
    const id = create()
    await turn(id, 'Remember this word: tangerine. Reply only with: ok')
    const first = store.getSession(id)?.vendorSessionId
    sessions.close()
    sessions = build()
    const end = await turn(id, 'What was the word I asked you to remember? Reply with just the word.')
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(answerText(id).toLowerCase()).toContain('tangerine')
    expect(answerText(id)).not.toContain(RESUME_NOTICE.trim())
    expect(store.getSession(id)?.vendorSessionId).toBe(first)
  }, 180_000)

  it('continues from the log, and says so, when Claude no longer has the conversation', async () => {
    const id = create()
    await turn(id, 'Remember this word: kumquat. Reply only with: ok')
    sessions.close()
    store.patchSession(id, { vendorSessionId: '00000000-0000-4000-8000-000000000000' })
    sessions = build()
    const end = await turn(id, 'What was the word I asked you to remember? Reply with just the word.')
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(answerText(id)).toContain(RESUME_NOTICE.trim())
    expect(answerText(id).toLowerCase()).toContain('kumquat')
  }, 180_000)

  it('asks before changing a file in ask mode: allowing it writes the file, denying it does not', async () => {
    const id = create({ approval: 'ask' })
    const allowed: string[] = []
    await turn(id, 'Create a file named allowed.txt containing exactly: yes. Reply with: done', (e) => (allowed.push(`${e.kind}:${e.title}`), true))
    expect(allowed.some((a) => /^(edit|write):/.test(a))).toBe(true)
    expect(readFileSync(join(dir, 'allowed.txt'), 'utf8').trim()).toBe('yes')
    expect(log(id).find((e) => e.type === 'tool.completed' && e.diff?.some((d) => d.path === 'allowed.txt'))).toBeDefined()

    const id2 = create({ approval: 'ask' })
    await turn(id2, 'Create a file named denied.txt containing exactly: no. If you are not allowed to, say so in one short sentence.', () => false)
    expect(existsSync(join(dir, 'denied.txt'))).toBe(false)
    expect(log(id2).some((e) => e.type === 'approval.resolved' && e.allow === false)).toBe(true)
  }, 240_000)

  it('refuses to change anything in plan mode, without asking', async () => {
    const id = create({ approval: 'plan' })
    const end = await turn(id, 'Create a file named planned.txt containing: x. If you cannot, say so in one short sentence.')
    expect(end.type).toBe('turn.completed')
    expect(existsSync(join(dir, 'planned.txt'))).toBe(false)
    expect(log(id).some((e) => e.type === 'approval.requested')).toBe(false)
  }, 120_000)

  it('runs a command on a device through Celeste\'s tool server, after Celeste\'s own approval card', async () => {
    const d = await devices.api['devices.create']({ name: 'build-vm', kind: 'ssh', host: '10.0.0.5', username: 'dev', authMethod: 'password' })
    const first = await devices.api['devices.test'](d.id)
    if (first.ok || !first.hostKey) throw new Error('expected an unknown host key')
    await devices.api['devices.trustKey'](d.id, first.hostKey.fingerprint)
    expect((await devices.api['devices.test'](d.id)).ok).toBe(true)
    await devices.api['devices.update'](d.id, { accessLevel: 'ask' })

    const id = create({ mode: 'chat', cwd: undefined, approval: 'auto' })
    await devices.api['devices.attach'](id, d.id, true)
    const cards: string[] = []
    const end = await turn(id, 'Use the device_run tool to run `uname -a` on the device build-vm. Then tell me the kernel version number from its output.', (e) => (cards.push(`${e.requestId.startsWith('tool-') ? 'celeste' : 'vendor'}|${e.title}|${e.detail ?? ''}`), true))
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')

    // One card, Celeste's own, naming the device and the command. Claude's own prompt for the tool was skipped.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatch(/^celeste\|Run on build-vm\|.*uname/)
    expect(connectors.made.flatMap((c) => c.ran).some((c) => c.includes('uname'))).toBe(true)
    expect(log(id).find((e) => e.type === 'tool.started' && e.kind === 'mcp'), 'the call shows as a tool in the timeline').toBeDefined()
    expect(answerText(id)).toContain('6.8.0')
  }, 180_000)
})
