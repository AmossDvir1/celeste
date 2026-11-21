import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { describe, it } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import type { AdapterContext } from '../../../src/core/adapters/types'
import { FakeAnthropic } from '../../../src/core/adapters/claude/fake-anthropic'
import { createClaudeHost, createClaudeSession } from '../../../src/core/adapters/claude'
import { FakeOpenAi } from '../../../src/core/adapters/openai/fake-openai'
import { createOpenAiHost, createOpenAiSession } from '../../../src/core/adapters/openai'
import { FakeGemini } from '../../../src/core/adapters/gemini/fake-gemini'
import { createGeminiHost, createGeminiSession } from '../../../src/core/adapters/gemini'

/*
 * SPIKE (21 November 2026, docs/plans/SUB_AGENTS_PLAN.md, step 0), not a check. For each vendor's real program, with a stand-in for its API:
 * how long can one call to a tool of Celeste's own tool server take before the program gives up (with the setting Celeste gives it), do two
 * calls from one message run side by side, and is the call's request closed when the person presses Stop?
 * The tool server here serves the way DeviceToolServer does (src/core/devices/mcp-server.ts) with one tool that sleeps and notes what it saw.
 * Run:  SPIKE_VENDOR=claude|openai|gemini  SPIKE_CASE=limit:<seconds>|parallel|stop  node node_modules/vitest/vitest.mjs run --config scripts/spikes/subagents/vitest.config.mts
 * Each result is appended to scripts/.output/subagents-spike.log. Codex and Gemini programs are found in the main checkout's scripts/.output (CELESTE_CODEX_PROGRAM / CELESTE_GEMINI_PROGRAM override).
 */

const vendor = process.env['SPIKE_VENDOR'] ?? ''
const wanted = process.env['SPIKE_CASE'] ?? ''
const here = resolve(__dirname, '..', '..', '..')
const out = resolve(here, 'scripts', '.output')
mkdirSync(out, { recursive: true })
const note = (line: string) => {
  const text = `${new Date().toISOString()} ${vendor} ${wanted}: ${line}`
  console.log(text)
  appendFileSync(join(out, 'subagents-spike.log'), text + '\n')
}

interface Seen {
  label: string
  startedAt: number
  endedAt?: number
  requestClosedAt?: number
  aborted?: boolean
}

/** A tool server with one tool that sleeps. `seen` has what each call saw. */
class SleepServer {
  readonly seen: Seen[] = []
  private http: Server | undefined
  url = ''
  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
        const server = new McpServer({ name: 'celeste-devices', version: '1.0.0' })
        let mine: Seen | undefined
        server.registerTool(
          'sleep_test',
          { title: 'Sleep', description: 'Waits the given number of seconds, then answers.', inputSchema: { seconds: z.number(), label: z.string() }, annotations: { readOnlyHint: true } },
          async (args: { seconds: number; label: string }, extra) => {
            const call: Seen = { label: args.label, startedAt: Date.now() }
            mine = call
            this.seen.push(call)
            await new Promise<void>((done) => {
              const t = setTimeout(done, args.seconds * 1000)
              extra.signal.addEventListener('abort', () => {
                clearTimeout(t)
                call.aborted = true
                done()
              })
            })
            call.endedAt = Date.now()
            return { content: [{ type: 'text' as const, text: `slept ${args.seconds}s (${args.label})` }] }
          }
        )
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
        res.on('close', () => {
          if (mine) mine.requestClosedAt = Date.now()
          void transport.close()
          void server.close()
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
      })()
    })
    await new Promise<void>((r) => this.http?.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.http?.address() as AddressInfo).port}/mcp`
  }
  async stop(): Promise<void> {
    this.http?.closeAllConnections()
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()))
  }
}

const TERMINAL = ['turn.completed', 'turn.failed', 'turn.interrupted']
interface Session {
  events: AsyncIterable<AgentEvent>
  send(i: { text: string; attachments: [] }): void
  interrupt(): Promise<void>
  close(): Promise<void>
}

/** The name the program calls the sleeping tool by, found in the tools it offered the model. */
const toolNameIn = (tools: unknown): string | undefined => {
  const found: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o['name'] === 'string' && /sleep_test/.test(o['name'])) found.push(o['name'])
      Object.values(o).forEach(walk)
    } else if (typeof v === 'string' && /sleep_test/.test(v) && v.length < 100) found.push(v)
  }
  walk(tools)
  return found[0]
}

describe.skipIf(!vendor || !wanted)(`${vendor} ${wanted}`, () => {
  it('measures', async () => {
    const sleeps = new SleepServer()
    await sleeps.start()
    const work = mkdtempSync(join(tmpdir(), 'celeste-spike-work-'))
    const data = mkdtempSync(join(tmpdir(), 'celeste-spike-data-'))
    const ctx = (v: 'claude' | 'openai' | 'gemini', model: string): AdapterContext => ({
      sessionId: 's-1',
      vendor: v,
      mode: 'develop',
      options: () => ({ model, effort: null, approval: 'auto', cwd: work }),
      getApproval: () => 'auto',
      remember: () => undefined,
      transcript: () => '',
      attachmentPath: () => undefined
    })
    const device = () => ({ url: sleeps.url, token: 'spike-token' })
    // "limit:N" is one call of N seconds; "parallel" two of 20 s from one message; "stop" one of 120 s that is stopped after 15 s.
    const [kind, arg] = wanted.split(':')
    const calls: { seconds: number; label: string }[] =
      kind === 'parallel' ? [{ seconds: 20, label: 'a' }, { seconds: 20, label: 'b' }] : kind === 'stop' ? [{ seconds: 120, label: 'long' }] : [{ seconds: Number(arg), label: 'one' }]
    let session: Session
    let stopApi: () => Promise<void>

    if (vendor === 'claude') {
      const api = new FakeAnthropic((r) => {
        if (r.last.kind === 'tool_result') return [{ type: 'text', text: `RESULT ${r.last.isError ? '(error) ' : ''}${r.last.text}` }]
        const name = toolNameIn(r.body['tools']) ?? 'mcp__celeste-devices__sleep_test'
        return calls.map((c) => ({ type: 'tool_use' as const, name, input: c }))
      })
      await api.start()
      process.env['ANTHROPIC_BASE_URL'] = api.url
      const host = createClaudeHost({ installedAt: require.resolve.paths('@anthropic-ai/claude-agent-sdk') ?? [], getKey: async () => 'sk-ant-api03-not-a-real-key', configDir: join(data, 'cfg') })
      session = createClaudeSession(host, ctx('claude', 'claude:haiku'), device) as unknown as Session
      stopApi = () => api.stop()
    } else if (vendor === 'openai') {
      const api = new FakeOpenAi((r) => {
        if (r.last.kind === 'tool_result') return [{ type: 'text', text: `RESULT ${r.last.text}` }]
        const name = 'sleep_test'
        note(`  the program offered the tool as "${name}": ${JSON.stringify((r.body["tools"] as {name?:string;type?:string;tools?:unknown[]}[]).filter((t) => /celeste/.test(JSON.stringify(t))).map((t) => ({ ...t, tools: undefined, first: (t.tools ?? [])[0] }))).slice(0, 600)}`)
        return calls.map((c) => ({ type: 'call' as const, name, namespace: 'mcp__celeste_devices', arguments: c }))
      })
      await api.start()
      process.env['CELESTE_OPENAI_BASE_URL'] = api.url
      process.env['CELESTE_CODEX_PROGRAM'] ??= join(here, '..', '..', '..', 'scripts', '.output', 'codex', 'runtimes', 'codex-0.169.0-win32-x64-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
      const kept = new Map<string, string>()
      const host = createOpenAiHost({ dataDir: data, tokens: { get: async () => kept.get('t') ?? null, set: async (v) => (kept.set('t', v), true), remove: async () => void kept.delete('t') }, getKey: async () => 'sk-test-key-for-the-checks-1234' })
      session = createOpenAiSession(host, ctx('openai', 'openai:fake-model'), device) as unknown as Session
      stopApi = () => api.stop()
    } else {
      const api = new FakeGemini((r) => {
        if (r.last.kind === 'tool_result') return [{ type: 'text', text: `RESULT ${r.last.text}` }]
        const name = r.tools.find((t) => /sleep_test/.test(t)) ?? 'mcp_celeste-devices_sleep_test'
        note(`  the program offered the tool as "${name}"`)
        return calls.map((c) => ({ type: 'call' as const, name, args: c }))
      })
      await api.start()
      process.env['CELESTE_GEMINI_BASE_URL'] = api.url
      process.env['CELESTE_GEMINI_PROGRAM'] ??= join(here, '..', '..', '..', 'scripts', '.output', 'gemini', 'runtimes', 'gemini-0.68.0-any', 'bundle', 'gemini.js')
      const host = createGeminiHost({ dataDir: data, getKey: async () => 'AIza-test-key-for-the-checks-1234' })
      session = createGeminiSession(host, ctx('gemini', 'gemini:gemini-3-flash-preview'), device) as unknown as Session
      stopApi = () => api.stop()
    }

    const events: AgentEvent[] = []
    let finish: () => void = () => undefined
    const done = new Promise<void>((r) => (finish = r))
    void (async () => {
      for await (const e of session.events) {
        events.push(e)
        if (TERMINAL.includes(e.type)) finish()
      }
    })()

    const t0 = Date.now()
    session.send({ text: 'please call the slow tool', attachments: [] })
    if (kind === 'stop') {
      await new Promise((r) => setTimeout(r, 15_000))
      note(`pressing Stop at ${Math.round((Date.now() - t0) / 1000)} s`)
      await session.interrupt()
      await Promise.race([done, new Promise((r) => setTimeout(r, 30_000))])
      await new Promise((r) => setTimeout(r, 10_000))
    } else {
      await done
    }
    const took = Math.round((Date.now() - t0) / 1000)
    const said = events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : [])).join('')
    const failed = events.find((e) => e.type === 'turn.failed')
    note(`turn ended after ${took} s: ${events.at(-1)?.type}${failed ? ` ${JSON.stringify(failed)}` : ''}; the assistant said: ${said.slice(0, 300)}`)
    const base = sleeps.seen[0]?.startedAt ?? t0
    const at = (t: number) => `+${Math.round((t - base) / 100) / 10} s`
    for (const s of sleeps.seen) note(`  call ${s.label}: started ${at(s.startedAt)}, ${s.endedAt ? `ended ${at(s.endedAt)}` : 'never ended'}, request closed ${s.requestClosedAt ? at(s.requestClosedAt) : 'never'}, aborted=${s.aborted === true}`)
    if (sleeps.seen.length === 0) note('  the tool was never called')
    await session.close().catch(() => undefined)
    await stopApi().catch(() => undefined)
    await sleeps.stop()
    for (const d of [work, data]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* the program may still hold it */
      }
    }
  })
})
