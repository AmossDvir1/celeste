import { describe, expect, it } from 'vitest'
import { EMPTY_QUEUE, foldQueue, heldText, type QueueState } from './queue'
import { clockText, limitNotice, limitReset, LIMIT_WAIT_MAX_MS, type UsageWindow, type VendorUsage } from './usage'

const NOW = new Date(2026, 10, 17, 12, 0).getTime()
const HOUR = 3_600_000
const win = (key: string, label: string, percentUsed: number | null, resetsAt: number | null, extra: Partial<UsageWindow> = {}): UsageWindow => ({ key, label, percentUsed, resetsAt, ...extra })
const usage = (windows: UsageWindow[]): VendorUsage => ({ vendor: 'claude', windows, at: NOW })

describe('when a vendor that is at its limit comes back', () => {
  it('is the reset of the meter that ran out', () => {
    const u = usage([win('five_hour', '5-hour session', 100, NOW + 2 * HOUR), win('seven_day', '7-day', 30, NOW + 50 * HOUR)])
    expect(limitReset(u, NOW)).toEqual({ resetsAt: NOW + 2 * HOUR, window: '5-hour session' })
  })

  it('is the latest of several meters that ran out, since every one has to come back', () => {
    const u = usage([win('five_hour', '5-hour session', 100, NOW + 2 * HOUR), win('seven_day', '7-day', 97, NOW + 50 * HOUR)])
    expect(limitReset(u, NOW)).toEqual({ resetsAt: NOW + 50 * HOUR, window: '7-day' })
  })

  it('is not known when no meter is at its limit, none says when, it has passed, or there is no reading', () => {
    expect(limitReset(usage([win('five_hour', '5-hour session', 80, NOW + HOUR)]), NOW)).toBeNull()
    expect(limitReset(usage([win('five_hour', '5-hour session', 100, null)]), NOW)).toBeNull()
    expect(limitReset(usage([win('five_hour', '5-hour session', 100, NOW - 1000)]), NOW)).toBeNull()
    expect(limitReset(usage([win('premium', 'Premium requests', null, NOW + HOUR, { unlimited: true })]), NOW)).toBeNull()
    expect(limitReset(undefined, NOW)).toBeNull()
  })
})

describe('the line in the chat when a vendor is at its limit', () => {
  it('says who, which allowance, and when it comes back, in words and as a time of day', () => {
    const text = limitNotice({ vendor: 'claude', resetsAt: NOW + 2.5 * HOUR, window: '5-hour session' }, NOW)
    expect(text).toContain('Claude is at its limit (5-hour session).')
    expect(text).toContain('in 2 h 30 min')
    expect(text).toMatch(/around (2:30|14:30)/)
  })

  it('says so when it did not say when', () => {
    expect(limitNotice({ vendor: 'copilot' }, NOW)).toBe('GitHub Copilot is at its limit. It did not say when it comes back.')
  })

  it('writes the day when the reset is not today', () => {
    expect(clockText(NOW + 30 * HOUR, NOW)).toMatch(/Nov|\d/)
    expect(clockText(NOW + 30 * HOUR, NOW)).toContain(',')
    expect(clockText(NOW + HOUR, NOW)).not.toContain(',')
  })

  it('does not wait for a limit that lifts later than six hours from now', () => {
    expect(LIMIT_WAIT_MAX_MS).toBe(6 * HOUR)
  })
})

describe('a queue held for a limit', () => {
  const waiting = (until: number): QueueState =>
    foldQueue(foldQueue(EMPTY_QUEUE, { type: 'queue.added', id: 'a', text: 'one', attachments: [] }), { type: 'queue.waiting', until })

  it('is paused, and remembers until when', () => {
    expect(waiting(NOW + HOUR)).toMatchObject({ paused: true, waitUntil: NOW + HOUR })
  })

  it('goes on at the reset: resumed clears the wait', () => {
    const q = foldQueue(waiting(NOW + HOUR), { type: 'queue.resumed' })
    expect(q.paused).toBe(false)
    expect(q.waitUntil).toBeUndefined()
  })

  it('is an ordinary pause when the person stops a turn after that: nothing goes by itself now', () => {
    const q = foldQueue(waiting(NOW + HOUR), { type: 'queue.paused' })
    expect(q.paused).toBe(true)
    expect(q.waitUntil).toBeUndefined()
  })

  it('keeps the wait while a message is removed, and forgets it with the last one', () => {
    const two = foldQueue(waiting(NOW + HOUR), { type: 'queue.added', id: 'b', text: 'two', attachments: [] })
    expect(foldQueue(two, { type: 'queue.removed', id: 'a' })).toMatchObject({ paused: true, waitUntil: NOW + HOUR })
    expect(foldQueue(foldQueue(two, { type: 'queue.removed', id: 'a' }), { type: 'queue.removed', id: 'b' })).toEqual({ items: [], paused: false })
  })

  it('is not held when nothing waits', () => {
    expect(foldQueue(EMPTY_QUEUE, { type: 'queue.waiting', until: NOW + HOUR })).toEqual(EMPTY_QUEUE)
  })

  it('says when it goes on, while the limit is still there, and is an ordinary pause once it has lifted', () => {
    const q = waiting(NOW + HOUR)
    const clock = () => '1:00 PM'
    expect(heldText(q, false, NOW, clock)).toBe('Waiting for the limit to lift, around 1:00 PM. It goes by itself then.')
    expect(heldText(q, false, NOW + 2 * HOUR, clock)).toBe('Paused, so nothing is sent by itself.')
    expect(heldText(q, true, NOW + 2 * HOUR, clock)).toBe('Paused.')
    expect(heldText({ ...q, items: [...q.items, ...q.items] }, false, NOW, clock)).toContain('They go by themselves then.')
  })
})
