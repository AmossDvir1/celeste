import { desktopCapturer, nativeImage, screen, type Display } from 'electron'
import { type DesktopShot, type Rect } from '@shared/desktop'
import { fitShotSize, type ShotGeometry } from './geometry'

/** What is in the picture: everything, or nothing but the windows that are shown. Windows are listed bottom to top, in screen pixels. */
export interface Redaction {
  /** `show`: the whole screen is in the picture, and the hidden windows are painted over. `hide`: only the shown windows are in it. */
  base: 'show' | 'hide'
  layers: { rect: Rect; show: boolean }[]
}

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.width, b.x + b.width)
  const bt = Math.min(a.y + a.height, b.y + b.height)
  return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null
}

/** The display a rectangle (in screen pixels) is mostly on. */
export function displayOf(rect: Rect): Display {
  return screen.getDisplayMatching(screen.screenToDipRect(null, rect))
}

/**
 * A display (or a part of it), scaled to a size models read without shrinking it further (see `fitShotSize`), with the windows the assistant may not see
 * painted black. Celeste's own windows are not in it either way (the service hides them from capture).
 */
export async function capture(display: Display, crop?: Rect, redaction?: Redaction): Promise<{ shot: DesktopShot; geometry: ShotGeometry }> {
  const physical = screen.dipToScreenRect(null, display.bounds)
  const area = (crop && intersect(crop, physical)) || physical
  const fit = fitShotSize(area.width, area.height)
  const factor = fit.width / area.width
  const target = { width: Math.max(1, Math.round(physical.width * factor)), height: Math.max(1, Math.round(physical.height * factor)) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: target })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('The system gave no picture of the screen. On some systems this needs a permission.')
  let image = source.thumbnail
  const size = image.getSize()
  const sx = size.width / physical.width
  const sy = size.height / physical.height
  const toPicture = (r: Rect): Rect => ({ x: Math.round((r.x - physical.x) * sx), y: Math.round((r.y - physical.y) * sy), width: Math.round(r.width * sx), height: Math.round(r.height * sy) })

  if (redaction) {
    const src = image.toBitmap() // 4 bytes a pixel, blue first
    const out = Buffer.alloc(size.width * size.height * 4)
    for (let i = 3; i < out.length; i += 4) out[i] = 255 // black, not see-through
    const row = size.width * 4
    const copy = (r: Rect) => {
      for (let y = r.y; y < r.y + r.height; y++) src.copy(out, y * row + r.x * 4, y * row + r.x * 4, y * row + (r.x + r.width) * 4)
    }
    const black = (r: Rect) => {
      for (let y = r.y; y < r.y + r.height; y++) out.fill(0, y * row + r.x * 4, y * row + (r.x + r.width) * 4)
      for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) out[y * row + x * 4 + 3] = 255
    }
    if (redaction.base === 'show') src.copy(out)
    for (const layer of redaction.layers) {
      const on = intersect(toPicture(layer.rect), { x: 0, y: 0, width: size.width, height: size.height })
      if (on) (layer.show ? copy : black)(on)
    }
    image = nativeImage.createFromBitmap(out, { width: size.width, height: size.height })
  }

  let shown = { x: 0, y: 0, width: size.width, height: size.height }
  if (area !== physical) {
    shown = intersect(toPicture(area), shown) ?? shown
    image = image.crop(shown)
  }
  const final = image.getSize()
  return {
    shot: { mime: 'image/jpeg', data: image.toJPEG(85).toString('base64'), width: final.width, height: final.height },
    geometry: { origin: { x: physical.x + shown.x / sx, y: physical.y + shown.y / sy }, scaleX: 1 / sx, scaleY: 1 / sy, width: final.width, height: final.height }
  }
}
