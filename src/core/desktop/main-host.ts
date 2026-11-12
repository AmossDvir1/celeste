import type { DesktopAction, DesktopBarState, DesktopResult, DesktopShot, ElementsResult, Inspection, ResolveResult, WindowInfo } from '@shared/desktop'
import type { DesktopHost } from './control'

/**
 * The desktop host as Core sees it: the real one lives in the main process (the screen, the input, the windows), and this asks it over
 * the line Core already has to the main process.
 */
export class MainDesktopHost implements DesktopHost {
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
    else w.reject(new Error(message.error ?? 'The desktop call failed.'))
  }

  private call<T>(method: string, arg?: unknown, timeoutMs = 20_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('The computer did not answer in time.'))
      }, timeoutMs)
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.post({ type: 'desktop-call', id, method, arg })
    })
  }

  unsupported(): Promise<string | null> {
    return this.call<string | null>('unsupported')
  }

  screenshot(): Promise<DesktopShot> {
    return this.call<DesktopShot>('screenshot')
  }

  act(action: DesktopAction): Promise<DesktopResult> {
    return this.call<DesktopResult>('act', action, 30_000)
  }

  windows(never: string[]): Promise<WindowInfo[]> {
    return this.call<WindowInfo[]>('windows', { never })
  }

  focus(id: number): Promise<{ ok: true; title: string; app: string } | { ok: false; reason: string }> {
    return this.call('focus', { id })
  }

  inspect(action: DesktopAction): Promise<Inspection> {
    return this.call<Inspection>('inspect', action)
  }

  elements(windowId?: number): Promise<ElementsResult> {
    return this.call<ElementsResult>('elements', { window: windowId }, 30_000)
  }

  resolve(id: number): Promise<ResolveResult> {
    return this.call<ResolveResult>('resolve', { id })
  }

  /** The computer's screen as video for a phone (src/main/desktop/watch.ts): answers the phone's offer. */
  watchStart(phoneId: string, offer: string, servers: { urls: string[]; username?: string; credential?: string }[]): Promise<string> {
    return this.call<string>('watch.start', { phoneId, offer, servers }, 30_000)
  }

  async watchStop(phoneId?: string): Promise<void> {
    await this.call('watch.stop', phoneId ?? null)
  }

  async bar(state: DesktopBarState | null): Promise<void> {
    await this.call('bar', state)
  }
}
