// SPIKE (16 November 2026), not a check: what Stop (the SDK's interrupt) does to a command running in the background, with and without
// the option `perTaskStopAffordance`, and whether `stopTask(taskId)` stops one command. Results are in docs/plans/BACKGROUND_RUNS_PLAN.md.
// Run: node scripts/spikes/background-stop.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { startStub } from '../lib/stub.mjs'

const root = resolve(import.meta.dirname, '..', '..').replaceAll('\\', '/')
const require = createRequire(root + '/package.json')
const sdk = await import('file:///' + require.resolve('@anthropic-ai/claude-agent-sdk').replaceAll('\\', '/'))
const exe = root + '/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function trial(label, { affordance, how }) {
  const dir = mkdtempSync(join(tmpdir(), 'bgstop-'))
  const marker = join(dir, 'done.txt').replaceAll('\\', '/')
  const stub = await startStub((r) => {
    const last = r.last
    if (last.kind === 'text' && last.text.includes('START')) return [{ type: 'tool_use', name: 'Bash', input: { command: `node -e "setTimeout(()=>{require('fs').writeFileSync('${marker}','x')},8000)"`, run_in_background: true, description: 'wait eight seconds' } }]
    if (last.kind === 'text' && last.text.includes('HOLD')) return [{ type: 'hold' }]
    if (last.kind === 'tool_result') return [{ type: 'text', text: 'Started it.' }]
    return [{ type: 'text', text: 'Noted.' }]
  })
  const waiting = []
  const queue = []
  let ended = false
  const input = { async *[Symbol.asyncIterator]() { while (!ended) { if (queue.length) yield queue.shift(); else await new Promise((r) => waiting.push(r)) } } }
  const send = (text) => { queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }); waiting.splice(0).forEach((r) => r()) }
  const q = sdk.query({
    prompt: input,
    options: {
      cwd: dir,
      pathToClaudeCodeExecutable: exe,
      env: { ...process.env, ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: 'sk-ant-api03-spike-1234', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      permissionMode: 'default',
      canUseTool: async (_name, i) => ({ behavior: 'allow', updatedInput: i }),
      settingSources: [],
      ...(affordance ? { perTaskStopAffordance: true } : {})
    }
  })
  let taskId
  const statuses = []
  void (async () => {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'task_started') taskId = m.task_id
      if (m.type === 'system' && m.subtype === 'task_notification') statuses.push(m.status)
    }
  })().catch(() => undefined)
  send('START it')
  await sleep(4000)
  if (how === 'interrupt') {
    send('HOLD this turn')
    await sleep(2500)
    await q.interrupt().catch((e) => console.log('interrupt error', e.message))
  } else {
    await q.stopTask(taskId).catch((e) => console.log('stopTask error', e.message))
  }
  await sleep(11000)
  console.log(`${label}: command survived (marker written): ${existsSync(marker)} | notifications: ${JSON.stringify(statuses)}`)
  ended = true
  waiting.splice(0).forEach((r) => r())
  try { q.close() } catch { /* already closed */ }
  await stub.stop()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* the program may still hold the folder */ }
}

await trial('Stop during a turn, no per-task affordance ', { affordance: false, how: 'interrupt' })
await trial('Stop during a turn, perTaskStopAffordance  ', { affordance: true, how: 'interrupt' })
await trial('stopTask(taskId) on its own               ', { affordance: true, how: 'stopTask' })
process.exit(0)
