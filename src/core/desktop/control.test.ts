import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_LIMITS, type DesktopAction, type DesktopBarState, type DesktopResult } from '@shared/desktop'
import { DesktopControl, type DesktopHost, type DesktopLogEvent } from './control'

class FakeHost implements DesktopHost {
  acted: { action: DesktopAction; at: number }[] = []
  bars: (DesktopBarState | null)[] = []
  shots = 0
  unsupportedReason: string | null = null
  refuse: string | null = null
  crash = false
  barFails = false
  async unsupported() {
    return this.unsupportedReason
  }
  async screenshot() {
    this.shots++
    return { mime: 'image/jpeg' as const, data: 'AAAA', width: 1500, height: 844 }
  }
  async act(action: DesktopAction): Promise<DesktopResult> {
    if (this.crash) throw new Error('the driver fell over')
    this.acted.push({ action, at: Date.now() })
    return this.refuse ? { ok: false, reason: this.refuse } : { ok: true }
  }
  async bar(state: DesktopBarState | null) {
    if (this.barFails && state) throw new Error('the bar would not open')
    this.bars.push(state)
  }
}

let host: FakeHost
let enabled: boolean
let answer: boolean
let cards: { sessionId: string; title: string; detail: string }[]
let log: { sessionId: string; event: DesktopLogEvent }[]
let control: DesktopControl

const make = () =>
  new DesktopControl({
    enabled: () => enabled,
    host,
    askConsent: async (sessionId, request) => {
      cards.push({ sessionId, ...request })
      return answer
    },
    record: (sessionId, event) => log.push({ sessionId, event }),
    clock: () => 'noon'
  })

/** A call, with time moving on so the pause between actions passes. */
async function run(name: string, args: unknown = {}, session = 's1') {
  const p = control.call(session, name, args)
  await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs + 10)
  return p
}
const grant = async (session = 's1') => {
  const r = await control.call(session, 'desktop_request_control', { reason: 'Change the default browser' })
  expect(r.isError).toBe(false)
}
const events = (type: DesktopLogEvent['type']) => log.filter((l) => l.event.type === type)

beforeEach(() => {
  vi.useFakeTimers()
  host = new FakeHost()
  enabled = true
  answer = true
  cards = []
  log = []
  control = make()
})
afterEach(() => {
  control.stop('test over')
  vi.useRealTimers()
})

describe('the tools', () => {
  it('lists every tool, none of them read only (an agent that is only planning must not use the screen)', () => {
    const names = control.list().map((t) => t.name)
    expect(names).toEqual([
      'desktop_request_control',
      'desktop_release_control',
      'desktop_screenshot',
      'desktop_move',
      'desktop_click',
      'desktop_double_click',
      'desktop_drag',
      'desktop_scroll',
      'desktop_type',
      'desktop_key',
      'desktop_wait'
    ])
    expect(control.list().every((t) => !t.readOnly)).toBe(true)
  })

  it('does not know other tools', async () => {
    expect(await control.call('s1', 'desktop_format_disk', {})).toMatchObject({ isError: true })
  })
})

describe('asking', () => {
  it('is refused while the switch in Settings is off, and no card is raised', async () => {
    enabled = false
    const r = await control.call('s1', 'desktop_request_control', { reason: 'x' })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('switched off') })
    expect(cards).toEqual([])
    expect(host.bars).toEqual([])
  })

  it('refuses every other tool without a grant, and says what to do', async () => {
    for (const [name, args] of [
      ['desktop_screenshot', {}],
      ['desktop_click', { x: 1, y: 1 }],
      ['desktop_type', { text: 'a' }],
      ['desktop_key', { keys: 'enter' }],
      ['desktop_wait', { seconds: 1 }]
    ] as const) {
      const r = await control.call('s1', name, args)
      expect(r).toMatchObject({ isError: true, text: expect.stringContaining('desktop_request_control') })
    }
    expect(host.acted).toEqual([])
    expect(host.shots).toBe(0)
  })

  it('raises Celeste’s own card with the reason and what the screen shows, and starts only on yes', async () => {
    await grant()
    expect(cards).toHaveLength(1)
    expect(cards[0]?.detail).toContain('Change the default browser')
    expect(cards[0]?.detail).toContain('see everything on your screen')
    expect(cards[0]?.title).toContain('15 minutes')
    expect(host.bars.at(-1)).toMatchObject({ sessionId: 's1', lines: [] })
    expect(events('desktop.started')).toHaveLength(1)
    expect(control.active('s1')).toBe(true)
    expect(control.active('s2')).toBe(false)
  })

  it('tells the agent how to use it, including that it must never type a secret', async () => {
    const r = await control.call('s1', 'desktop_request_control', { reason: 'x' })
    expect(r.text).toContain('until noon')
    expect(r.text).toContain('desktop_screenshot')
    expect(r.text).toMatch(/never type a password/)
  })

  it('on no, does nothing, and the agent cannot ask again in that chat', async () => {
    answer = false
    const first = await control.call('s1', 'desktop_request_control', { reason: 'x' })
    expect(first).toMatchObject({ isError: true, text: expect.stringContaining('said no') })
    answer = true
    const again = await control.call('s1', 'desktop_request_control', { reason: 'please' })
    expect(again).toMatchObject({ isError: true, text: expect.stringContaining('Do not ask again') })
    expect(cards).toHaveLength(1)
    expect(control.active()).toBe(false)
    expect(host.bars).toEqual([])
    // Another chat has its own say.
    expect((await control.call('s2', 'desktop_request_control', { reason: 'x' })).isError).toBe(false)
  })

  it('can be asked again in a chat once it is forgotten', async () => {
    answer = false
    await control.call('s1', 'desktop_request_control', { reason: 'x' })
    control.forget('s1')
    answer = true
    expect((await control.call('s1', 'desktop_request_control', { reason: 'x' })).isError).toBe(false)
  })

  it('asks for a reason, and not for an empty or very long one', async () => {
    expect((await control.call('s1', 'desktop_request_control', {})).isError).toBe(true)
    expect((await control.call('s1', 'desktop_request_control', { reason: '' })).isError).toBe(true)
    expect((await control.call('s1', 'desktop_request_control', { reason: 'x'.repeat(301) })).isError).toBe(true)
    expect(cards).toEqual([])
  })

  it('says so when this computer cannot do it', async () => {
    host.unsupportedReason = 'Desktop control works on Windows for now.'
    const r = await control.call('s1', 'desktop_request_control', { reason: 'x' })
    expect(r).toMatchObject({ isError: true, text: 'Desktop control works on Windows for now.' })
    expect(cards).toEqual([])
  })

  it('is not started with a second card while one is on screen', async () => {
    let release: (v: boolean) => void = () => undefined
    control = new DesktopControl({
      enabled: () => true,
      host,
      askConsent: () => new Promise<boolean>((resolve) => (release = resolve)),
      record: (sessionId, event) => log.push({ sessionId, event })
    })
    const first = control.call('s1', 'desktop_request_control', { reason: 'x' })
    await vi.advanceTimersByTimeAsync(1)
    expect(await control.call('s2', 'desktop_request_control', { reason: 'y' })).toMatchObject({ isError: true, text: expect.stringContaining('already being asked') })
    release(true)
    expect((await first).isError).toBe(false)
  })

  it('does not start if the bar and the stop key cannot be shown', async () => {
    host.barFails = true
    const r = await control.call('s1', 'desktop_request_control', { reason: 'x' })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('could not start') })
    expect(control.active()).toBe(false)
    expect(events('desktop.ended')).toHaveLength(1)
    expect(await control.call('s1', 'desktop_click', { x: 1, y: 1 })).toMatchObject({ isError: true })
    expect(host.acted).toEqual([])
  })

  it('says yes again, quietly, to a chat that already has control', async () => {
    await grant()
    const r = await control.call('s1', 'desktop_request_control', { reason: 'more' })
    expect(r).toMatchObject({ isError: false, text: expect.stringContaining('already have control') })
    expect(cards).toHaveLength(1)
  })
})

describe('one chat at a time', () => {
  it('lets another chat neither use the grant nor ask while it lasts', async () => {
    await grant('s1')
    expect(await run('desktop_click', { x: 5, y: 5 }, 's2')).toMatchObject({ isError: true, text: expect.stringContaining('desktop_request_control') })
    expect(await control.call('s2', 'desktop_screenshot', {})).toMatchObject({ isError: true })
    expect(await control.call('s2', 'desktop_request_control', { reason: 'x' })).toMatchObject({ isError: true, text: expect.stringContaining('Another chat') })
    expect(host.acted).toEqual([])
    expect(cards).toHaveLength(1)
  })

  it('does not let another chat end it', async () => {
    await grant('s1')
    expect(await control.call('s2', 'desktop_release_control', {})).toMatchObject({ isError: false, text: expect.stringContaining('did not have control') })
    expect(control.active('s1')).toBe(true)
  })
})

describe('seeing and doing', () => {
  beforeEach(async () => grant())

  it('gives a screenshot with its size and the picture', async () => {
    const r = await control.call('s1', 'desktop_screenshot', {})
    expect(r.isError).toBe(false)
    expect(r.image).toEqual({ mime: 'image/jpeg', data: 'AAAA' })
    expect(r.text).toContain('1500 by 844')
  })

  it('turns each tool into the right action', async () => {
    await run('desktop_move', { x: 10, y: 20 })
    await run('desktop_click', { x: 1, y: 2 })
    await run('desktop_click', { x: 3, y: 4, button: 'right' })
    await run('desktop_double_click', { x: 5, y: 6 })
    await run('desktop_drag', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 })
    await run('desktop_scroll', { x: 7, y: 8, direction: 'down' })
    await run('desktop_scroll', { x: 7, y: 8, direction: 'left', amount: 5 })
    await run('desktop_type', { text: 'hello' })
    await run('desktop_key', { keys: 'Ctrl+C' })
    expect(host.acted.map((a) => a.action)).toEqual([
      { type: 'move', at: { x: 10, y: 20 } },
      { type: 'click', at: { x: 1, y: 2 }, button: 'left', count: 1 },
      { type: 'click', at: { x: 3, y: 4 }, button: 'right', count: 1 },
      { type: 'click', at: { x: 5, y: 6 }, button: 'left', count: 2 },
      { type: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
      { type: 'scroll', at: { x: 7, y: 8 }, dx: 0, dy: 3 },
      { type: 'scroll', at: { x: 7, y: 8 }, dx: -5, dy: 0 },
      { type: 'type', text: 'hello' },
      { type: 'key', keys: 'Ctrl+C' }
    ])
  })

  it('records each action in the conversation and on the bar, newest last, a few at a time', async () => {
    for (let i = 1; i <= 5; i++) await run('desktop_click', { x: i, y: i })
    expect(events('desktop.action').map((e) => (e.event as { text: string }).text)).toEqual(['Click at (1, 1)', 'Click at (2, 2)', 'Click at (3, 3)', 'Click at (4, 4)', 'Click at (5, 5)'])
    expect(host.bars.at(-1)?.lines).toEqual(['Click at (3, 3)', 'Click at (4, 4)', 'Click at (5, 5)'])
  })

  it('passes on a refusal from the computer with its reason, and records it as refused', async () => {
    host.refuse = 'That point is inside a Celeste window.'
    const r = await run('desktop_click', { x: 1, y: 1 })
    expect(r).toMatchObject({ isError: true, text: 'Refused: That point is inside a Celeste window.' })
    expect(events('desktop.action')[0]?.event).toMatchObject({ ok: false })
    expect(host.bars.at(-1)?.lines).toEqual(['Refused: Click at (1, 1)'])
    expect(control.active('s1')).toBe(true)
  })

  it('does not fall over when the computer does', async () => {
    host.crash = true
    const r = await run('desktop_click', { x: 1, y: 1 })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('the driver fell over') })
  })

  it('never sends the keys that lock the computer, or the stop key', async () => {
    for (const keys of ['win+l', 'ctrl+alt+delete', 'Ctrl+Alt+Esc']) {
      expect(await run('desktop_key', { keys })).toMatchObject({ isError: true, text: expect.stringContaining('Refused') })
    }
    expect(await run('desktop_key', { keys: 'hyper+q' })).toMatchObject({ isError: true })
    expect(host.acted).toEqual([])
  })

  it('refuses text that is too long, and arguments that are not numbers', async () => {
    expect(await run('desktop_type', { text: 'x'.repeat(DESKTOP_LIMITS.maxTextLength + 1) })).toMatchObject({ isError: true, text: expect.stringContaining('most at once') })
    expect(await run('desktop_click', { x: 'left', y: 1 })).toMatchObject({ isError: true, text: expect.stringContaining('Invalid arguments') })
    expect(await run('desktop_scroll', { x: 1, y: 1, direction: 'sideways' })).toMatchObject({ isError: true })
    expect(await run('desktop_scroll', { x: 1, y: 1, direction: 'down', amount: 99 })).toMatchObject({ isError: true })
    expect(host.acted).toEqual([])
  })

  it('waits, but not longer than the limit', async () => {
    const p = control.call('s1', 'desktop_wait', { seconds: 2 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toMatchObject({ isError: false, text: 'Waited 2 seconds.' })
    const long = control.call('s1', 'desktop_wait', { seconds: 60 })
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.maxWaitSeconds * 1000)
    expect(await long).toMatchObject({ isError: false, text: `Waited ${DESKTOP_LIMITS.maxWaitSeconds} seconds.` })
  })
})

describe('limits', () => {
  beforeEach(async () => grant())

  it('slows a loop: two actions are never closer than the gap', async () => {
    const calls = [1, 2, 3].map((i) => control.call('s1', 'desktop_click', { x: i, y: i }))
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs * 5)
    await Promise.all(calls)
    const times = host.acted.map((a) => a.at)
    expect(times).toHaveLength(3)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(DESKTOP_LIMITS.minGapMs)
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(DESKTOP_LIMITS.minGapMs)
  })

  it('does one thing at a time, in the order asked', async () => {
    const calls = [1, 2, 3].map((i) => control.call('s1', 'desktop_click', { x: i, y: 0 }))
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs * 5)
    await Promise.all(calls)
    expect(host.acted.map((a) => (a.action as { at: { x: number } }).at.x)).toEqual([1, 2, 3])
  })

  it('ends after the most actions in one go', async () => {
    for (let i = 0; i < DESKTOP_LIMITS.maxActions; i++) {
      // Keep the grant from running out of time or going idle on the way: this is only about the count.
      expect((await run('desktop_click', { x: 1, y: 1 })).isError).toBe(false)
      if (i % 40 === 0) control.extend()
    }
    const r = await run('desktop_click', { x: 1, y: 1 })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('most actions') })
    expect(control.active()).toBe(false)
    expect(events('desktop.ended').at(-1)?.event).toMatchObject({ actions: DESKTOP_LIMITS.maxActions })
  })

  it('ends when the time is up, tells the agent, and takes the bar down', async () => {
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.grantMs + 1000)
    expect(control.active()).toBe(false)
    expect(host.bars.at(-1)).toBeNull()
    expect(events('desktop.ended').at(-1)?.event).toMatchObject({ why: 'The time ran out.' })
    expect(await control.call('s1', 'desktop_click', { x: 1, y: 1 })).toMatchObject({ isError: true })
    expect(host.acted).toEqual([])
  })

  it('ends when nothing is done for a while, even with time left', async () => {
    control.extend()
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.idleMs + 1000)
    const r = await control.call('s1', 'desktop_click', { x: 1, y: 1 })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('nothing was done') })
    expect(control.active()).toBe(false)
  })

  it('is lengthened by the bar’s +15 minutes, and that is recorded', async () => {
    const before = host.bars.at(-1)?.until as number
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    control.extend()
    await vi.advanceTimersByTimeAsync(1)
    const after = host.bars.at(-1)?.until as number
    expect(after).toBeGreaterThan(before + 9 * 60_000)
    expect(events('desktop.action').at(-1)?.event).toMatchObject({ text: 'Added 15 minutes', until: after })
    // Past the original end, and still on.
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(control.active()).toBe(true)
  })

  it('ends if the switch in Settings is turned off while it runs', async () => {
    enabled = false
    const r = await run('desktop_click', { x: 1, y: 1 })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('switched off') })
    expect(control.active()).toBe(false)
    expect(host.acted).toEqual([])
  })
})

describe('stopping', () => {
  beforeEach(async () => grant())

  it('ends at once when the person presses Stop, whatever is going on', async () => {
    const waiting = control.call('s1', 'desktop_wait', { seconds: 9 })
    await vi.advanceTimersByTimeAsync(100)
    control.stop('You pressed Stop.')
    expect(await waiting).toMatchObject({ isError: true, text: expect.stringContaining('ended while waiting') })
    expect(control.active()).toBe(false)
    expect(host.bars.at(-1)).toBeNull()
    expect(events('desktop.ended').at(-1)?.event).toMatchObject({ why: 'You pressed Stop.' })
    expect(await control.call('s1', 'desktop_click', { x: 1, y: 1 })).toMatchObject({ isError: true })
    expect(host.acted).toEqual([])
  })

  it('drops the actions that are waiting their turn', async () => {
    const calls = [1, 2, 3].map((i) => control.call('s1', 'desktop_click', { x: i, y: i }))
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs + 20)
    control.stop('You pressed Stop.')
    await vi.advanceTimersByTimeAsync(5000)
    const results = await Promise.all(calls)
    expect(host.acted.length).toBeLessThanOrEqual(1)
    expect(results.slice(1).every((r) => r.isError)).toBe(true)
  })

  it('ends only once, and is quiet when there is nothing to end', async () => {
    control.stop('one')
    control.stop('two')
    expect(events('desktop.ended')).toHaveLength(1)
  })

  it('ends when the agent says it is done', async () => {
    expect(await control.call('s1', 'desktop_release_control', {})).toMatchObject({ isError: false })
    expect(control.active()).toBe(false)
    expect(events('desktop.ended').at(-1)?.event).toMatchObject({ why: 'The assistant said it was done.' })
  })

  it('ends with the chat, when it is stopped or deleted', async () => {
    control.sessionGone('s2')
    expect(control.active('s1')).toBe(true)
    control.sessionGone('s1')
    expect(control.active()).toBe(false)
    expect(host.bars.at(-1)).toBeNull()
  })

  it('records how many actions were done', async () => {
    await run('desktop_click', { x: 1, y: 1 })
    host.refuse = 'no'
    await run('desktop_click', { x: 1, y: 1 })
    control.stop('done')
    expect(events('desktop.ended')[0]?.event).toMatchObject({ actions: 1 })
  })

  it('can be asked for again after it ended', async () => {
    control.stop('done')
    expect((await control.call('s1', 'desktop_request_control', { reason: 'again' })).isError).toBe(false)
    expect(cards).toHaveLength(2)
  })
})
