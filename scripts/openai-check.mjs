// `npm run verify:openai`: the OpenAI adapter against the real Codex program and a stand-in for OpenAI's API (no account, no cost).
// The first run downloads the pinned Codex (about 180 MB) the way the app does, into scripts/.output/codex; later runs reuse it.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const run = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/core/adapters/openai'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CELESTE_DOWNLOAD_CODEX: '1' }
})
process.exit(run.status ?? 1)
