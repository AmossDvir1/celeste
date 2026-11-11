import { describe, expect, it } from 'vitest'
import { DIRECT_MAX_FRAME, DIRECT_PIECE, Reassembler, pieces } from './direct'

describe('frames over a data channel', () => {
  it('cuts a frame into pieces and puts it together again, even interleaved', () => {
    const a = 'A'.repeat(DIRECT_PIECE * 2 + 17)
    const b = '{"t":"rpc","note":"héllo ✓"}'
    const pa = pieces(a)
    const pb = pieces(b)
    expect(pa).toHaveLength(3)
    expect(pb).toHaveLength(1)
    const re = new Reassembler()
    const done: string[] = []
    // A small frame arrives between the pieces of a large one.
    for (const piece of [pa[0]!, pa[1]!, pb[0]!, pa[2]!]) {
      const whole = re.add(piece)
      if (whole !== null) done.push(whole)
    }
    expect(done).toEqual([b, a])
    for (const p of [...pa, ...pb]) expect(p.length).toBeLessThanOrEqual(DIRECT_PIECE + 16)
  })

  it('keeps an empty frame', () => {
    const re = new Reassembler()
    expect(pieces('')).toHaveLength(1)
    expect(re.add(pieces('')[0]!)).toBe('')
  })

  it('drops pieces that are out of order, malformed, or too large together', () => {
    const re = new Reassembler()
    const p = pieces('x'.repeat(DIRECT_PIECE * 3))
    expect(re.add(p[1]!)).toBeNull() // no first piece
    expect(re.add(p[0]!)).toBeNull()
    expect(re.add(p[2]!)).toBeNull() // skipped one
    expect(re.add(p[1]!)).toBeNull() // and the frame is gone
    for (const bad of ['', 'nocolon', ':x', 'a.b.c:x', 'a.0.2:x', 'a.-1.0:x', 'a'.repeat(30) + '.0.0:x']) expect(re.add(bad)).toBeNull()
    const big = new Reassembler()
    let last: string | null = 'unset'
    for (let n = 0; n <= DIRECT_MAX_FRAME / DIRECT_PIECE + 1; n++) last = big.add(`z.${n}.1:${'y'.repeat(DIRECT_PIECE)}`)
    expect(last).toBeNull()
    expect(big.add(`z.${DIRECT_MAX_FRAME / DIRECT_PIECE + 2}.0:end`)).toBeNull()
  })

  it('forgets a frame that never finished', () => {
    const re = new Reassembler()
    const p = pieces('x'.repeat(DIRECT_PIECE * 2))
    re.add(p[0]!, 1000)
    expect(re.add(p[1]!, 1000 + 31_000)).toBeNull()
  })
})
