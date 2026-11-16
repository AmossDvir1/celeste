import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { paintDot, pauseItem, tooltip } from './tray-rules'

const SIZE = 32

/**
 * Celeste's icon in the notification area. Left click opens the window; the menu opens it too, and quits. The icon gets a dot while
 * something needs the person, and its tooltip says what is going on.
 */
export class TrayService {
  private tray: Tray | null = null
  private plain: NativeImage | null = null
  private dotted: NativeImage | null = null
  private working = 0
  private waiting = 0
  /** The menu as last drawn, so the app checks can read it and press an item (the system's own menu cannot be reached from a script). */
  private labels: string[] = []
  private presses = new Map<string, () => void>()
  private tip = ''

  constructor(
    private readonly deps: {
      /** The picture the icon is made from. */
      icon: string
      open: () => void
      quit: () => void
      /** Whether the window is the small side window now, and a way to switch (the menu item's words and action). */
      compact: () => boolean
      toggleCompact: () => void
      /** How many schedules there are and whether they are all paused, and the menu item's action (pauses, or resumes). */
      schedules: () => { count: number; paused: boolean }
      togglePauseSchedules: () => void
    }
  ) {}

  /** Makes the icon if it is not there. False when the system would not make one, so closing must not hide the window. */
  ensure(): boolean {
    if (this.tray && !this.tray.isDestroyed()) return true
    try {
      const base = nativeImage.createFromPath(this.deps.icon)
      if (base.isEmpty()) return false
      this.plain = base.resize({ width: SIZE, height: SIZE, quality: 'best' })
      this.dotted = nativeImage.createFromBitmap(paintDot(this.plain.toBitmap(), SIZE), { width: SIZE, height: SIZE })
      const tray = new Tray(this.plain)
      tray.on('click', () => this.deps.open())
      this.tray = tray
      this.refresh()
      return true
    } catch {
      this.tray = null
      return false
    }
  }

  get ready(): boolean {
    return !!this.tray && !this.tray.isDestroyed()
  }

  update(working: number, waiting: number): void {
    this.working = working
    this.waiting = waiting
    this.refresh()
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
  }

  /** Draws the tooltip, the icon and the menu again. */
  refresh(): void {
    const tray = this.tray
    if (!tray || tray.isDestroyed()) return
    const schedules = this.deps.schedules()
    this.tip = tooltip(this.working, this.waiting, schedules.paused)
    tray.setToolTip(this.tip)
    const pause = pauseItem(schedules.count, schedules.paused)
    const image = this.waiting > 0 ? this.dotted : this.plain
    if (image) tray.setImage(image)
    const items: { label: string; run: () => void }[] = [
      { label: 'Open Celeste', run: () => this.deps.open() },
      { label: this.deps.compact() ? 'Full view' : 'Compact view', run: () => this.deps.toggleCompact() },
      ...(pause ? [{ label: pause, run: () => this.deps.togglePauseSchedules() }] : [])
    ]
    const quit = { label: 'Quit Celeste', run: () => this.deps.quit() }
    this.labels = [...items, quit].map((i) => i.label)
    this.presses = new Map([...items, quit].map((i) => [i.label, i.run]))
    const template: MenuItemConstructorOptions[] = [...items.map((i) => ({ label: i.label, click: i.run })), { type: 'separator' }, { label: quit.label, click: quit.run }]
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  /** For the app checks: the words of the menu items now, the tooltip, and pressing an item by its words. */
  inspect(): { labels: string[]; tooltip: string; press: (label: string) => boolean } {
    return {
      labels: this.labels,
      tooltip: this.tip,
      press: (label) => {
        const run = this.presses.get(label)
        run?.()
        return !!run
      }
    }
  }
}
