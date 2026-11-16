import { cpSync } from 'node:fs'
import { defineConfig } from 'vite'

// SPIKE: builds the test page the way the app's bundler would (separate lazy chunk) and copies Excalidraw's fonts beside it.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 100000 },
  plugins: [
    {
      // Excalidraw lists its own CDN (esm.sh) after the local address as a fallback for every font. Under the policy each of those is a blocked
      // request (nothing leaves, but it is hundreds of console errors), so the address is turned into one that cannot be reached.
      name: 'no-excalidraw-cdn',
      transform(code) {
        return code.includes('https://esm.sh/') ? code.replaceAll('https://esm.sh/', 'file:///excalidraw-cdn-is-off/') : null
      }
    },
    {
      name: 'copy-excalidraw-fonts',
      closeBundle() {
        // No Chinese (the 13 MB Xiaolai font) and no fonts of the other editor styles Celeste will not offer: see the plan.
        cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'dist/fonts', { recursive: true, filter: (src) => !/Xiaolai/.test(src) })
      }
    }
  ]
})
