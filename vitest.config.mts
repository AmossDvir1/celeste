import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer'),
      '@shared': resolve('src/shared'),
      '@core': resolve('src/core')
    }
  },
  // The SSH tests do real key exchanges, which can take a few seconds when the machine is busy with other test files.
  test: { environment: 'node', include: ['src/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 30_000 }
})
