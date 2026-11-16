import { describe, expect, it } from 'vitest'
import { DRAWING_MAX_ELEMENTS, DRAWING_MAX_SHAPES, layoutDrawing, parseDrawing, sizeOf, type DrawingSpec } from './drawing'
import { phoneLine, summaryOf, visualKind } from './spec'

const ok = (v: unknown) => {
  const r = parseDrawing(JSON.stringify(v))
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const refused = (v: unknown) => {
  const r = parseDrawing(typeof v === 'string' ? v : JSON.stringify(v))
  return r.ok ? null : r.error
}
const flow = { summary: 'Sign-in goes from the browser to the server and the database.', shapes: [{ id: 'b', text: 'Browser' }, { id: 's', text: 'Server' }, { id: 'd', text: 'Database', kind: 'ellipse' }], arrows: [{ from: 'b', to: 's', text: 'request' }, { from: 's', to: 'd' }] }

describe('a drawing from an assistant', () => {
  it('reads shapes and arrows, with the defaults filled in and unknown fields dropped', () => {
    const d = ok({ ...flow, hack: '<script>', shapes: [{ id: 'a', text: 'Hi', onclick: 'x', link: 'javascript:1' }] , arrows: [] })
    expect(d.shapes).toEqual([{ id: 'a', kind: 'box', text: 'Hi', color: 'default' }])
    expect(d).not.toHaveProperty('hack')
    expect(JSON.stringify(d)).not.toMatch(/script|javascript|onclick/)
  })

  it('keeps a title, a summary, a colour from the list, and a position given as both numbers', () => {
    const d = ok({ title: 'T', summary: 'S', shapes: [{ id: 'a', text: 'A', color: 'green', x: 10, y: 20 }] })
    expect(d).toMatchObject({ title: 'T', summary: 'S', shapes: [{ color: 'green', x: 10, y: 20 }] })
  })

  it('refuses what is passed over a limit, with a sentence the assistant can act on', () => {
    expect(refused('nope')).toMatch(/not valid JSON/)
    expect(refused([])).toMatch(/not an object/)
    expect(refused({ shapes: [] })).toMatch(/list of shapes/)
    const many = Array.from({ length: DRAWING_MAX_SHAPES + 1 }, (_, i) => ({ id: `s${i}`, text: 'x' }))
    expect(refused({ shapes: many })).toMatch(/at most 40 shapes/)
    const arrows = Array.from({ length: DRAWING_MAX_ELEMENTS }, () => ({ from: 's0', to: 's1' }))
    expect(refused({ shapes: many.slice(0, 5), arrows })).toMatch(/at most 60 shapes and arrows/)
    expect(refused({ shapes: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] })).toMatch(/used twice/)
    expect(refused({ shapes: [{ id: 'has space', text: 'x' }] })).toMatch(/id of letters/)
    expect(refused({ shapes: [{ id: 'a', kind: 'star', text: 'x' }] })).toMatch(/kind must be/)
    expect(refused({ shapes: [{ id: 'a', color: '#ff0000', text: 'x' }] })).toMatch(/colour must be/)
    expect(refused({ shapes: [{ id: 'a', kind: 'text' }] })).toMatch(/needs text/)
    expect(refused({ shapes: [{ id: 'a', text: 'a\nb\nc\nd\ne\nf\ng' }] })).toMatch(/at most 6 lines/)
    expect(refused({ shapes: [{ id: 'a', text: 'x', x: 5 }] })).toMatch(/x and y must both/)
    expect(refused({ shapes: [{ id: 'a', text: 'x', x: 99999, y: 0 }] })).toMatch(/x and y must both/)
  })

  it('refuses an arrow to nothing, to itself, or without its ends', () => {
    expect(refused({ shapes: [{ id: 'a', text: 'x' }], arrows: [{ from: 'a', to: 'zzz' }] })).toMatch(/not there/)
    expect(refused({ shapes: [{ id: 'a', text: 'x' }], arrows: [{ from: 'a', to: 'a' }] })).toMatch(/same shape/)
    expect(refused({ shapes: [{ id: 'a', text: 'x' }], arrows: [{ from: 'a' }] })).toMatch(/"from" and "to"/)
  })

  it('is a picture kind, and says what it shows in words, for a screen reader and for the phone', () => {
    expect(visualKind('excalidraw')).toBe('excalidraw')
    const text = JSON.stringify(flow)
    expect(summaryOf('excalidraw', text)).toBe(flow.summary)
    expect(phoneLine('excalidraw', text)).toBe(`${flow.summary} (open on the computer to see the picture)`)
    expect(phoneLine('excalidraw', '{"shapes":[{"id":"a","text":"x"}]}')).toBe('A drawing (open on the computer)')
    expect(phoneLine('excalidraw', 'not json')).not.toContain('not json')
  })
})

describe('where things go', () => {
  const spec = (v: unknown) => ok(v) as DrawingSpec

  it('gives a shape the room its words need, more for an ellipse and a diamond', () => {
    const box = sizeOf('box', 'Database')
    expect(box.width).toBeGreaterThanOrEqual(120)
    expect(sizeOf('ellipse', 'Database').width).toBeGreaterThan(box.width)
    expect(sizeOf('diamond', 'Database').height).toBeGreaterThan(box.height)
    // A long label widens the box instead of overflowing it, and lines add height.
    expect(sizeOf('box', 'x'.repeat(40)).width).toBeGreaterThan(400)
    expect(sizeOf('box', 'a\nb\nc').height).toBeGreaterThan(sizeOf('box', 'a').height)
  })

  it('lays shapes out left to right along the arrows when none has a place', () => {
    const l = layoutDrawing(spec(flow))
    const at = (id: string) => l.shapes.find((s) => s.id === id)!
    expect(at('b').x).toBeLessThan(at('s').x)
    expect(at('s').x).toBeLessThan(at('d').x)
    // Nothing overlaps its neighbour.
    expect(at('b').x + at('b').width).toBeLessThan(at('s').x)
  })

  it('leaves more room between columns for a longer arrow label', () => {
    const gap = (label: string) => {
      const l = layoutDrawing(ok({ shapes: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], arrows: [{ from: 'a', to: 'b', ...(label ? { text: label } : {}) }] }) as DrawingSpec)
      return l.shapes[1]!.x - (l.shapes[0]!.x + l.shapes[0]!.width)
    }
    expect(gap('a longer label')).toBeGreaterThan(gap('') + 100)
  })

  it('keeps shapes that all came with a place exactly where they were put', () => {
    const l = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A', x: 300, y: 40 }, { id: 'b', text: 'B', x: 0, y: 0 }], arrows: [{ from: 'a', to: 'b' }] }))
    expect(l.shapes.map((s) => [s.x, s.y])).toEqual([[300, 40], [0, 0]])
  })

  it('stacks the shapes of one column, and settles a loop instead of growing without end', () => {
    const l = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], arrows: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] }))
    expect(new Set(l.shapes.map((s) => s.x)).size).toBeGreaterThanOrEqual(1)
    expect(l.shapes).toHaveLength(3)
    const two = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], arrows: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] }))
    const b = two.shapes.find((s) => s.id === 'b')!
    const c = two.shapes.find((s) => s.id === 'c')!
    expect(b.x).toBe(c.x)
    expect(Math.abs(b.y - c.y)).toBeGreaterThan(50)
  })

  it('makes an arrow run from the outline of one shape to the outline of the other, not through them', () => {
    const l = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A', x: 0, y: 0 }, { id: 'b', text: 'B', x: 400, y: 0 }], arrows: [{ from: 'a', to: 'b' }] }))
    const [a, b] = l.shapes
    const arrow = l.arrows[0]!
    // Starts just right of the first box and ends just left of the second, on the line between their middles.
    expect(arrow.x).toBeGreaterThan(a!.x + a!.width)
    expect(arrow.x + arrow.dx).toBeLessThan(b!.x)
    expect(Math.abs(arrow.dy)).toBeLessThan(0.5)
    expect(arrow.y).toBeCloseTo(a!.y + a!.height / 2, 0)
  })

  it('ends an arrow on an ellipse and a diamond at their outlines, along a slanted line', () => {
    const l = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A', x: 0, y: 0 }, { id: 'e', kind: 'ellipse', text: 'E', x: 300, y: 300 }, { id: 'd', kind: 'diamond', text: 'D', x: 0, y: 400 }], arrows: [{ from: 'a', to: 'e' }, { from: 'e', to: 'd' }] }))
    const e = l.shapes.find((s) => s.id === 'e')!
    const first = l.arrows[0]!
    const endX = first.x + first.dx
    const endY = first.y + first.dy
    // The end is on the ellipse's outline (within a few units), and not at its middle.
    const nx = (endX - (e.x + e.width / 2)) / (e.width / 2)
    const ny = (endY - (e.y + e.height / 2)) / (e.height / 2)
    expect(Math.hypot(nx, ny)).toBeGreaterThan(1)
    expect(Math.hypot(nx, ny)).toBeLessThan(1.15)
    expect(l.arrows).toHaveLength(2)
  })

  it('moves an arrow and its opposite apart so both can be seen, and leaves out an arrow between shapes that touch', () => {
    const both = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A', x: 0, y: 0 }, { id: 'b', text: 'B', x: 400, y: 0 }], arrows: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }))
    expect(both.arrows).toHaveLength(2)
    expect(both.arrows[0]!.y).not.toBe(both.arrows[1]!.y)
    const touching = layoutDrawing(spec({ shapes: [{ id: 'a', text: 'A', x: 0, y: 0 }, { id: 'b', text: 'B', x: 5, y: 0 }], arrows: [{ from: 'a', to: 'b' }] }))
    expect(touching.arrows).toHaveLength(0)
  })

  it('keeps the arrow labels and nothing else the assistant said about the arrow', () => {
    const l = layoutDrawing(spec(flow))
    expect(l.arrows[0]).toMatchObject({ from: 'b', to: 's', text: 'request' })
    expect(l.arrows[1]).not.toHaveProperty('text')
  })
})
