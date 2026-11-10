import type { HostTab } from '@shared/browser'

/** What Core's browser tools need from the main process, which owns the pages. */
export interface BrowserHost {
  /** Where Playwright connects (a key is in it), or null while the browser is not ready. */
  endpoint(): Promise<string | null>
  /** This chat's tabs. Every page is attached first, so each has the id its page is found by. */
  tabs(chatId: string): Promise<HostTab[]>
  /** Opens a tab for the chat (and shows it). With no address it starts blank. Returns its id. */
  newTab(chatId: string, url?: string): Promise<string>
  /** Shows a tab. A tab that was put away gets its page back. */
  selectTab(id: string): Promise<void>
  closeTab(id: string): Promise<void>
  /** Shows the browser beside the chat, if the person has that chat open. */
  reveal(chatId: string): Promise<void>
}

/** The browser host as Core sees it: the real one lives in the main process, and this asks it over the line Core already has to it. */
export class MainBrowserHost implements BrowserHost {
  private next = 0
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly post: (message: unknown) => void) {}

  /** The main process answered. */
  reply(message: { id?: number; ok?: boolean; result?: unknown; error?: string }): void {
    if (typeof message.id !== 'number') return
    const w = this.waiting.get(message.id)
    if (!w) return
    this.waiting.delete(message.id)
    clearTimeout(w.timer)
    if (message.ok) w.resolve(message.result)
    else w.reject(new Error(message.error ?? 'The browser call failed.'))
  }

  private call<T>(method: string, arg?: unknown, timeoutMs = 20_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('The browser did not answer in time.'))
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.post({ type: 'browser-call', id, method, arg })
    })
  }

  endpoint(): Promise<string | null> {
    return this.call<string | null>('endpoint')
  }
  tabs(chatId: string): Promise<HostTab[]> {
    return this.call<HostTab[]>('tabs', { chatId })
  }
  newTab(chatId: string, url?: string): Promise<string> {
    return this.call<string>('newTab', { chatId, ...(url ? { url } : {}) })
  }
  async selectTab(id: string): Promise<void> {
    await this.call('selectTab', { id })
  }
  async closeTab(id: string): Promise<void> {
    await this.call('closeTab', { id })
  }
  async reveal(chatId: string): Promise<void> {
    await this.call('reveal', { chatId })
  }
}
