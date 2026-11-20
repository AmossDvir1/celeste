/*
 * The arithmetic of looking closely at a picture on a touch screen (the phone's viewer for a diagram or a drawing): how far it is zoomed, how a
 * pinch changes that, and what counts as a double tap. No screen here, so it can be tested; the viewer holds the fingers and the scrolling.
 */

/** A picture is shown at the width of the screen at least, and at most this many times that wide. */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 6
/** What a press of Zoom in or Zoom out multiplies by, and where a double tap goes. */
export const ZOOM_STEP = 1.5
export const ZOOM_DOUBLE_TAP = 2.5

export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : ZOOM_MIN)

export interface Point {
  x: number
  y: number
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
export const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** The zoom after a pinch that began at `start` (with the fingers `from` apart) and now has them `now` apart. Fingers that began at one place do no harm. */
export function pinchZoom(start: number, from: number, now: number): number {
  if (!(from > 0) || !(now >= 0)) return clampZoom(start)
  return clampZoom(start * (now / from))
}

/** One press of Zoom in (`+1`) or Zoom out (`-1`). */
export const stepZoom = (z: number, direction: 1 | -1): number => clampZoom(direction === 1 ? z * ZOOM_STEP : z / ZOOM_STEP)

/**
 * Where to scroll so that the part of the picture that was under `at` (a fraction of the picture's width and height, 0 to 1) stays under that
 * place on the screen after the picture changed size. Returns how much to add to the scroll position.
 */
export function keepUnder(fraction: Point, picture: { left: number; top: number; width: number; height: number }, at: Point): Point {
  return { x: picture.left + fraction.x * picture.width - at.x, y: picture.top + fraction.y * picture.height - at.y }
}

/** The fraction of a picture's size at a place on the screen. */
export function fractionAt(picture: { left: number; top: number; width: number; height: number }, at: Point): Point {
  return { x: picture.width > 0 ? (at.x - picture.left) / picture.width : 0, y: picture.height > 0 ? (at.y - picture.top) / picture.height : 0 }
}

/** Two taps are a double tap when they are close in time and in place. */
export function isDoubleTap(previous: { at: number; point: Point } | null, now: { at: number; point: Point }, ms = 320, px = 30): boolean {
  return !!previous && now.at - previous.at <= ms && distance(previous.point, now.point) <= px
}

/** A finger that moved less than this since it went down was a tap, not a drag. */
export const TAP_SLOP = 8
