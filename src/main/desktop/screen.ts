import { desktopCapturer, screen } from 'electron'
import { DESKTOP_LIMITS, type DesktopShot } from '@shared/desktop'
import type { ShotGeometry } from './geometry'

/** The main display, scaled so its longer side is about 1,500 pixels. Celeste's own windows are not in it (the service hides them from capture). */
export async function captureMain(): Promise<{ shot: DesktopShot; geometry: ShotGeometry }> {
  const display = screen.getPrimaryDisplay()
  const physical = screen.dipToScreenRect(null, display.bounds)
  const long = Math.max(physical.width, physical.height)
  const factor = Math.min(1, DESKTOP_LIMITS.shotLongSide / long)
  const target = { width: Math.max(1, Math.round(physical.width * factor)), height: Math.max(1, Math.round(physical.height * factor)) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: target })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('The system gave no picture of the screen. On some systems this needs a permission.')
  const size = source.thumbnail.getSize()
  return {
    shot: { mime: 'image/jpeg', data: source.thumbnail.toJPEG(85).toString('base64'), width: size.width, height: size.height },
    geometry: { origin: { x: physical.x, y: physical.y }, scaleX: physical.width / size.width, scaleY: physical.height / size.height, width: size.width, height: size.height }
  }
}
