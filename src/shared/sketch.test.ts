import { describe, expect, it } from 'vitest'
import { SKETCH_COLORS, SKETCH_MAX_POINTS, SKETCH_MAX_SIDE, SKETCH_MAX_STROKES, SKETCH_PAPER, exportSize, hasInk, keepPoint, withStroke, type Stroke } from './sketch'

const stroke = (color: string, n = 3): Stroke => ({ color, width: 0.01, points: Array.from({ length: n }, (_, i) => ({ x: i / 10, y: 0.1 })) })

describe('the size of a sketch that is sent', () => {
  it('has its longer side at 1024 pixels, whichever side that is, and keeps the shape', () => {
    expect(exportSize(390, 600)).toMatchObject({ width: 666, height: 1024 })
    expect(exportSize(800, 400)).toMatchObject({ width: 1024, height: 512 })
    expect(Math.max(exportSize(412, 733).width, exportSize(412, 733).height)).toBe(SKETCH_MAX_SIDE)
  })

  it('draws a small page larger and a large one smaller, so the lines are as sharp as they can be', () => {
    expect(exportSize(300, 400).scale).toBeGreaterThan(1)
    expect(exportSize(3000, 2000).scale).toBeLessThan(1)
  })

  it('does not fail on a page with no size yet', () => {
    expect(exportSize(0, 0)).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
    expect(exportSize(0, 0).width).toBeGreaterThanOrEqual(1)
  })
})

describe('what is on the page', () => {
  it('has ink when a stroke is in a colour, and none for a blank page or one that only the eraser touched', () => {
    expect(hasInk([])).toBe(false)
    expect(hasInk([stroke(SKETCH_PAPER)])).toBe(false)
    expect(hasInk([stroke(SKETCH_COLORS[0].value)])).toBe(true)
    expect(hasInk([stroke(SKETCH_COLORS[1].value), stroke(SKETCH_PAPER)])).toBe(true)
    expect(hasInk([{ color: SKETCH_COLORS[0].value, width: 0.01, points: [] }])).toBe(false)
  })

  it('keeps a point only when it is far enough from the one before it', () => {
    expect(keepPoint(undefined, { x: 0.5, y: 0.5 }, 0.01)).toBe(true)
    expect(keepPoint({ x: 0.5, y: 0.5 }, { x: 0.5005, y: 0.5 }, 0.01)).toBe(false)
    expect(keepPoint({ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5 }, 0.01)).toBe(true)
  })

  it('keeps the strokes within the limits, letting the oldest go', () => {
    let list: Stroke[] = []
    for (let i = 0; i < SKETCH_MAX_STROKES + 5; i++) list = withStroke(list, { ...stroke(SKETCH_COLORS[0].value, 1), width: i / 10_000 })
    expect(list).toHaveLength(SKETCH_MAX_STROKES)
    expect(list[0]?.width).toBeCloseTo(5 / 10_000)
    const long = withStroke([], stroke(SKETCH_COLORS[0].value, SKETCH_MAX_POINTS + 500))
    expect(long[0]?.points).toHaveLength(SKETCH_MAX_POINTS)
  })

  it('does not change the list it was given', () => {
    const before = [stroke(SKETCH_COLORS[0].value)]
    withStroke(before, stroke(SKETCH_COLORS[1].value))
    expect(before).toHaveLength(1)
  })
})
