import type { CoreMethod, CoreParams, CorePush, CoreResult } from './api'
import type { BrowserCalls, BrowserOp, BrowserState, KeyInput } from './browser'

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
  /** A file the agent made in a chat's private folder: open it, show it in its folder, or save a copy. The window names it by session and path; the main process checks it. */
  chatFile(sessionId: string, path: string, action: 'open' | 'reveal' | 'save'): Promise<{ ok: boolean; message?: string }>
  /** Asks where to save a text file and writes it there. `saved` is the file's name, or null when the person cancels. */
  saveText(suggestedName: string, text: string): Promise<{ saved: string | null }>
  /** Asks for a file to open and reads it as text (at most 1 MB). Null when the person cancels. */
  openText(extensions: string[]): Promise<{ name: string; text: string } | null>
  /** The browser pane: the pages live in the main process, and this tells it what to show and hears what they are doing. */
  browser: {
    call<O extends BrowserOp>(op: O, arg: BrowserCalls[O]['arg']): Promise<BrowserCalls[O]['result']>
    onState(listener: (state: BrowserState) => void): () => void
    /** A key typed in a page that the window handles (Ctrl+K, Ctrl+Shift+B, …). */
    onKey(listener: (key: KeyInput) => void): () => void
    /** The assistant started using the browser in this chat: show it, if that chat is open. */
    onReveal(listener: (chatId: string) => void): () => void
  }
  revealDataFolder(): Promise<void>
  /** Asks the person to choose a folder. Null when they cancel. */
  chooseFolder(): Promise<string | null>
  /** Called when the window or app is closing: save anything unsaved and resolve. */
  onBeforeQuit(handler: () => Promise<void> | void): void
}
