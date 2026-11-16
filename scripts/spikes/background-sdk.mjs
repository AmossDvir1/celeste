// SPIKE (15 November 2026), not a check: what Claude Code's own background Bash does inside an SDK session like Celeste's (open input,
// one query, the stand-in API). Results are in docs/plans/BACKGROUND_RUNS_PLAN.md. Run: node scripts/spikes/background-sdk.mjs
// Spike: what does Claude Code's own background Bash do inside an SDK session like Celeste's (open input, one query)?
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { startStub } from '../lib/stub.mjs'

const root = resolve(import.meta.dirname, '..', '..').replaceAll('\\', '/')
const require = createRequire(root + '/package.json')
const sdk = await import('file:///' + require.resolve('@anthropic-ai/claude-agent-sdk').replace(/\\/g, '/'))
const exe = root + '/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'

const dir = mkdtempSync(join(tmpdir(), 'bgspike-'))
const marker1 = join(dir, 'done1.txt').replace(/\\/g, '/')
const marker2 = join(dir, 'done2.txt').replace(/\\/g, '/')
const cmd = (m, s) => `node -e "setTimeout(()=>{require('fs').writeFileSync('${m}','x');console.log('finished')},${s})"`

const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const log = (...a) => console.log(at(), ...a)

const stub = await startStub((r) => {
  const last = r.last
  if (last.kind === 'text' && last.text.includes('START1')) return [{ type: 'tool_use', name: 'Bash', input: { command: cmd(marker1, 6000), run_in_background: true, description: 'wait six seconds' } }]
  if (last.kind === 'text' && last.text.includes('START2')) return [{ type: 'tool_use', name: 'Bash', input: { command: cmd(marker2, 8000), run_in_background: true, description: 'wait eight seconds' } }]
  if (last.kind === 'tool_result') return [{ type: 'text', text: `Started it. (tool result was: ${last.text.slice(0, 120).replace(/\n/g, ' ')})` }]
  if (last.kind === 'text') return [{ type: 'text', text: `Saw: ${last.text.slice(0, 200).replace(/\n/g, ' ')}` }]
  return [{ type: 'text', text: 'ok' }]
})

// An open-input stream like Celeste's EventQueue.
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
const send = (text) => {
  queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
  waiting.splice(0).forEach((r) => r())
}

const q = sdk.query({
  prompt: input,
  options: {
    cwd: dir,
    pathToClaudeCodeExecutable: exe,
    env: { ...process.env, ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: 'sk-ant-api03-spike-1234', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    permissionMode: 'default',
    canUseTool: async (name, input) => {
      log('canUseTool', name, JSON.stringify(input).slice(0, 140))
      return { behavior: 'allow', updatedInput: input }
    },
    includePartialMessages: false,
    settingSources: []
  }
})

let results = 0
const reader = (async () => {
  for await (const m of q) {
    const sub = m.subtype ? `/${m.subtype}` : ''
    if (m.type === 'system' && m.subtype === 'init') continue
    if (m.type === 'stream_event') continue
    let extra = ''
    if (m.type === 'system' && m.subtype?.startsWith('task_')) extra = ` task=${m.task_id} status=${m.status ?? ''} summary=${(m.summary ?? m.description ?? '').slice(0, 80)}`
    if (m.type === 'system' && m.subtype === 'background_tasks_changed') extra = ` tasks=${m.tasks.length}`
    if (m.type === 'assistant') extra = ' ' + JSON.stringify(m.message.content).slice(0, 160)
    if (m.type === 'user') extra = ' ' + JSON.stringify(m.message.content).slice(0, 200)
    if (m.type === 'result') { results++; extra = ` result="${(m.result ?? '').slice(0, 100)}"` }
    log(`msg ${m.type}${sub}${extra}`)
  }
})().catch((e) => log('reader error', e.message))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

log('--- TEST 1: start a background command, let the turn end, wait for it to finish')
send('please START1')
await sleep(16000)
log('marker1 exists (command ran to completion):', existsSync(marker1))
const reqsAfter1 = stub.main.length
log('API requests so far:', reqsAfter1, '| last texts:', stub.main.slice(-3).map((r) => r.last.kind + ':' + r.last.text.slice(0, 90).replace(/\n/g, ' ')).join(' || '))

log('--- TEST 2: start another, then interrupt the turn (the Stop button) while it runs')
send('please START2')
await sleep(4000)
log('calling interrupt()')
await q.interrupt().catch((e) => log('interrupt error', e.message))
await sleep(12000)
log('marker2 exists (survived the interrupt):', existsSync(marker2))

ended = true
waiting.splice(0).forEach((r) => r())
try { q.close() } catch {}
await stub.stop()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* the program may still hold the folder */ }
log('done; results seen:', results)
process.exit(0)
