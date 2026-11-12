import { describe, expect, it } from 'vitest'
import { fitShotSize, toScreen, type ShotGeometry } from './geometry'
import { virtualKey } from './driver'

describe('fitShotSize', () => {
  const patches = (s: { width: number; height: number }) => Math.ceil(s.width / 28) * Math.ceil(s.height / 28)
  it.each([
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
    [3440, 1440],
    [1280, 720],
    [800, 5000]
  ])('fits %i by %i within the side and patch limits', (w, h) => {
    const s = fitShotSize(w, h)
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(1568)
    expect(patches(s)).toBeLessThanOrEqual(1568)
    expect(Math.abs(s.width / s.height - w / h)).toBeLessThan(0.02 * (w / h) + 0.02)
  })
  it('keeps a small area as it is', () => {
    expect(fitShotSize(1024, 600)).toEqual({ width: 1024, height: 600 })
  })
})

describe('toScreen', () => {
  // A 3840 by 2160 display scaled to a 1500 pixel wide picture, and a second display to its left.
  const g: ShotGeometry = { origin: { x: -3840, y: 0 }, scaleX: 3840 / 1500, scaleY: 2160 / 844, width: 1500, height: 844 }

  it('turns a point in the picture into a point on the screen', () => {
    expect(toScreen({ x: 0, y: 0 }, g)).toEqual({ ok: true, point: { x: -3840, y: 0 } })
    expect(toScreen({ x: 750, y: 422 }, g)).toEqual({ ok: true, point: { x: -1920, y: 1080 } })
  })

  it('refuses a point outside the picture, and one that is not a number', () => {
    expect(toScreen({ x: 1500, y: 10 }, g)).toMatchObject({ ok: false, reason: expect.stringContaining('outside the screenshot') })
    expect(toScreen({ x: -1, y: 10 }, g)).toMatchObject({ ok: false })
    expect(toScreen({ x: 10, y: 844 }, g)).toMatchObject({ ok: false })
    expect(toScreen({ x: Number.NaN, y: 10 }, g)).toMatchObject({ ok: false })
  })
})

describe('virtualKey', () => {
  it('gives the Windows code of each kind of key', () => {
    expect(virtualKey('a')).toBe(0x41)
    expect(virtualKey('z')).toBe(0x5a)
    expect(virtualKey('0')).toBe(0x30)
    expect(virtualKey('9')).toBe(0x39)
    expect(virtualKey('f1')).toBe(0x70)
    expect(virtualKey('f24')).toBe(0x87)
    expect(virtualKey('enter')).toBe(0x0d)
    expect(virtualKey('ctrl')).toBe(0x11)
    expect(virtualKey('win')).toBe(0x5b)
  })

  it('leaves the plus sign to be typed as a character', () => {
    expect(virtualKey('+')).toBeUndefined()
  })
})
