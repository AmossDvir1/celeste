import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { searchForWorkspaceRoot } from 'vite'
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

// The fonts' own folders, wherever npm put them. In a git worktree without node_modules of its own they resolve from the
// main checkout, which the dev server would otherwise refuse to serve, and the window would fall back to system fonts.
const fontFolders = ['@fontsource-variable/outfit', '@fontsource-variable/jetbrains-mono'].flatMap((name) => {
  try {
    return [dirname(createRequire(resolve('package.json')).resolve(name))]
  } catch {
    return []
  }
})

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
    server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...fontFolders] } },
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
        '@core': resolve('src/core')
      }
    }
  }
})
