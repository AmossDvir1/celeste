import { app, BrowserWindow, globalShortcut, screen } from 'electron'
import { z } from 'zod'
import { blockedKeys, DESKTOP_HOTKEY, parseKeys, pointsOf, refuseForCeleste, type DesktopAction, type DesktopBarState, type DesktopResult, type DesktopShot, type Rect } from '@shared/desktop'
import { ControlBar } from './bar'
import { createWindowsDriver, sleep, type InputDriver } from './driver'
import { toScreen, type ShotGeometry } from './geometry'
import { captureMain } from './screen'

/*
 * The real computer, for Core's desktop tools (see src/core/desktop/control.ts). Core decides whether the assistant may act, and for how
 * long. This side does the acting, and refuses on its own account whatever would touch Celeste's own windows, so that holds even if
 * something upstream were wrong. It also shows the control bar and listens for the stop key.
 */

const point = z.object({ x: z.number().finite(), y: z.number().finite() })
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), at: point }),
  z.object({ type: z.literal('click'), at: point, button: z.enum(['left', 'right', 'middle']), count: z.union([z.literal(1), z.literal(2)]) }),
  z.object({ type: z.literal('drag'), from: point, to: point }),
  z.object({ type: z.literal('scroll'), at: point, dx: z.number().int().min(-20).max(20), dy: z.number().int().min(-20).max(20) }),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('key'), keys: z.string().min(1).max(60) })
])
const barState = z.object({ sessionId: z.string(), until: z.number(), lines: z.array(z.string().max(300)).max(10) })

export class DesktopService {
  private geometry: ShotGeometry | null = null
  private driver: InputDriver | null = null
  private readonly bar: ControlBar
  private active = false
  private readonly protectNew = (_event: unknown, win: BrowserWindow) => this.protect(win, true)

  constructor(private readonly core: { stop(why: string): void; extend(): void }) {
    this.bar = new ControlBar({ onStop: () => core.stop('You pressed Stop.'), onExtend: () => core.extend() })
  }

  /** Why control cannot work here, or null. */
  unsupported(): string | null {
    if (process.platform !== 'win32') return 'Desktop control works on Windows for now. macOS and Linux come later.'
    return null
  }

  /** Core asks: a screenshot, an action, or the bar. Anything else is refused. */
  async handle(method: string, arg: unknown): Promise<unknown> {
    switch (method) {
      case 'unsupported':
        return this.unsupported()
      case 'screenshot':
        return this.screenshot()
      case 'act': {
        const parsed = action.safeParse(arg)
        if (!parsed.success) return { ok: false, reason: 'The action was not valid.' } satisfies DesktopResult
        return this.act(parsed.data as DesktopAction)
      }
      case 'bar': {
        if (arg === null) {
          this.end()
          return null
        }
        const parsed = barState.safeParse(arg)
        if (!parsed.success) throw new Error('The bar state was not valid.')
        await this.begin(parsed.data)
        return null
      }
      default:
        throw new Error(`Unknown desktop call ${method}.`)
    }
  }

  /** Control is over, or Core went away: take everything down. */
  reset(): void {
    this.end()
  }

  /** Celeste is closing or its last window went: end control in Core too (which records it), and take everything down here. */
  stopAll(why: string): void {
    if (!this.active) return
    this.core.stop(why)
    this.end()
  }

  /** One of the bar's own windows, which are not "a window of Celeste" for deciding whether Celeste is still open. */
  owns(win: BrowserWindow): boolean {
    return this.bar.windows().includes(win) || this.bar.isBorder(win)
  }

  // --- the bar and the stop key ----------------------------------------------------------------------

  private async begin(state: DesktopBarState): Promise<void> {
    if (!this.active) {
      // The stop key first: control is never on if it cannot be stopped from the keyboard.
      if (!globalShortcut.register(DESKTOP_HOTKEY, () => this.core.stop('You pressed the stop key.'))) {
        throw new Error(`The stop key ${DESKTOP_HOTKEY.replace('Control', 'Ctrl')} is taken by another program, so control cannot start.`)
      }
      this.active = true
      for (const win of BrowserWindow.getAllWindows()) this.protect(win, true)
      app.on('browser-window-created', this.protectNew)
    }
    try {
      await this.bar.show(state)
    } catch (err) {
      this.end()
      throw err
    }
  }

  private end(): void {
    if (!this.active && !this.bar.windows().length) return
    this.active = false
    this.geometry = null
    globalShortcut.unregister(DESKTOP_HOTKEY)
    app.off('browser-window-created', this.protectNew)
    this.bar.hide()
    for (const win of BrowserWindow.getAllWindows()) this.protect(win, false)
  }

  /** Windows that are protected are left out of screen capture, so the assistant cannot see Celeste's own windows. */
  private protect(win: BrowserWindow, on: boolean): void {
    if (!win.isDestroyed()) win.setContentProtection(on)
  }

  // --- seeing and doing ------------------------------------------------------------------------------

  private async screenshot(): Promise<DesktopShot> {
    if (!this.active) throw new Error('Control is not on.')
    const { shot, geometry } = await captureMain()
    this.geometry = geometry
    return shot
  }

  /** Celeste's own windows, in screen pixels. The border is left out: it lets every click through. */
  private celesteRects(): Rect[] {
    const rects: Rect[] = []
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || this.bar.isBorder(win)) continue
      rects.push(screen.dipToScreenRect(null, win.getBounds()))
    }
    return rects
  }

  private async act(a: DesktopAction): Promise<DesktopResult> {
    if (!this.active) return { ok: false, reason: 'Control is not on.' }
    const driver = this.driverOrThrow()

    // Pointer actions are aimed in the last screenshot's pixels.
    const aimed = pointsOf(a)
    const points = []
    if (aimed.length) {
      if (!this.geometry) return { ok: false, reason: 'Take a screenshot first: points are given in its pixels.' }
      for (const p of aimed) {
        const r = toScreen(p, this.geometry)
        if (!r.ok) return r
        points.push(r.point)
      }
    }
    if (a.type === 'key') {
      const keys = parseKeys(a.keys)
      if (!keys.ok) return { ok: false, reason: keys.reason }
      const blocked = blockedKeys(keys)
      if (blocked) return { ok: false, reason: blocked }
    }
    const celesteHasFocus = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
    const refused = refuseForCeleste(a, points, { celesteRects: this.celesteRects(), celesteHasFocus })
    if (refused) return { ok: false, reason: refused }

    try {
      switch (a.type) {
        case 'move':
          driver.move(points[0] as { x: number; y: number })
          break
        case 'click': {
          driver.move(points[0] as { x: number; y: number })
          await sleep(40)
          for (let i = 0; i < a.count; i++) {
            if (i) await sleep(60)
            driver.button(a.button, true)
            await sleep(25)
            driver.button(a.button, false)
          }
          break
        }
        case 'drag': {
          const [from, to] = points as [{ x: number; y: number }, { x: number; y: number }]
          driver.move(from)
          await sleep(50)
          driver.button('left', true)
          const steps = 12
          try {
            for (let i = 1; i <= steps; i++) {
              driver.move({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps })
              await sleep(12)
            }
          } finally {
            // The button is always let go, or it stays held down on the person's computer.
            driver.button('left', false)
          }
          break
        }
        case 'scroll':
          driver.move(points[0] as { x: number; y: number })
          await sleep(30)
          driver.wheel(a.dx, a.dy)
          break
        case 'type':
          await driver.text(a.text)
          break
        case 'key': {
          const keys = parseKeys(a.keys) as Extract<ReturnType<typeof parseKeys>, { ok: true }>
          await driver.keys(keys.mods, keys.key)
          break
        }
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true }
  }

  private driverOrThrow(): InputDriver {
    if (!this.driver) this.driver = createWindowsDriver()
    return this.driver
  }
}
