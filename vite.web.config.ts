// Renderer only, in a plain browser. Handy for quick visual checks: `npm run dev:web`.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve('src/renderer'),
      '@shared': resolve('src/shared')
    }
  },
  server: { port: 5199, strictPort: true }
})
