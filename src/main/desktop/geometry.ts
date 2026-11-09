import type { Point } from '@shared/desktop'

/**
 * How a picture of the screen maps back to the screen. The assistant aims in the picture's pixels, which are scaled down from the real
 * ones (and the real ones are not the same as Electron's units on a display scaled above 100%), so every point is converted here.
 */
export interface ShotGeometry {
  /** The top left of the captured display, in screen pixels. */
  origin: Point
  /** Screen pixels for one pixel of the picture. */
  scaleX: number
  scaleY: number
  /** The picture's size. */
  width: number
  height: number
}

/** A point in the picture as a point on the screen, or the reason it cannot be. */
export function toScreen(p: Point, g: ShotGeometry): { ok: true; point: Point } | { ok: false; reason: string } {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: 'The point is not a number.' }
  if (p.x < 0 || p.y < 0 || p.x >= g.width || p.y >= g.height) {
    return { ok: false, reason: `The point (${Math.round(p.x)}, ${Math.round(p.y)}) is outside the screenshot, which is ${g.width} by ${g.height} pixels.` }
  }
  return { ok: true, point: { x: Math.round(g.origin.x + p.x * g.scaleX), y: Math.round(g.origin.y + p.y * g.scaleY) } }
}
