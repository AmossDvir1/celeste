import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskAnswers, AttachmentInfo } from '@shared/agent'
import type { LogEvent, StoredEvent, VendorProgress } from '@shared/api'
import { Resvg } from '@resvg/resvg-js'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeConnectorFactory } from '../../testing/fake-connector'
import { DeviceService, type FileOps } from '../../devices/device-service'
import { DeviceToolServer } from '../../devices/mcp-server'
import { DeviceTools } from '../../devices/tools'
import { DiskFileStore } from '../../disk-files'
import { MemoryStore } from '../../testing/memory-store'
import { SessionService } from '../../service'
import { copilotRuntime, createCopilotHost, createCopilotSession, createCopilotTitler } from './index'
import { cheapest, cleanTitle } from '../../titles'
import { downloadedRuntime, runtimePlatform } from './runtime'
import { RESUME_NOTICE } from './session'

/*
 * Talks to the real GitHub Copilot, as the user who is signed in on this computer. It spends a few of that
 * account's premium requests (about five turns on a small model), so it only runs when asked:
 *
 *   CELESTE_LIVE_COPILOT=1 node node_modules/vitest/vitest.mjs run src/core/adapters/copilot/copilot.live.test.ts
 *
 * It uses the whole path the app uses: SessionService, the adapter, the runtime, and Celeste's own device
 * tool server with a pretend device behind it.
 */

const live = process.env['CELESTE_LIVE_COPILOT'] === '1'
const MODEL = process.env['CELESTE_LIVE_MODEL'] ?? 'claude-haiku-4.5'

const noDisk = (): FileOps => ({ join: (...p) => p.join('/'), dirname: (p) => p.split('/').slice(0, -1).join('/'), mkdirp: async () => undefined, remove: async () => undefined })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!live)('Copilot, for real', () => {
  const host = createCopilotHost()
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
      adapter: (ctx) => createCopilotSession(host, ctx, (id) => server.info(id)),
      push: () => undefined,
      defaults: DEFAULT_SETTINGS,
      onSessionStopped: (id) => tools.cancel(id)
    })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'celeste-live-'))
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
    // Windows can hold a folder for a moment after the program using it has gone.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  })

  const log = (id: string): LogEvent[] => store.events(id).map((e: StoredEvent) => e.event)
  const answerText = (id: string) =>
    log(id)
      .flatMap((e) => (e.type === 'message.delta' ? [e.text] : []))
      .join('')
  const create = (over: Record<string, unknown> = {}) =>
    sessions.api['sessions.create']({ vendor: 'copilot', mode: 'develop', title: 'live', model: MODEL, effort: null, approval: 'auto', cwd: dir, ...over } as never).id

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
    for (let i = 0; i < 1200; i++) {
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

  it('answers, streams, and remembers its Copilot session', async () => {
    const id = create()
    const end = await turn(id, 'Reply with exactly the one word: pong')
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(answerText(id).toLowerCase()).toContain('pong')
    expect(log(id).filter((e) => e.type === 'message.delta').length).toBeGreaterThan(0)
    expect(store.getSession(id)?.vendorSessionId).toMatch(/[0-9a-f-]{36}/)
    expect(store.getSession(id)?.status).toBe('idle')
  }, 120_000)

  it('asks the person a question with the ask_user tool, and uses the answer', async () => {
    const id = create()
    let asked: string | undefined
    const end = await turn(id, 'Use the ask_user tool to ask me whether I prefer red or blue, offering exactly those two choices. Then reply with just my answer.', undefined, {
      answer: (e) => {
        const q = e.questions[0]
        asked = JSON.stringify(q?.options.map((o) => o.label))
        return { [q?.question ?? '']: ['Blue'] }
      }
    })
    expect(end.type, JSON.stringify(end)).toBe('turn.completed')
    expect(asked, 'the question had choices').toMatch(/red/i)
    expect(answerText(id).toLowerCase()).toContain('blue')
    expect(log(id).some((e) => e.type === 'ask.answered')).toBe(true)
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
    sessions.api['sessions.update'](id, { model: 'mai-code-1.1-flash', effort: 'low' })
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

  it('continues from the log, and says so, when Copilot no longer has the conversation', async () => {
    const id = create()
    await turn(id, 'Remember this word: kumquat. Reply only with: ok')
    sessions.close()
    store.patchSession(id, { vendorSessionId: '00000000-0000-0000-0000-000000000000' })
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
    expect(allowed.some((a) => a.startsWith('edit:'))).toBe(true)
    expect(readFileSync(join(dir, 'allowed.txt'), 'utf8').trim()).toBe('yes')
    const diffDone = log(id).find((e) => e.type === 'tool.completed' && e.diff?.some((d) => d.path === 'allowed.txt'))
    expect(diffDone).toBeDefined()

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

    // One card, Celeste's own, naming the device and the command. The vendor's own prompt for the tool was skipped.
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatch(/^celeste\|Run on build-vm\|.*uname/)
    expect(connectors.made.flatMap((c) => c.ran).some((c) => c.includes('uname'))).toBe(true)
    const tool = log(id).find((e) => e.type === 'tool.started' && e.kind === 'mcp')
    expect(tool, 'the call shows as a tool in the timeline').toBeDefined()
    expect(answerText(id)).toContain('6.8.0')
  }, 180_000)

  it('does not run the command when it is denied', async () => {
    const before = connectors.made.flatMap((c) => c.ran).length
    const id = create({ mode: 'chat', cwd: undefined })
    const attached = (await devices.api['devices.list']())[0]
    if (!attached) throw new Error('no device')
    await devices.api['devices.attach'](id, attached.id, true)
    const end = await turn(id, 'Use the device_run tool to run `df -h` on the device build-vm and show me the output. If it is refused, just say it was refused.', () => false)
    expect(end.type).toBe('turn.completed')
    expect(connectors.made.flatMap((c) => c.ran).length).toBe(before)
  }, 180_000)

  it('walks the real GitHub sign-in as far as the browser step, in a throwaway runtime that knows no one, and cancels', async () => {
    for (const method of ['web', 'code'] as const) {
      const home = mkdtempSync(join(tmpdir(), 'celeste-signin-'))
      const stranger = createCopilotHost(undefined, { isolatedDir: home })
      try {
        expect(await stranger.status()).toEqual({ state: 'signed-out' })
        const progress: VendorProgress[] = []
        const finished = stranger.signIn(method, (p) => progress.push(p))
        for (let i = 0; i < 100 && !progress.some((p) => p.state === 'step'); i++) await sleep(100)
        const step = progress.find((p) => p.state === 'step')
        expect(step, JSON.stringify(progress)).toBeDefined()
        if (step?.state !== 'step') return
        if (method === 'web') expect(step.step).toMatchObject({ kind: 'open-url', url: expect.stringMatching(/^https:\/\/github\.com\/login\/oauth\/authorize\?/) })
        else expect(step.step).toMatchObject({ kind: 'device-code', url: 'https://github.com/login/device', code: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/) })
        await stranger.cancelSignIn()
        await finished
        expect(progress.some((p) => p.state === 'done' || p.state === 'failed')).toBe(false)
      } finally {
        await stranger.stop()
        rmSync(home, { recursive: true, force: true })
      }
    }
  }, 120_000)

  // Downloads about 60 MB from npm, so it needs its own switch: CELESTE_LIVE_DOWNLOAD=1 as well.
  it.skipIf(process.env['CELESTE_LIVE_DOWNLOAD'] !== '1')('downloads the real runtime from npm, checks it, and starts that copy', async () => {
    const data = mkdtempSync(join(tmpdir(), 'celeste-download-'))
    const downloaded = createCopilotHost(copilotRuntime(data))
    try {
      expect(await downloaded.status()).toEqual({ state: 'runtime-missing' })
      const progress: VendorProgress[] = []
      // Already signed in on this computer, so connecting ends at "done" as soon as the program is there.
      await downloaded.signIn('web', (p) => progress.push(p))
      expect(progress[0]).toEqual({ state: 'downloading', progress: 0 })
      expect(progress.filter((p) => p.state === 'downloading').length).toBeGreaterThan(3)
      expect(progress[progress.length - 1]).toMatchObject({ state: 'done' })
      expect(existsSync(downloadedRuntime(data, runtimePlatform() as string).wrapper)).toBe(true)
      expect(await downloaded.status()).toMatchObject({ state: 'signed-in' })
      expect((await downloaded.models()).length).toBeGreaterThan(3)
    } finally {
      await downloaded.stop()
      rmSync(data, { recursive: true, force: true })
    }
  }, 600_000)

  it('lists the real models for this account', async () => {
    const models = await host.models()
    expect(models.length).toBeGreaterThan(3)
    expect(models.find((m) => m.id === MODEL)).toBeDefined()
    expect(await host.status()).toMatchObject({ state: 'signed-in' })
  }, 60_000)

  it('names a conversation with the smallest model on offer, leaving no session behind', async () => {
    const small = cheapest(await host.models())
    console.log(`Naming model: ${small?.id ?? 'none looks small'}`)
    const reply = await createCopilotTitler(host)('Help me plan how we roll out the KB updates to the canary hosts first')
    console.log(`Raw reply: ${JSON.stringify(reply)}`)
    expect(cleanTitle(reply)).toBeTruthy()
  }, 90_000)
})
