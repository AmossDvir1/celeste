import type { CoreMethod, CoreParams, CorePush, CoreResult } from './api'
import type { BrowserCalls, BrowserOp, BrowserState, KeyInput } from './browser'

/** The window's shape: the full window, or the small side window. `pinned` keeps the small one above other windows. */
export interface LayoutState {
  compact: boolean
  pinned: boolean
}

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
  chatFile(sessionId: string, path: string, action: 'open' | 'reveal' | 'save' | 'preview'): Promise<{ ok: boolean; message?: string }>
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
  /** The window's shape (docs/TRAY_AND_COMPACT_PLAN.md, Part 2). Changing it resizes and moves the window itself. */
  layout: {
    get(): Promise<LayoutState>
    set(patch: Partial<LayoutState>): Promise<LayoutState>
    /** Switches to the other shape, from the shape the window is going to have (not the one the page still shows while it moves). */
    toggle(): Promise<LayoutState>
    /** The shape changed: from the button, the shortcut, the tray menu, or because the window was maximised. */
    onChange(listener: (state: LayoutState) => void): () => void
    /** The window starts to change shape (it is animated): the page fades out until the new shape arrives through `onChange`. */
    onStart(listener: () => void): () => void
  }
  /** Starting Celeste when the person signs in, so schedules keep running. `available` is false where it cannot be done (not the installed Windows app). */
  loginItem: {
    get(): Promise<{ available: boolean; enabled: boolean }>
    set(on: boolean): Promise<{ available: boolean; enabled: boolean }>
  }
  /** A notification was clicked while Celeste was in the tray: open the chat or the workflow run it was about (`schedules`: the list of schedules, for one that paused itself). */
  onOpen(listener: (target: { kind: 'chat' | 'run' | 'schedules'; target: string }) => void): () => void
  revealDataFolder(): Promise<void>
  /** Asks the person to choose a folder. Null when they cancel. */
  chooseFolder(): Promise<string | null>
  /** Called when the window or app is closing: save anything unsaved and resolve. */
  onBeforeQuit(handler: () => Promise<void> | void): void
}
