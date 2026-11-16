import type { Checked } from './spec'

/*
 * The drawing an assistant writes in an ```excalidraw block (docs/plans/CHAT_DISPLAY_PLAN.md, sections 5 and 11b). Pure: no library. The
 * assistant gives shapes with text and arrows between shape ids; **this file works out where things go and where each arrow starts and ends**,
 * because a model's own coordinates for arrows come out wrong (the canvas spike showed it). Colours come from a fixed list of names, never from
 * the text, and unknown fields are dropped.
 */

export type ShapeKind = 'box' | 'ellipse' | 'diamond' | 'text'
export type DrawingColor = 'default' | 'blue' | 'green' | 'orange' | 'red' | 'purple'

export interface DrawingShape {
  id: string
  kind: ShapeKind
  text: string
  color: DrawingColor
  /** Where the top left corner goes. Absent: the app places it. */
  x?: number
  y?: number
}

export interface DrawingArrow {
  from: string
  to: string
  text?: string
}

export interface DrawingSpec {
  title?: string
  summary?: string
  shapes: DrawingShape[]
  arrows: DrawingArrow[]
}

export const DRAWING_MAX_SHAPES = 40
/** Shapes and arrows together, as in the plan (a small drawing, not a map). */
export const DRAWING_MAX_ELEMENTS = 60
export const DRAWING_MAX_TEXT = 120
export const DRAWING_MAX_ARROW_TEXT = 60
export const DRAWING_MAX_LINES = 6
const COORD = 5000

export const COLORS: DrawingColor[] = ['default', 'blue', 'green', 'orange', 'red', 'purple']
const KINDS: ShapeKind[] = ['box', 'ellipse', 'diamond', 'text']
const ID = /^[A-Za-z0-9_-]{1,24}$/

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error })
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clean = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/** A drawing from a block's text. A limit that is passed is refused with a sentence the assistant can act on. */
export function parseDrawing(raw: string): Checked<DrawingSpec> {
  if (raw.length > 100_000) return bad('The block is too large.')
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return bad('It is not valid JSON.')
  }
  if (!isObject(v)) return bad('It is not an object.')
  if (!Array.isArray(v.shapes) || v.shapes.length === 0) return bad('The drawing needs a list of shapes.')
  if (v.shapes.length > DRAWING_MAX_SHAPES) return bad(`A drawing may have at most ${DRAWING_MAX_SHAPES} shapes.`)
  const rawArrows = v.arrows === undefined ? [] : v.arrows
  if (!Array.isArray(rawArrows)) return bad('The arrows must be a list.')
  if (v.shapes.length + rawArrows.length > DRAWING_MAX_ELEMENTS) return bad(`A drawing may have at most ${DRAWING_MAX_ELEMENTS} shapes and arrows together.`)

  const shapes: DrawingShape[] = []
  const seen = new Set<string>()
  for (const s of v.shapes) {
    if (!isObject(s)) return bad('A shape is not an object.')
    if (typeof s.id !== 'string' || !ID.test(s.id)) return bad('Each shape needs an id of letters, digits, - or _ (at most 24).')
    if (seen.has(s.id)) return bad(`The id "${s.id}" is used twice.`)
    seen.add(s.id)
    const kind = s.kind === undefined ? 'box' : s.kind
    if (typeof kind !== 'string' || !KINDS.includes(kind as ShapeKind)) return bad(`A shape's kind must be one of ${KINDS.join(', ')}.`)
    const text = clean(s.text, DRAWING_MAX_TEXT) ?? ''
    if (!text && kind === 'text') return bad('A text shape needs text.')
    if (text.split('\n').length > DRAWING_MAX_LINES) return bad(`A shape's text may have at most ${DRAWING_MAX_LINES} lines.`)
    const color = s.color === undefined ? 'default' : s.color
    if (typeof color !== 'string' || !COLORS.includes(color as DrawingColor)) return bad(`A colour must be one of ${COLORS.join(', ')}.`)
    const x = s.x
    const y = s.y
    const placed = x !== undefined || y !== undefined
    if (placed && (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > COORD || Math.abs(y) > COORD)) {
      return bad(`A shape's x and y must both be numbers between -${COORD} and ${COORD}.`)
    }
    shapes.push({ id: s.id, kind: kind as ShapeKind, text, color: color as DrawingColor, ...(placed ? { x: x as number, y: y as number } : {}) })
  }

  const arrows: DrawingArrow[] = []
  for (const a of rawArrows) {
    if (!isObject(a)) return bad('An arrow is not an object.')
    if (typeof a.from !== 'string' || typeof a.to !== 'string') return bad('Each arrow needs "from" and "to", the ids of two shapes.')
    if (!seen.has(a.from) || !seen.has(a.to)) return bad(`An arrow goes between shapes that are not there ("${a.from}" to "${a.to}").`)
    if (a.from === a.to) return bad('An arrow cannot start and end at the same shape.')
    const text = clean(a.text, DRAWING_MAX_ARROW_TEXT)
    arrows.push({ from: a.from, to: a.to, ...(text ? { text } : {}) })
  }
  const title = clean(v.title, 120)
  const summary = clean(v.summary, 300)
  return { ok: true, value: { shapes, arrows, ...(title ? { title } : {}), ...(summary ? { summary } : {}) } }
}

// --- where things go -----------------------------------------------------------------------------------

export const FONT_SIZE = 20
const LINE = 25
const CHAR = 11.5
const GAP_X = 110
const GAP_Y = 50
const ARROW_GAP = 4

export interface PlacedShape extends DrawingShape {
  x: number
  y: number
  width: number
  height: number
}
export interface PlacedArrow extends DrawingArrow {
  /** Where it starts, and the end relative to the start. */
  x: number
  y: number
  dx: number
  dy: number
}
export interface Layout {
  shapes: PlacedShape[]
  arrows: PlacedArrow[]
}

const lines = (text: string) => (text ? text.split('\n') : [''])
const textWidth = (text: string) => Math.max(...lines(text).map((l) => l.length)) * CHAR
const round = (n: number) => Math.round(n * 10) / 10

/** The size a shape needs for its text: a box fits it, an ellipse and a diamond need more room round the same words. */
export function sizeOf(kind: ShapeKind, text: string): { width: number; height: number } {
  const w = textWidth(text)
  const h = lines(text).length * LINE
  switch (kind) {
    case 'text':
      return { width: Math.max(20, w), height: h }
    case 'ellipse':
      return { width: Math.max(140, w * 1.45 + 30), height: Math.max(80, h * 1.6 + 40) }
    case 'diamond':
      return { width: Math.max(170, w * 1.9 + 20), height: Math.max(110, h * 2.2 + 40) }
    default:
      return { width: Math.max(120, w + 40), height: Math.max(64, h + 32) }
  }
}

/** The depth of each shape along the arrows (a shape with nothing pointing at it is 0), so the picture reads left to right. A loop does not stop it. */
function levelsOf(spec: DrawingSpec): Map<string, number> {
  const level = new Map(spec.shapes.map((s) => [s.id, 0]))
  for (let pass = 0; pass < spec.shapes.length; pass++) {
    let changed = false
    for (const a of spec.arrows) {
      const next = (level.get(a.from) as number) + 1
      // Capped, so a cycle settles instead of growing without end.
      if (next > (level.get(a.to) as number) && next < spec.shapes.length) {
        level.set(a.to, next)
        changed = true
      }
    }
    if (!changed) break
  }
  return level
}

/** Where the line from the middle of a shape towards (dx, dy) leaves its outline. */
function edge(s: PlacedShape, dx: number, dy: number): number {
  const hw = s.width / 2
  const hh = s.height / 2
  const ax = Math.abs(dx) || 1e-9
  const ay = Math.abs(dy) || 1e-9
  if (s.kind === 'ellipse') return 1 / Math.sqrt((ax / hw) ** 2 + (ay / hh) ** 2)
  if (s.kind === 'diamond') return 1 / (ax / hw + ay / hh)
  return Math.min(hw / ax, hh / ay)
}

/**
 * Places the shapes and works out each arrow. Shapes that came with a position keep it (when every shape did, nothing is moved); otherwise
 * all are laid out in columns by their depth along the arrows. An arrow runs from the outline of one shape to the outline of the other.
 */
export function layoutDrawing(spec: DrawingSpec): Layout {
  const sized = spec.shapes.map((s) => ({ s, ...sizeOf(s.kind, s.text) }))
  const allPlaced = spec.shapes.every((s) => s.x !== undefined && s.y !== undefined)
  const shapes: PlacedShape[] = []
  if (allPlaced) {
    for (const { s, width, height } of sized) shapes.push({ ...s, x: s.x as number, y: s.y as number, width, height })
  } else {
    const level = levelsOf(spec)
    const columns = new Map<number, typeof sized>()
    for (const item of sized) {
      const l = level.get(item.s.id) as number
      columns.set(l, [...(columns.get(l) ?? []), item])
    }
    // A label sits on its arrow, so the room between two columns grows with the longest one.
    const labelRoom = Math.max(0, ...spec.arrows.map((a) => (a.text?.length ?? 0) * 9))
    let x = 0
    const tallest = Math.max(...[...columns.values()].map((col) => col.reduce((n, c) => n + c.height + GAP_Y, -GAP_Y)))
    for (const l of [...columns.keys()].sort((a, b) => a - b)) {
      const col = columns.get(l) as typeof sized
      let y = (tallest - col.reduce((n, c) => n + c.height + GAP_Y, -GAP_Y)) / 2
      for (const { s, width, height } of col) {
        shapes.push({ ...s, x, y, width, height })
        y += height + GAP_Y
      }
      x += Math.max(...col.map((c) => c.width)) + GAP_X + labelRoom
    }
  }
  const byId = new Map(shapes.map((s) => [s.id, s]))
  const reverse = new Set(spec.arrows.map((a) => `${a.to}>${a.from}`))
  const arrows: PlacedArrow[] = []
  for (const a of spec.arrows) {
    const from = byId.get(a.from) as PlacedShape
    const to = byId.get(a.to) as PlacedShape
    const fx = from.x + from.width / 2
    const fy = from.y + from.height / 2
    const tx = to.x + to.width / 2
    const ty = to.y + to.height / 2
    const dx = tx - fx
    const dy = ty - fy
    const length = Math.hypot(dx, dy)
    // Two shapes on top of each other have no line between them.
    if (length < 1) continue
    const ux = dx / length
    const uy = dy / length
    // An arrow and its opposite would lie on one line: each is moved a little to its own side.
    const side = reverse.has(`${a.from}>${a.to}`) ? 9 : 0
    const ox = -uy * side
    const oy = ux * side
    const start = edge(from, dx, dy) * length + ARROW_GAP
    const end = length - edge(to, dx, dy) * length - ARROW_GAP
    if (end - start < 8) continue
    arrows.push({ ...a, x: round(fx + ux * start + ox), y: round(fy + uy * start + oy), dx: round(ux * (end - start)), dy: round(uy * (end - start)) })
  }
  return { shapes, arrows }
}
