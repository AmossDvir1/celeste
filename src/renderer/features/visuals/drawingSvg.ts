import { FONT_SIZE, type DrawingColor, type Layout, type PlacedShape } from './drawing'

/*
 * A drawing from an assistant (the shapes and arrows of `drawing.ts`, already placed) as a plain SVG string, for where the drawing board's
 * library is not: the phone. Clean lines, not Excalidraw's hand-drawn look. Every piece of text is escaped and only known attributes are
 * written, so nothing in a drawing can become markup or script.
 */

export interface DrawingPalette {
  /** Lines and text. */
  ink: string
  /** The page the drawing sits on, behind the label of an arrow. */
  paper: string
  /** What each named colour is. `default` is the colour of plain lines. */
  colors: Record<DrawingColor, string>
}

const LINE = 25
const PADDING = 28
const ARROW_HEAD = 12

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const num = (n: number): string => String(Math.round(n * 10) / 10)

/** The words of a shape or an arrow, centred on (cx, cy), one `<tspan>` for each line. */
function words(text: string, cx: number, cy: number, size: number, ink: string, halo?: string): string {
  const lines = text.split('\n')
  const spans = lines.map((l, i) => `<tspan x="${num(cx)}" y="${num(cy + (i - (lines.length - 1) / 2) * LINE)}">${escape(l)}</tspan>`).join('')
  const outline = halo ? ` stroke="${escape(halo)}" stroke-width="5" stroke-linejoin="round" paint-order="stroke"` : ''
  return `<text text-anchor="middle" dominant-baseline="central" font-size="${size}" fill="${escape(ink)}"${outline}>${spans}</text>`
}

function shape(s: PlacedShape, p: DrawingPalette): string {
  const color = p.colors[s.color] ?? p.ink
  const cx = s.x + s.width / 2
  const cy = s.y + s.height / 2
  const body =
    s.kind === 'ellipse'
      ? `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(s.width / 2)}" ry="${num(s.height / 2)}" fill="${escape(color)}" fill-opacity=".14" stroke="${escape(color)}" stroke-width="2.2"/>`
      : s.kind === 'diamond'
        ? `<polygon points="${num(cx)},${num(s.y)} ${num(s.x + s.width)},${num(cy)} ${num(cx)},${num(s.y + s.height)} ${num(s.x)},${num(cy)}" fill="${escape(color)}" fill-opacity=".14" stroke="${escape(color)}" stroke-width="2.2" stroke-linejoin="round"/>`
        : s.kind === 'text'
          ? ''
          : `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.width)}" height="${num(s.height)}" rx="10" fill="${escape(color)}" fill-opacity=".14" stroke="${escape(color)}" stroke-width="2.2"/>`
  return `<g>${body}${s.text ? words(s.text, cx, cy, FONT_SIZE, s.kind === 'text' && s.color !== 'default' ? color : p.ink) : ''}</g>`
}

/** The drawing as an SVG: its own size is in its `viewBox`, so it scales to whatever box it is put in. */
export function drawingSvg(layout: Layout, palette: DrawingPalette, label: string): { svg: string; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const s of layout.shapes) {
    grow(s.x, s.y)
    grow(s.x + s.width, s.y + s.height)
  }
  for (const a of layout.arrows) {
    grow(a.x, a.y)
    grow(a.x + a.dx, a.y + a.dy)
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0
    maxX = maxY = 1
  }
  const x0 = minX - PADDING
  const y0 = minY - PADDING
  const width = maxX - minX + PADDING * 2
  const height = maxY - minY + PADDING * 2

  const arrows = layout.arrows
    .map((a) => {
      const ex = a.x + a.dx
      const ey = a.y + a.dy
      const angle = Math.atan2(a.dy, a.dx)
      const back = (turn: number) => `${num(ex - ARROW_HEAD * Math.cos(angle + turn))},${num(ey - ARROW_HEAD * Math.sin(angle + turn))}`
      const mx = a.x + a.dx / 2
      const my = a.y + a.dy / 2
      return (
        `<g><line x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(ex - (ARROW_HEAD - 3) * Math.cos(angle))}" y2="${num(ey - (ARROW_HEAD - 3) * Math.sin(angle))}" stroke="${escape(palette.ink)}" stroke-width="2.2" stroke-linecap="round"/>` +
        `<polygon points="${num(ex)},${num(ey)} ${back(0.42)} ${back(-0.42)}" fill="${escape(palette.ink)}"/>` +
        `${a.text ? words(a.text, mx, my - 14, 16, palette.ink, palette.paper) : ''}</g>`
      )
    })
    .join('')

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x0)} ${num(y0)} ${num(width)} ${num(height)}" role="img" aria-label="${escape(label)}" font-family="inherit">` +
    layout.shapes.map((s) => shape(s, palette)).join('') +
    arrows +
    `</svg>`
  return { svg, width, height }
}
