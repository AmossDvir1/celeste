import { describe, expect, it } from 'vitest'
import { centred, COMPACT, compactBounds, compactSize, ease, fitOnScreen, lerpRect } from './compact'

describe('the change of shape', () => {
  it('eases from 0 to 1, slowly at the ends and never outside that range', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(0.5)).toBeCloseTo(0.5)
    expect(ease(0.1)).toBeLessThan(0.1)
    expect(ease(0.9)).toBeGreaterThan(0.9)
    expect(ease(-3)).toBe(0)
    expect(ease(7)).toBe(1)
  })

  it('moves a window between two places in whole pixels', () => {
    const a = { x: 100, y: 50, width: 1440, height: 920 }
    const b = { x: 1388, y: 320, width: 520, height: 700 }
    expect(lerpRect(a, b, 0)).toEqual(a)
    expect(lerpRect(a, b, 1)).toEqual(b)
    const mid = lerpRect(a, b, 0.5)
    expect(Object.values(mid).every(Number.isInteger)).toBe(true)
    expect(mid.width).toBe(980)
  })

  it('puts the full window in the middle of the usable area, and fits it to a small one', () => {
    expect(centred({ x: 0, y: 0, width: 1920, height: 1032 })).toEqual({ x: 240, y: 56, width: 1440, height: 920 })
    expect(centred({ x: 0, y: 0, width: 1000, height: 700 })).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })
})

// A 1920 by 1080 screen with a 48 px taskbar at the bottom, as in the owner's picture.
const area = { x: 0, y: 0, width: 1920, height: 1032 }

describe('compactBounds', () => {
  it('rests in the bottom right corner of the usable area, in from the edges', () => {
    const b = compactBounds(area)
    expect(b.width).toBe(520)
    expect(b.height).toBe(700)
    expect(b.x + b.width).toBe(1920 - COMPACT.margin)
    expect(b.y + b.height).toBe(1032 - COMPACT.margin)
  })

  it('stays above a taskbar on the left or the top, which move the usable area', () => {
    const left = compactBounds({ x: 60, y: 0, width: 1860, height: 1080 })
    expect(left.x).toBeGreaterThanOrEqual(60)
    expect(left.x + left.width).toBe(1920 - COMPACT.margin)
    const top = compactBounds({ x: 0, y: 48, width: 1920, height: 1032 })
    expect(top.y).toBeGreaterThanOrEqual(48)
    expect(top.y + top.height).toBe(1080 - COMPACT.margin)
  })

  it('works on a second screen to the left of the first, whose x is negative', () => {
    const b = compactBounds({ x: -1920, y: 0, width: 1920, height: 1080 })
    expect(b.x).toBe(-COMPACT.margin - 520)
  })

  it('takes a share of a short screen and never goes below the smallest size', () => {
    expect(compactSize({ x: 0, y: 0, width: 1366, height: 600 }).height).toBe(COMPACT.minHeight)
    expect(compactSize({ x: 0, y: 0, width: 1366, height: 1000 }).height).toBe(700)
  })

  it('shrinks to fit a work area smaller than the window', () => {
    const s = compactSize({ x: 0, y: 0, width: 400, height: 400 })
    expect(s.width).toBe(400 - 2 * COMPACT.margin)
    expect(s.height).toBe(400 - 2 * COMPACT.margin)
  })
})

describe('fitOnScreen', () => {
  const right = { x: 1920, y: 0, width: 1920, height: 1080 }

  it('leaves a position that is already on a screen as it is', () => {
    const saved = { x: 100, y: 100, width: 520, height: 600 }
    expect(fitOnScreen(saved, [area])).toEqual(saved)
  })

  it('pulls a window that hangs over an edge back inside', () => {
    const b = fitOnScreen({ x: 1800, y: 900, width: 520, height: 600 }, [area])
    expect(b.x + b.width).toBeLessThanOrEqual(1920)
    expect(b.y + b.height).toBeLessThanOrEqual(1032)
  })

  it('moves a window whose screen was unplugged to the bottom right of the one that is left', () => {
    const b = fitOnScreen({ x: 2500, y: 200, width: 520, height: 600 }, [area])
    expect(b).toEqual(compactBounds(area))
  })

  it('keeps the window on the screen it mostly overlaps', () => {
    const b = fitOnScreen({ x: 1800, y: 100, width: 520, height: 600 }, [area, right])
    expect(b.x).toBeGreaterThanOrEqual(1920)
  })

  it('makes a window larger than its screen fit it', () => {
    const b = fitOnScreen({ x: 0, y: 0, width: 5000, height: 5000 }, [area])
    expect(b.width).toBe(1920)
    expect(b.height).toBe(1032)
  })
})
