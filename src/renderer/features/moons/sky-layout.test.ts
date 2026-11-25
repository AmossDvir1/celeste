import { describe, expect, it } from 'vitest'
import { mapRoom, skyLayout } from './sky-layout'

const WIDTHS = [360, 639, 640, 760, 820, 899, 900, 940, 980, 1080]

describe('where the sky has its things', () => {
  it('keeps the card, the moons and the words inside it at every width and window height', () => {
    for (const W of WIDTHS) {
      for (const high of [600, 739, 740, 1200]) {
        const l = skyLayout(W, high)
        expect(W - l.card.left - l.pad).toBeGreaterThan(300)
        expect(l.card.top + l.card.height).toBeLessThan(l.H - 40)
        // The moon in front, with its orbit, ends before the card begins.
        if (!l.phone) expect(l.cx + l.rx + l.r * 1.26).toBeLessThan(l.card.left)
        // The two who talk are beside the conversation, not behind it.
        if (!l.phone) expect(l.talk.x + l.r * 1.08).toBeLessThan(l.talk.left)
        expect(l.talk.y + l.r).toBeLessThan(l.H)
      }
    }
  })

  it('lines the card and the words up with the message box when the sky is wider than it', () => {
    expect(skyLayout(1080, 900).pad).toBe(130)
    expect(skyLayout(980, 900).pad).toBe(80)
    expect(skyLayout(820, 900).pad).toBe(20)
  })

  it('is lower in a low window', () => {
    expect(skyLayout(980, 700).H).toBeLessThan(skyLayout(980, 900).H)
  })

  it('puts fewer words on a narrow card', () => {
    expect([570, 400, 290].map(mapRoom)).toEqual([6, 5, 4])
  })
})
