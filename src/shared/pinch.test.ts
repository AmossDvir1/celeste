import { describe, expect, it } from 'vitest'
import { ZOOM_DOUBLE_TAP, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, clampZoom, distance, fractionAt, isDoubleTap, keepUnder, middle, pinchZoom, stepZoom } from './pinch'

describe('zoom', () => {
  it('stays between one times the screen and six times', () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN)
    expect(clampZoom(3)).toBe(3)
    expect(clampZoom(99)).toBe(ZOOM_MAX)
    expect(clampZoom(Number.NaN)).toBe(ZOOM_MIN)
    expect(clampZoom(Infinity)).toBe(ZOOM_MIN)
  })

  it('follows a pinch in proportion to how far the fingers moved apart or together', () => {
    expect(pinchZoom(1, 100, 200)).toBe(2)
    expect(pinchZoom(2, 100, 100)).toBe(2)
    expect(pinchZoom(2, 200, 100)).toBe(1)
    // Starting from a zoom, not from one.
    expect(pinchZoom(2, 100, 150)).toBeCloseTo(3)
  })

  it('does not go past the limits however far the fingers go, and does not break when they begin at one place', () => {
    expect(pinchZoom(1, 50, 5000)).toBe(ZOOM_MAX)
    expect(pinchZoom(3, 400, 1)).toBe(ZOOM_MIN)
    expect(pinchZoom(2, 0, 120)).toBe(2)
    expect(pinchZoom(2, 100, Number.NaN)).toBe(2)
  })

  it('goes by one and a half times for a press of the buttons, and stops at the ends', () => {
    expect(stepZoom(1, 1)).toBe(ZOOM_STEP)
    expect(stepZoom(1.5, -1)).toBe(1)
    expect(stepZoom(1, -1)).toBe(ZOOM_MIN)
    expect(stepZoom(5, 1)).toBe(ZOOM_MAX)
    // Four presses in are about five times; the double tap's size is between two and three.
    expect(stepZoom(stepZoom(stepZoom(stepZoom(1, 1), 1), 1), 1)).toBeCloseTo(1.5 ** 4)
    expect(ZOOM_DOUBLE_TAP).toBeGreaterThan(2)
    expect(ZOOM_DOUBLE_TAP).toBeLessThan(3)
  })
})

describe('where the picture stays', () => {
  const at = { x: 200, y: 300 }

  it('keeps the part of the picture that was under the fingers under them when it grows', () => {
    // A picture 300 by 200 whose top left is at (50, 100): the point (200, 300) is at 1/2 across and 1 down... clamp: it is on its lower edge.
    const before = { left: 50, top: 100, width: 300, height: 200 }
    const fraction = fractionAt(before, { x: 200, y: 250 })
    expect(fraction).toEqual({ x: 0.5, y: 0.75 })
    // It becomes twice as large, still with its top left at (50, 100) because nothing has scrolled yet.
    const after = { left: 50, top: 100, width: 600, height: 400 }
    const by = keepUnder(fraction, after, { x: 200, y: 250 })
    // Scrolling by that much puts the same part back under the same place.
    expect(after.left - by.x + fraction.x * after.width).toBeCloseTo(200)
    expect(after.top - by.y + fraction.y * after.height).toBeCloseTo(250)
  })

  it('needs no scroll when the picture did not change size or move', () => {
    const picture = { left: 10, top: 20, width: 400, height: 300 }
    const by = keepUnder(fractionAt(picture, at), picture, at)
    expect(by.x).toBeCloseTo(0)
    expect(by.y).toBeCloseTo(0)
  })

  it('follows two fingers that move together, and copes with a picture that has no size yet', () => {
    const picture = { left: 0, top: 0, width: 400, height: 300 }
    const fraction = fractionAt(picture, { x: 100, y: 150 })
    // The fingers move 40 pixels to the right: scroll so that the same part is under them.
    const by = keepUnder(fraction, picture, { x: 140, y: 150 })
    expect(by.x).toBeCloseTo(-40)
    expect(fractionAt({ left: 0, top: 0, width: 0, height: 0 }, at)).toEqual({ x: 0, y: 0 })
  })

  it('finds the distance and the place between two fingers', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(middle({ x: 0, y: 10 }, { x: 10, y: 30 })).toEqual({ x: 5, y: 20 })
  })
})

describe('a double tap', () => {
  const tap = (at: number, x = 100, y = 100) => ({ at, point: { x, y } })

  it('is two taps close in time and place', () => {
    expect(isDoubleTap(tap(1000), tap(1200))).toBe(true)
    expect(isDoubleTap(tap(1000), tap(1200, 120, 110))).toBe(true)
  })

  it('is not one when the second is late, far away, or the first', () => {
    expect(isDoubleTap(tap(1000), tap(1500))).toBe(false)
    expect(isDoubleTap(tap(1000), tap(1200, 300, 100))).toBe(false)
    expect(isDoubleTap(null, tap(1200))).toBe(false)
  })
})
