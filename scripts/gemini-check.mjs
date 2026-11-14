// `npm run verify:gemini`: the Gemini adapter against the real Gemini CLI and a stand-in for Google's API (no account, no key, no cost).
// The first run downloads the pinned Gemini CLI (19 MB) the way the app does, into scripts/.output/gemini; later runs reuse it.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const run = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/core/adapters/gemini'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CELESTE_DOWNLOAD_GEMINI: '1' }
})
process.exit(run.status ?? 1)
