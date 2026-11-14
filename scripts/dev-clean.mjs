// `npm run dev:clean` starts the app in development with a brand-new profile, so the setup wizard opens as it does for a first-time user.
//
// - Nothing from your real profile is used: no settings, no saved sessions, no keys, no connected vendors.
// - Copilot is given a data folder of its own that knows no one, and programs already installed on this computer (Copilot CLI,
//   Claude Code) are ignored, so no sign-in on this PC is touched or counted.
// - The folder is deleted when you close the app. `npm run dev:clean -- --keep` keeps it and prints where it is, and
//   `npm run dev:clean -- --profile <folder>` starts from (or goes back to) a folder you name, which is never deleted.
//
// Your normal `npm run dev` window can stay open: it uses another profile folder.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const named = args.indexOf('--profile') >= 0 ? args[args.indexOf('--profile') + 1] : undefined
if (args.includes('--profile') && !named) {
  console.error('--profile needs a folder, for example: npm run dev:clean -- --profile D:\\celeste-test')
  process.exit(1)
}

const profile = named ? resolve(named) : mkdtempSync(join(tmpdir(), 'celeste-clean-'))
console.log(`Clean profile: ${profile}${named || keep ? ' (kept when you close the app)' : ' (deleted when you close the app)'}`)

const child = spawn(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', '--', `--user-data-dir=${profile}`], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CELESTE_COPILOT_ISOLATED: '1', CELESTE_NO_OWN_PROGRAMS: '1', CELESTE_RELAY_URL: '' }
})

let done = false
const finish = (code) => {
  if (done) return
  done = true
  if (!named && !keep) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  process.exit(code ?? 0)
}
child.on('exit', finish)
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
