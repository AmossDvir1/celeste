/*
 * The phone's sketch pad: a page to draw on with a finger or a pen, sent to the assistant as a picture. This file holds what is not about the
 * screen, so it can be tested: the strokes, how big the picture is, and how a drawing is kept apart from the screen it was made on.
 *
 * A stroke is kept as fractions of the page's width (points and thickness alike), so a screen that is turned, or a picture made larger for
 * sending, shows the same drawing.
 */

/** The longest side of the picture that is sent, in pixels: the same as the drawing board on the computer. */
export const SKETCH_MAX_SIDE = 1024
/** Limits that keep a long scribble from using the phone's memory or making a very large redraw. */
export const SKETCH_MAX_STROKES = 600
export const SKETCH_MAX_POINTS = 3000

export const SKETCH_COLORS = [
  { id: 'black', label: 'Black', value: '#1b1b1f' },
  { id: 'blue', label: 'Blue', value: '#1e6fe0' },
  { id: 'red', label: 'Red', value: '#d93636' },
  { id: 'green', label: 'Green', value: '#1f9d55' }
] as const

/** The page is always white, so the picture reads the same in either theme (the eraser paints white). */
export const SKETCH_PAPER = '#ffffff'

/** How thick each pen is, as a fraction of the page's width. */
export const SKETCH_PENS = { thin: 0.007, thick: 0.02, eraser: 0.07 } as const
export type SketchPen = keyof typeof SKETCH_PENS

export interface SketchPoint {
  x: number
  y: number
}

export interface Stroke {
  color: string
  /** The thickness, as a fraction of the page's width. */
  width: number
  points: SketchPoint[]
}

/** The size of the picture to send, and how much larger than the screen's page it is. The longer side is `max` at most; a small page is not made larger than that. */
export function exportSize(width: number, height: number, max = SKETCH_MAX_SIDE): { width: number; height: number; scale: number } {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const scale = max / Math.max(w, h)
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale }
}

/** A point is kept when it is far enough from the one before it to matter, so a slow finger does not pile up points. */
export function keepPoint(last: SketchPoint | undefined, next: SketchPoint, minDistance: number): boolean {
  if (!last) return true
  return Math.hypot(next.x - last.x, next.y - last.y) >= minDistance
}

/** Whether there is anything on the page that would show: a stroke in a colour (the eraser alone leaves a blank page). */
export function hasInk(strokes: Stroke[]): boolean {
  return strokes.some((s) => s.color !== SKETCH_PAPER && s.points.length > 0)
}

/** The stroke list with one more stroke, within the limits (the oldest is let go when there are too many). */
export function withStroke(strokes: Stroke[], stroke: Stroke): Stroke[] {
  const next = [...strokes, { ...stroke, points: stroke.points.slice(0, SKETCH_MAX_POINTS) }]
  return next.length > SKETCH_MAX_STROKES ? next.slice(next.length - SKETCH_MAX_STROKES) : next
}

/** The page's file name for the message. */
export const SKETCH_FILE = 'sketch.png'
