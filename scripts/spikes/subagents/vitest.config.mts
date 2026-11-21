import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Only for the sub-agents spike (docs/plans/SUB_AGENTS_PLAN.md, step 0): long timeouts, and only this folder.
const root = resolve(import.meta.dirname, '..', '..', '..')
export default defineConfig({
  root,
  resolve: { alias: { '@': resolve(root, 'src/renderer'), '@shared': resolve(root, 'src/shared'), '@core': resolve(root, 'src/core') } },
  test: { environment: 'node', include: ['scripts/spikes/subagents/*.spike.test.ts'], testTimeout: 30 * 60_000, hookTimeout: 120_000 }
})
