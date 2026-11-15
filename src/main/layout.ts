import { readFileSync, writeFileSync } from 'node:fs'
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { LayoutState } from '@shared/bridge'
import { centred, COMPACT, compactBounds, ease, fitOnScreen, FULL, lerpRect, MORPH } from './compact'

interface Saved {
  compact: boolean
  pinned: boolean
  /** Where the compact window was last left. */
  bounds?: Rectangle
}

/**
 * The window's two shapes: the full window, and the small side window (docs/TRAY_AND_COMPACT_PLAN.md, Part 2). It is one window that
 * changes size, place and minimum size, so the open chat, the drafts and everything else stay as they are. The shape is remembered
 * in a small file: the place the compact window was left, and its pin. Celeste always starts as the full window.
 *
 * The change is a short animation: the page fades out, the window moves and resizes, and the page (now in its new layout) fades in.
 * The page is told when the change starts (`celeste:layout-start`) and when it is done (`celeste:layout`, with the new shape), so it
 * never has to draw its layouts at sizes between the two.
 */
export class LayoutService {
  private saved: Saved = { compact: false, pinned: true }
  private full: { bounds: Rectangle; maximized: boolean } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The animation in progress: its two timers, so a second change can stop it. */
  private fade: ReturnType<typeof setTimeout> | null = null
  private frames: ReturnType<typeof setInterval> | null = null
  private moving = false

  constructor(
    private readonly file: string,
    /** The shape changed, so anything that shows it (the tray menu) can look again. */
    private readonly changed: () => void = () => undefined
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
      const b = raw.bounds
      this.saved = {
        // Celeste always starts as the full window, whatever shape it was closed in; only the pin and the place of the small one are kept.
        compact: false,
        pinned: raw.pinned !== false,
        ...(b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) ? { bounds: b } : {})
      }
    } catch {
      /* first start, or a file that cannot be read: the full window, pinned when it is made small */
    }
  }

  state(): LayoutState {
    return { compact: this.saved.compact, pinned: this.saved.pinned }
  }

  /** The height the native window buttons are drawn to, so they match the top bar of the shape the window has. */
  barHeight(): number {
    return this.saved.compact ? COMPACT.barHeight : FULL.barHeight
  }

  /** A window has just been made: it starts as the full window, and from now on is watched for where it is left. */
  restore(win: BrowserWindow): void {
    this.watch(win)
  }

  /** Changes the shape, or the pin. Returns the state the window will have. The page hears of the new shape when the change is done. */
  set(win: BrowserWindow, patch: { compact?: boolean; pinned?: boolean }): LayoutState {
    if (typeof patch.pinned === 'boolean') {
      this.saved.pinned = patch.pinned
      if (this.saved.compact) win.setAlwaysOnTop(patch.pinned, 'floating')
    }
    const reshape = typeof patch.compact === 'boolean' && patch.compact !== this.saved.compact
    if (reshape) {
      if (patch.compact) this.enter(win)
      else this.leave(win)
    }
    this.write()
    if (!reshape) this.tell(win)
    return this.state()
  }

  private enter(win: BrowserWindow): void {
    // Going back and forth quickly: the full size is the one already known, not wherever the window is halfway.
    if (!this.moving || !this.full) this.full = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
    if (win.isMaximized()) win.unmaximize()
    this.saved.compact = true
    win.setMinimumSize(COMPACT.minWidth, COMPACT.minHeight)
    const areas = screen.getAllDisplays().map((d) => d.workArea)
    const here = screen.getDisplayMatching(win.getBounds()).workArea
    const target = this.saved.bounds ? fitOnScreen(this.saved.bounds, areas) : compactBounds(here)
    win.setAlwaysOnTop(this.saved.pinned, 'floating')
    this.morph(win, target, () => {
      this.saved.bounds = target
      this.write()
      this.bar(win)
      this.tell(win)
    })
  }

  private leave(win: BrowserWindow): void {
    this.saved.compact = false
    win.setAlwaysOnTop(false)
    const full = this.full
    const target = full?.bounds ?? centred(screen.getDisplayMatching(win.getBounds()).workArea)
    this.morph(win, target, () => {
      win.setMinimumSize(FULL.minWidth, FULL.minHeight)
      if (full?.maximized) win.maximize()
      this.full = null
      this.bar(win)
      this.tell(win)
    })
  }

  /**
   * Whether the change is animated: whenever the window can be seen. The system's "reduce motion" setting is deliberately not followed
   * (the owner's decision, 15 November 2026): many people have Windows' animation effects off for speed, and then a window that jumps
   * is all they would ever see.
   */
  private animated(win: BrowserWindow): boolean {
    return win.isVisible() && !win.isMinimized()
  }

  private stop(): void {
    if (this.fade) clearTimeout(this.fade)
    if (this.frames) clearInterval(this.frames)
    this.fade = null
    this.frames = null
    this.moving = false
  }

  /** Takes the window to `to`, fading the page around it, and then calls `done` (which tells the page the new shape). */
  private morph(win: BrowserWindow, to: Rectangle, done: () => void): void {
    this.stop()
    if (!this.animated(win)) {
      win.setBounds(to)
      done()
      return
    }
    const from = win.getBounds()
    this.moving = true
    win.webContents.send('celeste:layout-start')
    this.fade = setTimeout(() => {
      const start = Date.now()
      this.frames = setInterval(() => {
        if (win.isDestroyed()) return this.stop()
        const t = Math.min(1, (Date.now() - start) / MORPH.move)
        win.setBounds(lerpRect(from, to, ease(t)))
        if (t < 1) return
        this.stop()
        done()
      }, MORPH.frame)
    }, MORPH.fadeOut)
  }

  private bar(win: BrowserWindow): void {
    if (process.platform === 'darwin') return
    try {
      win.setTitleBarOverlay({ height: this.barHeight() })
    } catch {
      /* a window without the overlay */
    }
  }

  /** Remembers where the compact window is left, and leaves compact view when the window is maximised. */
  private watch(win: BrowserWindow): void {
    const moved = () => {
      // The animation moves the window itself: those are not the person's placing of it.
      if (this.moving || !this.saved.compact || win.isMaximized() || win.isMinimized()) return
      this.saved.bounds = win.getBounds()
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.write(), 500)
    }
    win.on('moved', moved)
    win.on('resized', moved)
    win.on('maximize', () => {
      if (!this.saved.compact || this.moving) return
      // The person maximised it: that is the full window, as it is.
      this.saved.compact = false
      this.full = null
      win.setAlwaysOnTop(false)
      win.setMinimumSize(FULL.minWidth, FULL.minHeight)
      this.bar(win)
      this.write()
      this.tell(win)
    })
  }

  private tell(win: BrowserWindow): void {
    if (!win.isDestroyed()) win.webContents.send('celeste:layout', this.state())
    this.changed()
  }

  private write(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.saved))
    } catch {
      /* the shape is just not remembered */
    }
  }
}
