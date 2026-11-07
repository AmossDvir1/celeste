/// <reference types="vite/client" />

interface Window {
  /** Provided by the preload script. Absent when the interface runs in a plain browser (`npm run dev:web`). */
  celeste?: import('@shared/bridge').CelesteBridge
}

declare module '*.svg' {
  const url: string
  export default url
}
