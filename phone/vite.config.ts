import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The phone app shares the desktop's protocol, types and event reducer (src/shared, src/renderer/stores/reduce.ts),
// so a conversation looks the same on the phone as on the computer.
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@shared': at('../src/shared'),
      '@': at('../src/renderer')
    },
    // A desktop component used here (the vendors' marks) must get the app's own React, not a second copy.
    dedupe: ['react', 'react-dom']
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome120' },
  server: { host: true, port: 5180 }
})
