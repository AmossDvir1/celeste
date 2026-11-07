/// <reference types="vite/client" />

interface CelesteBridge {
  platform: string
  setTheme(payload: { color: string; symbolColor: string }): void
}

interface Window {
  celeste?: CelesteBridge
}

declare module '*.svg' {
  const url: string
  export default url
}
