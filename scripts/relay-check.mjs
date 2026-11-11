// The real relay (relay/src/worker.ts), run locally in Cloudflare's own runtime (wrangler dev, no account needed), with
// the computer's bridge and a stand-in phone talking through it: the same scenarios as src/core/phone/relay.test.ts.
//   npm run verify:relay        (first: npm --prefix relay install)
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const relayDir = join(root, 'relay')
const wrangler = join(relayDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
if (!existsSync(wrangler)) {
  console.error('Install the relay’s tools first: npm --prefix relay install')
  process.exit(1)
}

const port = 8700 + Math.floor(Math.random() * 200)
const worker = spawn(process.execPath, [wrangler, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--show-interactive-dev-session=false'], {
  cwd: relayDir,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
worker.stdout.on('data', (d) => (log += d))
worker.stderr.on('data', (d) => (log += d))
const stop = () => {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' })
  else worker.kill('SIGTERM')
}

let up = false
for (let i = 0; i < 120 && !up && worker.exitCode === null; i++) {
  await new Promise((r) => setTimeout(r, 500))
  up = await fetch(`http://127.0.0.1:${port}/`).then(
    (r) => r.ok,
    () => false
  )
}
if (!up) {
  console.error(`The relay did not start.\n${log}`)
  stop()
  process.exit(1)
}
console.log(`The relay is running locally on port ${port}.`)

const tests = spawn(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/core/phone/relay.test.ts', '--reporter=verbose'], {
  cwd: root,
  env: { ...process.env, CELESTE_RELAY_TEST_URL: `ws://127.0.0.1:${port}` },
  stdio: 'inherit'
})
tests.on('exit', (code) => {
  stop()
  if (code !== 0) console.error(`\nThe relay’s own output:\n${log}`)
  process.exit(code ?? 1)
})
