// SPIKE (16 November 2026), not a check: what does Claude Code do with a user message sent in the middle of a turn, for each `priority`
// ('now', 'next', 'later', none)? The real Claude Code program through the Agent SDK with an open input like Celeste's, and the stand-in API.
// The first message makes the model run a slow foreground command; 2 s in, a second message is sent. For each API request the model
// makes, this prints what the newest user message held, so the ORDER is visible. Results are in docs/QUEUE_AND_USAGE_PLAN.md.
// Run: node scripts/spikes/steer-sdk.mjs [priority ...]     (default: now next later none)
// SCENARIO=stream  sends the second message while the model is writing its last answer (no tool call to wait for).  DUMP=1  lists every message of each request.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { startStub } from '../lib/stub.mjs'

const root = resolve(import.meta.dirname, '..', '..').replaceAll('\\', '/')
const require = createRequire(root + '/package.json')
const sdk = await import('file:///' + require.resolve('@anthropic-ai/claude-agent-sdk').replace(/\\/g, '/'))
const exe = root + '/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const blocksOf = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content)
const describeMessage = (m) =>
  blocksOf(m)
    .map((b) => (b.type === 'text' ? `text:${JSON.stringify(b.text.slice(0, 60))}` : b.type === 'tool_result' ? 'tool_result' : b.type))
    .join(' + ')

async function trial(priority) {
  const dir = mkdtempSync(join(tmpdir(), 'steerspike-'))
  const t0 = Date.now()
  const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a)
  const seen = []
  const stub = await startStub((r) => {
    const msgs = r.body.messages ?? []
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    seen.push(lastUser ? describeMessage(lastUser) : '(none)')
    log(`  API request ${seen.length}: newest user message = ${seen.at(-1)}   [messages in the request: ${msgs.length}]`)
    if (process.env.DUMP) msgs.forEach((m, i) => log(`      ${i + 1}. ${m.role}: ${describeMessage(m)}`))
    // SCENARIO=stream: the first answer is plain text that takes six seconds to arrive, so the second message comes while the model is writing its last answer, not between tool calls.
    if (process.env.SCENARIO === 'stream' && r.last.kind === 'text' && r.last.text.includes('SLOW')) return [{ type: 'text', text: 'word '.repeat(60), chunk: 5, delayMs: 100 }]
    if (r.last.kind === 'text' && r.last.text.includes('SLOW')) return [{ type: 'tool_use', name: 'Bash', input: { command: 'node -e "setTimeout(()=>console.log(\'slow done\'),6000)"', description: 'wait six seconds' } }]
    if (r.last.kind === 'tool_result') return [{ type: 'text', text: 'The slow command is done.' }]
    return [{ type: 'text', text: `Saw: ${r.last.text.slice(0, 100)}` }]
  })
  const waiting = []
  const queue = []
  let ended = false
  const input = {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (queue.length) yield queue.shift()
        else await new Promise((r) => waiting.push(r))
      }
    }
  }
  const send = (text, p) => {
    queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '', ...(p ? { priority: p } : {}) })
    waiting.splice(0).forEach((r) => r())
  }
  const q = sdk.query({
    prompt: input,
    options: {
      cwd: dir,
      pathToClaudeCodeExecutable: exe,
      env: { ...process.env, ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: 'sk-ant-api03-spike-1234', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      permissionMode: 'default',
      canUseTool: async (name, i) => ({ behavior: 'allow', updatedInput: i }),
      includePartialMessages: false,
      settingSources: []
    }
  })
  const events = []
  const reader = (async () => {
    for await (const m of q) {
      if (m.type === 'system' || m.type === 'stream_event') continue
      const extra = m.type === 'result' ? ` "${(m.result ?? '').slice(0, 70)}"` : m.type === 'user' ? ` ${describeMessage(m.message)}` : m.type === 'assistant' ? ` ${JSON.stringify(m.message.content).slice(0, 90)}` : ''
      events.push(m.type)
      log(`  sdk message: ${m.type}${extra}`)
    }
  })().catch((e) => log('reader error', e.message))

  log(`--- priority: ${priority ?? 'none'}`)
  send('please do the SLOW thing')
  await sleep(2500)
  log('  (sending the second message now: "STEER: use tabs")')
  send('STEER: use tabs', priority)
  await sleep(14000)
  ended = true
  waiting.splice(0).forEach((r) => r())
  try { q.close() } catch { /* already closed */ }
  await reader
  await stub.stop()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* the program may still hold the folder */ }
  log(`  results seen: ${events.filter((e) => e === 'result').length}`)
}

const wanted = process.argv.slice(2)
for (const p of wanted.length ? wanted : ['now', 'next', 'later', 'none']) await trial(p === 'none' ? undefined : p)
process.exit(0)
