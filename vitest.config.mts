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
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
