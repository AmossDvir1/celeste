import { DESKTOP_LIMITS, type Point } from '@shared/desktop'

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

const tokensOf = (w: number, h: number): number => Math.ceil(w / 28) * Math.ceil(h / 28)

/**
 * The size to capture an area at, so a model reads the picture at the size it is sent. Models resize any picture that has a side over about
 * 1,568 pixels or more than about 1,568 patches of 28 by 28 pixels (a 1,500 pixel wide 16:9 picture is over it), and then the points they
 * give no longer match the picture. Fitting both limits here, with a little to spare, keeps one pixel in the picture one pixel to aim at.
 */
export function fitShotSize(width: number, height: number): { width: number; height: number } {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const fits = (s: number): boolean => {
    const pw = Math.max(1, Math.round(w * s))
    const ph = Math.max(1, Math.round(h * s))
    return Math.max(pw, ph) <= DESKTOP_LIMITS.shotMaxSide && tokensOf(pw, ph) <= DESKTOP_LIMITS.shotMaxTokens
  }
  if (fits(1)) return { width: Math.round(w), height: Math.round(h) }
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return { width: Math.max(1, Math.round(w * lo)), height: Math.max(1, Math.round(h * lo)) }
}

/** A point in the picture as a point on the screen, or the reason it cannot be. */
export function toScreen(p: Point, g: ShotGeometry): { ok: true; point: Point } | { ok: false; reason: string } {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false, reason: 'The point is not a number.' }
  if (p.x < 0 || p.y < 0 || p.x >= g.width || p.y >= g.height) {
    return { ok: false, reason: `The point (${Math.round(p.x)}, ${Math.round(p.y)}) is outside the screenshot, which is ${g.width} by ${g.height} pixels.` }
  }
  return { ok: true, point: { x: Math.round(g.origin.x + p.x * g.scaleX), y: Math.round(g.origin.y + p.y * g.scaleY) } }
}
