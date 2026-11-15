import { Menu, nativeImage, Tray, type NativeImage } from 'electron'
import { paintDot, tooltip } from './tray-rules'

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

  constructor(
    private readonly deps: {
      /** The picture the icon is made from. */
      icon: string
      open: () => void
      quit: () => void
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

  private refresh(): void {
    const tray = this.tray
    if (!tray || tray.isDestroyed()) return
    tray.setToolTip(tooltip(this.working, this.waiting))
    const image = this.waiting > 0 ? this.dotted : this.plain
    if (image) tray.setImage(image)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Celeste', click: () => this.deps.open() },
        { type: 'separator' },
        { label: 'Quit Celeste', click: () => this.deps.quit() }
      ])
    )
  }
}
