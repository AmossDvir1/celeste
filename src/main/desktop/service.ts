import { app, BrowserWindow, globalShortcut, screen } from 'electron'
import { z } from 'zod'
import {
  blockedKeys,
  DESKTOP_HOTKEY,
  describeScope,
  inScope,
  neverMatches,
  parseKeys,
  pointsOf,
  pressesFocused,
  refuseForCeleste,
  type DesktopAction,
  type DesktopBarState,
  type DesktopResult,
  type DesktopScope,
  type DesktopShot,
  type Inspection,
  type Point,
  type Rect,
  type WindowInfo
} from '@shared/desktop'
import { ControlBar } from './bar'
import { createWindowsDriver, sleep, type InputDriver } from './driver'
import { toScreen, type ShotGeometry } from './geometry'
import { capture, displayOf, type Redaction } from './screen'
import { createWindowsApi, type WinRecord, type WindowsApi } from './windows'

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
const scopeShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screen') }),
  z.object({ kind: z.literal('app'), app: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('window'), id: z.number().int(), title: z.string().max(500), app: z.string().max(100) })
])
const barState = z.object({
  sessionId: z.string(),
  until: z.number(),
  lines: z.array(z.string().max(300)).max(10),
  scope: scopeShape,
  never: z.array(z.string().max(100)).max(50),
  paused: z.string().max(300).nullable()
})
const windowsArg = z.object({ never: z.array(z.string().max(100)).max(50) })
const focusArg = z.object({ id: z.number().int() })

/** How far the mouse may be from where the assistant left it before the person is taken to have moved it. */
const MOVED_PIXELS = 12

export class DesktopService {
  private geometry: ShotGeometry | null = null
  private driver: InputDriver | null = null
  private api: WindowsApi | null = null
  private scope: DesktopScope = { kind: 'screen' }
  private never: string[] = []
  /** Where the mouse was when the assistant last acted, to see whether the person has moved it since. */
  private lastCursor: Point | null = null
  private readonly bar: ControlBar
  private active = false
  private readonly protectNew = (_event: unknown, win: BrowserWindow) => this.protect(win, true)

  constructor(private readonly core: { stop(why: string): void; extend(): void; resume(): void }) {
    this.bar = new ControlBar({
      onStop: () => core.stop('You pressed Stop.'),
      onExtend: () => core.extend(),
      onResume: () => {
        // What the person did with the mouse is theirs: from here the assistant carries on from where the mouse is now.
        this.lastCursor = null
        core.resume()
      }
    })
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
      case 'windows': {
        const parsed = windowsArg.safeParse(arg)
        if (!parsed.success) throw new Error('The request was not valid.')
        return this.windows(parsed.data.never)
      }
      case 'focus': {
        const parsed = focusArg.safeParse(arg)
        if (!parsed.success) throw new Error('The request was not valid.')
        return this.focus(parsed.data.id)
      }
      case 'inspect': {
        const parsed = action.safeParse(arg)
        if (!parsed.success) return {} satisfies Inspection
        return this.inspect(parsed.data as DesktopAction)
      }
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
    this.scope = state.scope
    this.never = state.never
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
    this.lastCursor = null
    this.scope = { kind: 'screen' }
    this.never = []
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

  private windowsApi(): WindowsApi {
    if (!this.api) this.api = createWindowsApi()
    return this.api
  }

  /** Whether the assistant may see and use a window: it is inside the scope and not on the never list. Celeste's own windows never are. */
  private allowed(w: WinRecord): boolean {
    return w.pid !== process.pid && inScope(this.scope, w) && !neverMatches(this.never, w)
  }

  private async screenshot(): Promise<DesktopShot> {
    if (!this.active) throw new Error('Control is not on.')
    const api = this.windowsApi()
    // A browser page only describes itself to Windows after something has asked; asking now means the answers are there when a click needs them.
    api.focusedField()
    const scope = this.scope
    const windows = scope.kind === 'screen' && !this.never.length ? [] : api.list(true).filter((w) => w.pid !== process.pid && !w.minimized)
    let result: Awaited<ReturnType<typeof capture>>
    if (scope.kind === 'screen') {
      const hidden = windows.filter((w) => neverMatches(this.never, w))
      const redaction: Redaction | undefined = hidden.length ? { base: 'show', layers: hidden.reverse().map((w) => ({ rect: w.bounds, show: false })) } : undefined
      result = await capture(screen.getPrimaryDisplay(), undefined, redaction)
    } else {
      if (scope.kind === 'window' && !api.byId(scope.id)) throw new Error(`The window “${scope.title}” is closed, so there is nothing to look at. End control and ask again if you need another window.`)
      const shown = windows.filter((w) => this.allowed(w))
      if (!shown.length) throw new Error(`There is nothing on the screen to see: ${describeScope(scope)} is minimized or not open. Bring it to the front with desktop_focus_window.`)
      const display = displayOf((shown[0] as WinRecord).bounds)
      const onIt = shown.filter((w) => displayOf(w.bounds).id === display.id)
      const left = Math.min(...onIt.map((w) => w.bounds.x))
      const top = Math.min(...onIt.map((w) => w.bounds.y))
      const right = Math.max(...onIt.map((w) => w.bounds.x + w.bounds.width))
      const bottom = Math.max(...onIt.map((w) => w.bounds.y + w.bounds.height))
      // Bottom to top, so a window in front of another one paints over it.
      const layers = [...windows].reverse().map((w) => ({ rect: w.bounds, show: this.allowed(w) }))
      result = await capture(display, scope.kind === 'window' ? { x: left, y: top, width: right - left, height: bottom - top } : undefined, { base: 'hide', layers })
    }
    this.geometry = result.geometry
    return result.shot
  }

  /** The windows the assistant may be told about: not Celeste's, not on the never list, and inside the scope when control is on. */
  private windows(never: string[]): WindowInfo[] {
    const api = this.windowsApi()
    const front = api.foreground()
    return api
      .list()
      .filter((w) => w.pid !== process.pid && !neverMatches(never, w) && (!this.active || this.allowed(w)))
      .map((w) => ({ id: w.id, title: w.title, app: w.app, focused: front?.ownerId === w.id || front?.id === w.id }))
  }

  private focus(id: number): { ok: true; title: string; app: string } | { ok: false; reason: string } {
    if (!this.active) return { ok: false, reason: 'Control is not on.' }
    const w = this.windowsApi().byId(id)
    if (!w) return { ok: false, reason: 'There is no such window any more.' }
    if (w.pid === process.pid) return { ok: false, reason: 'That is a Celeste window. Celeste’s own windows are off limits.' }
    if (neverMatches(this.never, w)) return { ok: false, reason: 'That window is on the list of programs that are never controlled (Settings, Desktop control).' }
    if (!inScope(this.scope, w)) return { ok: false, reason: `That window is outside what you were given: ${describeScope(this.scope)}.` }
    if (!this.windowsApi().focus(id)) return { ok: false, reason: 'Windows did not bring that window to the front. Click on it instead, if it is on the screen.' }
    return { ok: true, title: w.title, app: w.app }
  }

  /** What is under an action: for a click, the name of the button; for typing and for Enter and Space, the field that has the keyboard. */
  private async inspect(a: DesktopAction): Promise<Inspection> {
    if (!this.active) return {}
    const api = this.windowsApi()
    if (a.type === 'click') {
      if (!this.geometry) return {}
      const p = toScreen(a.at, this.geometry)
      return p.ok ? api.elementAt(p.point) : {}
    }
    if (a.type === 'type') {
      // A browser's page only describes itself to the system after it has been asked once, so the first answer can be the empty window.
      const first = api.focusedField()
      await sleep(200)
      const second = api.focusedField()
      return { password: first.password || second.password, label: second.label ?? first.label }
    }
    if (a.type === 'key' && pressesFocused(a.keys)) return api.focusedField()
    return {}
  }

  /** Why an action is outside the scope or on the never list, or null. Where a point is, or who has the keyboard, is asked of Windows now. */
  private refuseForScope(a: DesktopAction, points: Point[]): string | null {
    const scope = this.scope
    if (scope.kind === 'screen' && !this.never.length) return null
    const api = this.windowsApi()
    if (scope.kind === 'window' && !api.byId(scope.id)) return `The window “${scope.title}” has been closed. End control and ask again if you need another window.`
    const judge = (w: WinRecord | null, what: string): string | null => {
      if (!w) return scope.kind === 'screen' ? null : `${what} is not in any window, and you were given ${describeScope(scope)}.`
      if (w.pid === process.pid) return null // Celeste's own windows have their own refusal, which is the same everywhere
      if (neverMatches(this.never, w)) return `${what} is in a program that is never controlled (Settings, Desktop control).`
      if (!inScope(scope, w)) {
        const covered = scope.kind === 'window' && w.id !== scope.id ? ' If something else is in front of it, bring it forward with desktop_focus_window.' : ''
        return `${what} is in “${w.title}” (${w.app}), outside what you were given: ${describeScope(scope)}.${covered}`
      }
      return null
    }
    for (const p of points) {
      const refused = judge(api.at(p), 'That point')
      if (refused) return refused
    }
    if (a.type === 'type' || a.type === 'key') return judge(api.foreground(), 'The keyboard')
    return null
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
    // The person's own hand wins: if they moved the mouse since the last action, nothing more happens until they say to carry on.
    const there = driver.cursor()
    if (this.lastCursor && Math.hypot(there.x - this.lastCursor.x, there.y - this.lastCursor.y) > MOVED_PIXELS) {
      return { ok: false, moved: true, reason: 'The person moved the mouse, so control is paused until they press Continue on the control bar.' }
    }
    const celesteHasFocus = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
    const refused = refuseForCeleste(a, points, {
      celesteRects: this.celesteRects(),
      celesteHasFocus,
      coveredByOther: (p) => {
        try {
          const top = this.windowsApi().at(p)
          return !!top && top.pid !== process.pid
        } catch {
          return false // Not knowing who is on top counts as Celeste.
        }
      }
    })
    if (refused) return { ok: false, reason: refused }
    const outside = this.refuseForScope(a, points)
    if (outside) return { ok: false, reason: outside }

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
    this.lastCursor = driver.cursor()
    return { ok: true }
  }

  private driverOrThrow(): InputDriver {
    if (!this.driver) this.driver = createWindowsDriver()
    return this.driver
  }
}
