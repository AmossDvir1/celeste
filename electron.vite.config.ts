import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The strict policy lives in index.html. The dev server needs inline scripts for hot reload,
// so serve mode swaps in a relaxed policy.
const devCsp = {
  name: 'celeste-dev-csp',
  apply: 'serve' as const,
  transformIndexHtml: (html: string) =>
    html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: celeste-file:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*" />`
    )
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // Two programs: the main process, and the Core process it starts (database, sessions, the assistant).
      rollupOptions: { input: { index: resolve('src/main/index.ts'), core: resolve('src/core/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss(), devCsp],
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
        '@core': resolve('src/core')
      }
    }
  }
})
