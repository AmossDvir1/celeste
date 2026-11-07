import type { CoreMethod, CoreParams, CorePush, CoreResult } from './api'

/** What the preload script gives the window as `window.celeste`. Absent in a plain browser. */
export interface CelesteBridge {
  platform: string
  setTheme(payload: { color: string; symbolColor: string }): void
  /** The line to Core (database, sessions, settings). */
  core: {
    call<M extends CoreMethod>(method: M, params: CoreParams<M>): Promise<Awaited<CoreResult<M>>>
    onPush(listener: (push: CorePush) => void): () => void
  }
  /** Keys and tokens. They can be stored and removed here, never read back. */
  secrets: {
    available(): Promise<boolean>
    set(name: string, value: string): Promise<void>
    remove(name: string): Promise<void>
    has(name: string): Promise<boolean>
    /** The last four characters, to tell two keys apart. */
    hint(name: string): Promise<string | null>
  }
  revealDataFolder(): Promise<void>
  /** Called when the window or app is closing: save anything unsaved and resolve. */
  onBeforeQuit(handler: () => Promise<void> | void): void
}
