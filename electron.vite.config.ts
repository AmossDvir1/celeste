import { cpSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
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

// The canvas (docs/plans/CHAT_DISPLAY_PLAN.md, section 11b). Excalidraw lists its own CDN (esm.sh) after the local address for every font: under
// the page's policy each of those is a blocked request, hundreds of them, so the address is turned into one that cannot be reached. Its fonts are
// served from the app's own folder (`fonts/`, found by the page through `window.EXCALIDRAW_ASSET_PATH`), without the Chinese one (13 MB).
// A new version of the library must be tried again: `npm run verify:canvas` fails when the blocked requests come back.
const excalidrawFonts = (() => {
  try {
    return join(dirname(createRequire(resolve('package.json')).resolve('@excalidraw/excalidraw')), 'fonts')
  } catch {
    return ''
  }
})()
const keepFont = (path: string) => !/Xiaolai/.test(path)
// It also subsets each font to the letters used when it makes an SVG, with a worker and a WebAssembly step that the policy refuses (the worker does
// not start, and the step needs `eval`): each export then reported a violation. The step is skipped, and the whole font file goes into the SVG instead.
const SUBSET = /(=async\((\w+),\w+\)=>\{let\{Commands:\w+,subsetToBase64:\w+,toBase64:(\w+)\}=await \w+\(\);)return /
let cdnCut = false
let subsetOff = false
let building = false
const canvasAssets = {
  name: 'celeste-canvas-assets',
  configResolved(config: { command: string }) {
    building = config.command === 'build'
  },
  transform(code: string) {
    let out = code
    if (out.includes('https://esm.sh/')) {
      out = out.replaceAll('https://esm.sh/', 'file:///excalidraw-cdn-is-off/')
      cdnCut = true
    }
    if (SUBSET.test(out)) {
      out = out.replace(SUBSET, '$1return $3($2);')
      subsetOff = true
    }
    return out === code ? null : out
  },
  closeBundle() {
    // A version of the library that changed these places must be looked at again, not shipped with the old behaviour.
    if (building && (!cdnCut || !subsetOff)) throw new Error(`Excalidraw's code is not what the canvas build expects (CDN cut: ${cdnCut}, subsetting off: ${subsetOff}). Try the canvas again: npm run verify:canvas.`)
    if (excalidrawFonts && existsSync(excalidrawFonts)) cpSync(excalidrawFonts, resolve('out/renderer/fonts'), { recursive: true, filter: keepFont })
  },
  // The dev server has no `out` folder: it serves the same files itself.
  configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void; statusCode: number }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const m = /^\/fonts\/([^?#]+)/.exec(req.url ?? '')
      const file = m && excalidrawFonts ? resolve(excalidrawFonts, decodeURIComponent(m[1] as string)) : ''
      if (!file || !file.startsWith(excalidrawFonts) || !keepFont(file) || !existsSync(file) || !statSync(file).isFile()) return next()
      res.setHeader('Content-Type', 'font/woff2')
      res.end(readFileSync(file))
    })
  }
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
    // Two pages: the app, and the viewer that shows files (docs/FILE_VIEWER_PLAN.md), which runs apart from the app.
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), viewer: resolve('src/renderer/viewer.html') } } },
    plugins: [react(), tailwindcss(), devCsp, canvasAssets],
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
