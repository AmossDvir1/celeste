import { describe, expect, it } from 'vitest'
import { LINGER_MS, TalkPlayer, readMs, speakMs, type Said } from './talk'

const say = (id: string, seat: Said['seat'], text: string, at = 0): Said => ({ id, seat, text, at })
const states = (p: TalkPlayer, now: number) => p.view(now).items.map((i) => i.state)

describe('TalkPlayer', () => {
  it('shows typing dots for 900 ms and then the bubble', () => {
    const p = new TalkPlayer()
    p.feed([say('a', 0, 'hello')], 0)
    expect(states(p, 0)).toEqual(['typing'])
    expect(p.view(0).typing).toBe(0)
    expect(states(p, 899)).toEqual(['typing'])
    expect(states(p, 900)).toEqual(['shown'])
    expect(p.view(900).typing).toBeNull()
  })

  it('starts the next dots only after the one before could be read', () => {
    const p = new TalkPlayer()
    const text = 'x'.repeat(10)
    p.feed([say('a', 0, text), say('b', 1, 'ok')], 0)
    const readEnd = 900 + readMs(text)
    expect(readMs(text)).toBe(1200 + 320)
    expect(states(p, 900)).toEqual(['shown', 'hidden'])
    expect(states(p, readEnd - 1)).toEqual(['shown', 'hidden'])
    expect(states(p, readEnd)).toEqual(['shown', 'typing'])
    expect(p.view(readEnd).typing).toBe(1)
    expect(states(p, readEnd + 900)).toEqual(['shown', 'shown'])
  })

  it('caps the reading time at 6000 ms', () => {
    expect(readMs('x'.repeat(1000))).toBe(6000)
    const p = new TalkPlayer()
    p.feed([say('a', 0, 'x'.repeat(1000)), say('b', 1, 'hi')], 0)
    expect(states(p, 900 + 6000 - 1)).toEqual(['shown', 'hidden'])
    expect(states(p, 900 + 6000)).toEqual(['shown', 'typing'])
  })

  it('gives a note no dots', () => {
    const p = new TalkPlayer()
    p.feed([say('n', 'note', 'a note')], 0)
    expect(states(p, 0)).toEqual(['shown'])
    expect(p.view(0).typing).toBeNull()
    expect(p.view(0).speaker).toBeNull()
  })

  it('names the speaker while the bubble is fresh', () => {
    const p = new TalkPlayer()
    const text = 'x'.repeat(20)
    p.feed([say('a', 1, text)], 0)
    expect(p.view(500).speaker).toBeNull()
    expect(p.view(900).speaker).toBe(1)
    expect(speakMs(text)).toBe(500 + 640)
    expect(p.view(900 + 1139).speaker).toBe(1)
    expect(p.view(900 + 1140).speaker).toBeNull()
    expect(speakMs('x'.repeat(1000))).toBe(4000)
  })

  it('is over 2500 ms after the last one could be read', () => {
    const p = new TalkPlayer()
    expect(p.view(0).over).toBe(true)
    p.feed([say('a', 0, 'hi')], 0)
    const end = 900 + readMs('hi')
    expect(p.view(0).over).toBe(false)
    expect(p.view(end + LINGER_MS - 1).over).toBe(false)
    expect(p.view(end + LINGER_MS).over).toBe(true)
  })

  it('puts a message that arrives while others play at the end', () => {
    const p = new TalkPlayer()
    p.feed([say('a', 0, 'first')], 0)
    p.feed([say('a', 0, 'first'), say('b', 1, 'second')], 100)
    const end = 900 + readMs('first')
    expect(states(p, 100)).toEqual(['typing', 'hidden'])
    expect(states(p, end)).toEqual(['shown', 'typing'])
    // a late arrival after everything is done starts at once
    p.feed([say('a', 0, 'first'), say('b', 1, 'second'), say('c', 0, 'third', 60_000)], 60_000)
    expect(states(p, 60_000)).toEqual(['shown', 'shown', 'typing'])
  })

  it('plays only the newest 8 and shows the older ones as shown already', () => {
    const p = new TalkPlayer()
    const all = Array.from({ length: 11 }, (_, i) => say('m' + i, (i % 2) as 0 | 1, 'hi', 0))
    p.feed(all, 0)
    const s = states(p, 0)
    expect(s.slice(0, 3)).toEqual(['shown', 'shown', 'shown'])
    expect(s[3]).toBe('typing')
    expect(s.slice(4)).toEqual(['hidden', 'hidden', 'hidden', 'hidden', 'hidden', 'hidden', 'hidden'])
  })

  it('plays nothing for messages that were old when first seen', () => {
    const p = new TalkPlayer()
    p.feed([say('a', 0, 'old'), say('b', 1, 'older')], 25_000)
    expect(states(p, 25_000)).toEqual(['shown', 'shown'])
    expect(p.view(25_000).over).toBe(true)
    expect(p.view(25_000).typing).toBeNull()
  })

  it('does not play a message twice', () => {
    const p = new TalkPlayer()
    p.feed([say('a', 0, 'hi')], 0)
    p.feed([say('a', 0, 'hi')], 5000)
    expect(states(p, 5000)).toEqual(['shown'])
    expect(p.view(5000).items).toHaveLength(1)
  })
})
