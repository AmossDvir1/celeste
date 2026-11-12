import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_LIMITS, PAUSED_APPROVAL, PAUSED_MOUSE, type DesktopAction, type DesktopBarState, type DesktopResult, type ElementsResult, type Inspection, type ResolveResult, type WindowInfo } from '@shared/desktop'
import { DesktopControl, type DesktopHost, type DesktopLogEvent } from './control'

class FakeHost implements DesktopHost {
  acted: { action: DesktopAction; at: number }[] = []
  bars: (DesktopBarState | null)[] = []
  shots = 0
  unsupportedReason: string | null = null
  refuse: string | null = null
  crash = false
  barFails = false
  windowList: WindowInfo[] = []
  windowCalls: string[][] = []
  focusResult: { ok: true; title: string; app: string } | { ok: false; reason: string } = { ok: true, title: 'Notes', app: 'notepad' }
  focused: number[] = []
  inspection: Inspection = {}
  inspected: DesktopAction[] = []
  /** How many of the next actions say the person moved the mouse. */
  moved = 0
  async windows(never: string[]) {
    this.windowCalls.push(never)
    return this.windowList
  }
  async focus(id: number) {
    this.focused.push(id)
    return this.focusResult
  }
  async inspect(action: DesktopAction) {
    this.inspected.push(action)
    return this.inspection
  }
  elementsResult: ElementsResult = { ok: true, elements: [{ id: 1, role: 'button', name: 'Save', x: 640, y: 360 }], window: 'Notes (notepad)', width: 1500, height: 844, truncated: false }
  elementCalls: (number | undefined)[] = []
  resolveResult: ResolveResult | null = null
  resolved: number[] = []
  async elements(windowId?: number) {
    this.elementCalls.push(windowId)
    return this.elementsResult
  }
  async resolve(id: number): Promise<ResolveResult> {
    this.resolved.push(id)
    return this.resolveResult ?? { ok: true, at: { x: 640, y: 360 } }
  }
  async unsupported() {
    return this.unsupportedReason
  }
  async screenshot() {
    this.shots++
    return { mime: 'image/jpeg' as const, data: 'AAAA', width: 1500, height: 844 }
  }
  async act(action: DesktopAction): Promise<DesktopResult> {
    if (this.crash) throw new Error('the driver fell over')
    if (this.moved > 0) {
      this.moved--
      return { ok: false, reason: 'The person moved the mouse.', moved: true }
    }
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
/** Where the person leaves the slider on the card (the default when not set). */
let chosen: number | undefined
let cards: { sessionId: string; title: string; detail: string; slider?: { min: number; max: number; step: number; value: number } }[]
let log: { sessionId: string; event: DesktopLogEvent }[]
let neverList: string[]
let pending: number
let control: DesktopControl

const make = () =>
  new DesktopControl({
    enabled: () => enabled,
    host,
    askConsent: async (sessionId, request) => {
      cards.push({ sessionId, ...request })
      return answer
    },
    askDuration: async (sessionId, request) => {
      cards.push({ sessionId, ...request })
      return answer ? (chosen ?? request.slider.value) : null
    },
    never: () => neverList,
    pendingApprovals: () => pending,
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
  chosen = undefined
  cards = []
  log = []
  neverList = []
  pending = 0
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
      'desktop_list_windows',
      'desktop_focus_window',
      'desktop_elements',
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
    expect(cards[0]?.detail).toContain('see everything on your main screen')
    expect(cards[0]?.title).toBe('Let the assistant control this computer')
    expect(cards[0]?.slider).toEqual({ min: 5, max: 120, step: 5, value: 20, until: 720 })
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
    let release: (v: number | null) => void = () => undefined
    control = new DesktopControl({
      enabled: () => true,
      host,
      askConsent: async () => true,
      askDuration: () => new Promise<number | null>((resolve) => (release = resolve)),
      never: () => [],
      pendingApprovals: () => 0,
      record: (sessionId, event) => log.push({ sessionId, event })
    })
    const first = control.call('s1', 'desktop_request_control', { reason: 'x' })
    await vi.advanceTimersByTimeAsync(1)
    expect(await control.call('s2', 'desktop_request_control', { reason: 'y' })).toMatchObject({ isError: true, text: expect.stringContaining('already being asked') })
    release(20)
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

  it('lists what can be clicked, with numbers and positions in the screenshot', async () => {
    const r = await run('desktop_elements', { window: 7 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('1: button “Save” at 640,360')
    expect(r.text).toContain('1500 by 844')
    expect(host.elementCalls).toEqual([7])
    host.elementsResult = { ok: false, reason: 'Take a screenshot first.' }
    expect(await run('desktop_elements')).toMatchObject({ isError: true, text: 'Take a screenshot first.' })
  })

  it('clicks an element by its number, at the point the computer gives for it, through the same checks as any click', async () => {
    host.resolveResult = { ok: true, at: { x: 321.5, y: 99 } }
    host.inspection = { label: 'Delete' }
    const r = await run('desktop_click', { id: 4 })
    expect(host.resolved).toEqual([4])
    expect(host.inspected[0]).toEqual({ type: 'click', at: { x: 321.5, y: 99 }, button: 'left', count: 1 })
    // The name of the button decides whether it asks, whether it was aimed by number or by pixel.
    expect(cards.at(-1)?.title).toContain('Delete')
    expect(r.isError).toBe(false)
  })

  it('clicks and scrolls by number when the computer allows it, and says why when it does not', async () => {
    expect((await run('desktop_double_click', { id: 2 })).isError).toBe(false)
    expect((await run('desktop_scroll', { id: 2, direction: 'down' })).isError).toBe(false)
    expect(host.acted.map((a) => a.action)).toEqual([
      { type: 'click', at: { x: 640, y: 360 }, button: 'left', count: 2 },
      { type: 'scroll', at: { x: 640, y: 360 }, dx: 0, dy: 3 }
    ])
    host.resolveResult = { ok: false, reason: 'The list is out of date. Call desktop_elements again.' }
    expect(await run('desktop_click', { id: 2 })).toMatchObject({ isError: true, text: 'The list is out of date. Call desktop_elements again.' })
    expect(host.acted).toHaveLength(2)
  })

  it('asks for an id or both x and y', async () => {
    expect(await run('desktop_click', {})).toMatchObject({ isError: true, text: expect.stringContaining('element number') })
    expect(await run('desktop_click', { x: 4 })).toMatchObject({ isError: true })
    expect(await run('desktop_click', { id: 1.5 })).toMatchObject({ isError: true })
    expect(host.resolved).toEqual([])
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
    // It had 10 minutes left of 20: now it has 15.
    expect(after).toBeGreaterThan(before + 4 * 60_000)
    expect(events('desktop.action').at(-1)?.event).toMatchObject({ text: 'Added 15 minutes', until: after })
    // Past the original end, and still on.
    await vi.advanceTimersByTimeAsync(11 * 60_000)
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

const WINDOWS: WindowInfo[] = [
  { id: 10, title: 'notes.txt - Notepad', app: 'notepad', focused: true },
  { id: 20, title: 'Inbox - Mail', app: 'chrome', focused: false }
]

describe('scope', () => {
  beforeEach(() => {
    host.windowList = WINDOWS
  })

  it('limits control to one window found by part of its title, and says so on the card, the bar and to the agent', async () => {
    const r = await control.call('s1', 'desktop_request_control', { reason: 'Save the note', window: 'notepad' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('only the window “notes.txt - Notepad” (notepad)')
    expect(cards[0]?.title).toBe('Let the assistant use “notes.txt - Notepad”')
    expect(cards[0]?.detail).toContain('and nothing else')
    expect(cards[0]?.detail).not.toContain('see everything')
    expect(host.bars.at(-1)?.scope).toEqual({ kind: 'window', id: 10, title: 'notes.txt - Notepad', app: 'notepad' })
  })

  it('limits control to one program', async () => {
    const r = await control.call('s1', 'desktop_request_control', { reason: 'Mail', app: 'Chrome.exe' })
    expect(r.isError).toBe(false)
    expect(host.bars.at(-1)?.scope).toEqual({ kind: 'app', app: 'chrome' })
    expect(cards[0]?.title).toBe('Let the assistant use chrome')
  })

  it('without either, asks for the whole screen, warns more, and suggests one window', async () => {
    await grant()
    expect(host.bars.at(-1)?.scope).toEqual({ kind: 'screen' })
    expect(cards[0]?.detail).toContain('ask it to work in one window')
  })

  it('refuses a window or a program that is not open before any card is raised, and does not say which windows are open', async () => {
    const a = await control.call('s1', 'desktop_request_control', { reason: 'x', window: 'banking' })
    expect(a).toMatchObject({ isError: true, text: expect.stringContaining('No open window has “banking”') })
    expect(a.text).not.toContain('Inbox')
    const b = await control.call('s1', 'desktop_request_control', { reason: 'x', app: 'photoshop' })
    expect(b).toMatchObject({ isError: true, text: expect.stringContaining('No open window belongs to a program called “photoshop”') })
    expect(cards).toEqual([])
    expect(control.active()).toBe(false)
  })

  it('refuses both an app and a window at once', async () => {
    expect(await control.call('s1', 'desktop_request_control', { reason: 'x', app: 'a', window: 'b' })).toMatchObject({ isError: true })
    expect(cards).toEqual([])
  })

  it('does not offer a window that is on the never list: it asks the host without it', async () => {
    neverList = ['mail']
    await control.call('s1', 'desktop_request_control', { reason: 'x', window: 'inbox' })
    expect(host.windowCalls[0]).toEqual(['mail'])
  })

  it('says on the card which programs stay hidden, and gives the list to the host with the bar', async () => {
    neverList = ['keepass', 'my bank']
    await grant()
    expect(cards[0]?.detail).toContain('Hidden and never touched, whatever it asks: keepass, my bank.')
    expect(host.bars.at(-1)?.never).toEqual(['keepass', 'my bank'])
  })

  it('reads the never list again whenever the bar is updated, so a change in Settings counts at once', async () => {
    await grant()
    neverList = ['vault']
    await run('desktop_click', { x: 1, y: 1 })
    expect(host.bars.at(-1)?.never).toEqual(['vault'])
  })

  it('does not start when the windows cannot be read', async () => {
    host.windows = async () => {
      throw new Error('no windows today')
    }
    expect(await control.call('s1', 'desktop_request_control', { reason: 'x', app: 'notepad' })).toMatchObject({ isError: true, text: expect.stringContaining('no windows today') })
    expect(cards).toEqual([])
  })
})

describe('the windows', () => {
  beforeEach(async () => {
    host.windowList = WINDOWS
    await grant()
  })

  it('lists them with their numbers, and which is in front', async () => {
    const r = await run('desktop_list_windows')
    expect(r.isError).toBe(false)
    expect(r.text).toBe('10: “notes.txt - Notepad” (notepad) — in front\n20: “Inbox - Mail” (chrome)')
    expect(host.windowCalls.at(-1)).toEqual([])
  })

  it('says when there are none, and when they cannot be listed', async () => {
    host.windowList = []
    expect(await run('desktop_list_windows')).toMatchObject({ isError: false, text: expect.stringContaining('No window') })
    host.windows = async () => {
      throw new Error('boom')
    }
    expect(await run('desktop_list_windows')).toMatchObject({ isError: true, text: expect.stringContaining('boom') })
  })

  it('needs control, like every other tool', async () => {
    control.stop('done')
    expect(await control.call('s1', 'desktop_list_windows', {})).toMatchObject({ isError: true, text: expect.stringContaining('desktop_request_control') })
    expect(await control.call('s1', 'desktop_focus_window', { id: 10 })).toMatchObject({ isError: true })
    expect(host.focused).toEqual([])
  })

  it('brings a window to the front, and records it like any action', async () => {
    const r = await run('desktop_focus_window', { id: 20 })
    expect(r).toMatchObject({ isError: false, text: expect.stringContaining('Bring “Notes” to the front') })
    expect(host.focused).toEqual([20])
    expect(events('desktop.action').at(-1)?.event).toMatchObject({ text: 'Bring “Notes” to the front', ok: true })
  })

  it('passes on a refusal and records it as refused', async () => {
    host.focusResult = { ok: false, reason: 'That window is outside what you were given.' }
    const r = await run('desktop_focus_window', { id: 20 })
    expect(r).toMatchObject({ isError: true, text: 'Refused: That window is outside what you were given.' })
    expect(events('desktop.action').at(-1)?.event).toMatchObject({ ok: false })
  })

  it('wants a whole number', async () => {
    expect(await run('desktop_focus_window', { id: 'the mail one' })).toMatchObject({ isError: true, text: expect.stringContaining('Invalid arguments') })
    expect(host.focused).toEqual([])
  })
})

describe('passwords, and buttons that cannot be taken back', () => {
  beforeEach(async () => grant())

  it('does not type into a password field, says so, and records it as refused', async () => {
    host.inspection = { password: true, label: 'Password' }
    const r = await run('desktop_type', { text: 'hunter2' })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('password field') })
    expect(host.acted).toEqual([])
    expect(events('desktop.action').at(-1)?.event).toMatchObject({ ok: false })
    // What it tried to type is a secret: it is not kept, and not shown on the bar either.
    expect(JSON.stringify(log)).not.toContain('hunter2')
    expect(host.bars.at(-1)?.lines).toEqual(['Refused: Type into a password field'])
  })

  it('types as normal into any other field, and when the system cannot say what it is', async () => {
    host.inspection = { password: false, label: 'Name' }
    expect((await run('desktop_type', { text: 'Dana' })).isError).toBe(false)
    host.inspection = {}
    expect((await run('desktop_type', { text: 'Dana' })).isError).toBe(false)
    host.inspect = async () => {
      throw new Error('UI Automation is not available.')
    }
    expect((await run('desktop_type', { text: 'Dana' })).isError).toBe(false)
    expect(host.acted).toHaveLength(3)
  })

  it('asks the person before pressing a button called Delete, and presses it only on yes', async () => {
    host.inspection = { label: 'Delete all my files' }
    answer = true
    const r = await run('desktop_click', { x: 1, y: 1 })
    expect(r.isError).toBe(false)
    expect(cards.at(-1)?.title).toBe('Let the assistant press “Delete all my files”')
    expect(cards.at(-1)?.detail).toContain('cannot be taken back')
    expect(host.acted).toHaveLength(1)
  })

  it('does not press it on no, and tells the assistant not to try again', async () => {
    host.inspection = { label: 'Send' }
    answer = false
    const r = await run('desktop_click', { x: 1, y: 1 })
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('did not allow pressing “Send”') })
    expect(host.acted).toEqual([])
    expect(events('desktop.action').at(-1)?.event).toMatchObject({ ok: false, text: expect.stringContaining('not allowed') })
    expect(control.active('s1')).toBe(true)
  })

  it('does not ask about an ordinary button, a right click, or a key that presses nothing', async () => {
    host.inspection = { label: 'Open' }
    await run('desktop_click', { x: 1, y: 1 })
    host.inspection = { label: 'Delete' }
    await run('desktop_click', { x: 1, y: 1, button: 'right' })
    await run('desktop_key', { keys: 'ctrl+c' })
    await run('desktop_move', { x: 1, y: 1 })
    expect(cards).toHaveLength(1) // only the card that started control
    expect(host.acted).toHaveLength(4)
  })

  it('asks for Enter and Space as well, since they press what has the keyboard', async () => {
    host.inspection = { label: 'Submit order' }
    answer = false
    expect((await run('desktop_key', { keys: 'enter' })).isError).toBe(true)
    expect((await run('desktop_key', { keys: 'space' })).isError).toBe(true)
    expect(cards).toHaveLength(3)
    expect(host.acted).toEqual([])
  })

  it('shows on the bar that it is waiting for an answer while the question is open, and stops waiting after it', async () => {
    host.inspection = { label: 'Buy now' }
    let release: (v: boolean) => void = () => undefined
    let asked = 0
    control = new DesktopControl({
      enabled: () => true,
      host,
      askConsent: (sessionId, request) => {
        cards.push({ sessionId, ...request })
        asked++
        return new Promise<boolean>((resolve) => (release = resolve))
      },
      askDuration: async () => 20,
      never: () => [],
      pendingApprovals: () => 0,
      record: (sessionId, event) => log.push({ sessionId, event })
    })
    await grant()
    const p = control.call('s1', 'desktop_click', { x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs + 10)
    expect(host.bars.at(-1)?.paused).toBe(PAUSED_APPROVAL)
    release(true)
    expect((await p).isError).toBe(false)
    expect(host.bars.at(-1)?.paused).toBeNull()
  })

  it('does not end control when the person says no', async () => {
    host.inspection = { label: 'Delete' }
    answer = false
    await run('desktop_click', { x: 1, y: 1 })
    host.inspection = {}
    expect((await run('desktop_click', { x: 2, y: 2 })).isError).toBe(false)
  })
})

describe('the person’s own hand wins', () => {
  beforeEach(async () => grant())

  it('pauses when the person moved the mouse, shows it on the bar, and carries on after Continue with the same action', async () => {
    host.moved = 1
    const p = control.call('s1', 'desktop_click', { x: 4, y: 4 })
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs + 10)
    expect(host.bars.at(-1)?.paused).toBe(PAUSED_MOUSE)
    expect(host.acted).toEqual([])
    control.resume()
    await vi.advanceTimersByTimeAsync(500)
    expect(await p).toMatchObject({ isError: false })
    expect(host.acted.map((a) => a.action)).toEqual([{ type: 'click', at: { x: 4, y: 4 }, button: 'left', count: 1 }])
    expect(host.bars.at(-1)?.paused).toBeNull()
    expect(events('desktop.action').map((e) => (e.event as { text: string }).text)).toEqual(['You moved the mouse: paused', 'You pressed Continue', 'Click at (4, 4)'])
    expect(events('desktop.action').slice(0, 2).map((e) => (e.event as { note?: boolean }).note)).toEqual([true, true])
  })

  it('makes the next calls wait while it is paused, and gives the agent a message if the person does not come back', async () => {
    host.moved = 1
    const first = control.call('s1', 'desktop_click', { x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs + 10)
    const second = control.call('s1', 'desktop_type', { text: 'a' })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await first).toMatchObject({ isError: true, text: expect.stringContaining('moved the mouse and has not pressed Continue') })
    // The second waited its turn, and then waits for its own minute.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await second).toMatchObject({ isError: true, text: expect.stringContaining('has not pressed Continue') })
    expect(host.acted).toEqual([])
    // Still paused: Continue is still what the person has to press.
    expect(host.bars.at(-1)?.paused).toBe(PAUSED_MOUSE)
    control.resume()
    expect((await run('desktop_click', { x: 1, y: 1 })).isError).toBe(false)
  })

  it('ends the wait when control ends', async () => {
    host.moved = 1
    const p = control.call('s1', 'desktop_click', { x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs + 10)
    control.stop('You pressed Stop.')
    expect(await p).toMatchObject({ isError: true, text: 'Control has ended.' })
    expect(host.acted).toEqual([])
  })

  it('ignores Continue when it is not paused', async () => {
    control.resume()
    expect(events('desktop.action')).toEqual([])
  })

  it('waits while a question in Celeste is open, and goes on when it is answered', async () => {
    pending = 1
    const p = control.call('s1', 'desktop_click', { x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(DESKTOP_LIMITS.minGapMs + 10)
    expect(host.acted).toEqual([])
    expect(host.bars.at(-1)?.paused).toBe(PAUSED_APPROVAL)
    pending = 0
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toMatchObject({ isError: false })
    expect(host.acted).toHaveLength(1)
    expect(host.bars.at(-1)?.paused).toBeNull()
  })

  it('gives the agent a message when the question is still open after a minute', async () => {
    pending = 1
    const p = control.call('s1', 'desktop_click', { x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await p).toMatchObject({ isError: true, text: expect.stringContaining('answer a question in Celeste') })
    expect(host.acted).toEqual([])
    expect(control.active('s1')).toBe(true)
  })

  it('does not count other chats’ questions', async () => {
    const seen: string[] = []
    control = new DesktopControl({
      enabled: () => true,
      host,
      askConsent: async () => true,
      askDuration: async () => 20,
      never: () => [],
      pendingApprovals: (sessionId) => {
        seen.push(sessionId)
        return sessionId === 'other' ? 5 : 0
      },
      record: (sessionId, event) => log.push({ sessionId, event })
    })
    await grant()
    expect((await run('desktop_click', { x: 1, y: 1 })).isError).toBe(false)
    expect(new Set(seen)).toEqual(new Set(['s1']))
  })
})

describe('how long, and the list of grants', () => {
  /** The minutes the person leaves the slider at; the card's own start when not set. */
  let length: number | undefined
  let kept: unknown[]
  const makeWith = () =>
    new DesktopControl({
      enabled: () => true,
      host,
      askConsent: async (sessionId, request) => {
        cards.push({ sessionId, ...request })
        return true
      },
      askDuration: async (sessionId, request) => {
        cards.push({ sessionId, ...request })
        return length ?? request.slider.value
      },
      never: () => [],
      logGrant: (entry) => kept.push(entry),
      pendingApprovals: () => 0,
      record: (sessionId, event) => log.push({ sessionId, event }),
      clock: () => 'noon'
    })
  beforeEach(() => {
    length = undefined
    kept = []
  })

  it('lasts 20 minutes unless the slider is moved', async () => {
    control = makeWith()
    const before = Date.now()
    await grant()
    const until = host.bars.at(-1)?.until as number
    expect(until).toBeGreaterThanOrEqual(before + 20 * 60_000)
    expect(until).toBeLessThan(before + 21 * 60_000)
  })

  it('lasts as long as the person set the slider to', async () => {
    length = 60
    control = makeWith()
    const before = Date.now()
    await grant()
    expect(cards[0]?.slider).toMatchObject({ min: 5, max: 120, value: 20 })
    expect(host.bars.at(-1)?.until).toBeGreaterThanOrEqual(before + 60 * 60_000)
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    // Nothing was done for five minutes, which ends it whatever the length.
    expect(await control.call('s1', 'desktop_click', { x: 1, y: 1 })).toMatchObject({ isError: true, text: expect.stringContaining('nothing was done') })
  })

  it('can be given two hours at most', async () => {
    length = 120
    control = makeWith()
    const before = Date.now()
    await grant()
    expect(host.bars.at(-1)?.until).toBeGreaterThanOrEqual(before + 120 * 60_000)
    expect(host.bars.at(-1)?.until).toBeLessThan(before + 121 * 60_000)
    control.extend()
    await vi.advanceTimersByTimeAsync(1)
    // +15 min cannot take it past two hours from now.
    expect(host.bars.at(-1)?.until).toBeLessThanOrEqual(Date.now() + 120 * 60_000)
  })

  it('stays on for “until I stop it” as long as it is used, and still ends after five minutes of nothing', async () => {
    length = 720
    control = makeWith()
    await grant()
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      expect((await run('desktop_click', { x: 1, y: 1 })).isError).toBe(false)
    }
    expect(control.active('s1')).toBe(true)
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(await control.call('s1', 'desktop_click', { x: 1, y: 1 })).toMatchObject({ isError: true, text: expect.stringContaining('nothing was done') })
  })

  it('does not shorten a long grant when +15 min is pressed', async () => {
    length = 60
    control = makeWith()
    await grant()
    const before = host.bars.at(-1)?.until as number
    control.extend()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.bars.at(-1)?.until).toBe(before)
  })

  it('adds time when +15 min is pressed late in a short grant', async () => {
    length = 5
    control = makeWith()
    await grant()
    const before = host.bars.at(-1)?.until as number
    control.extend()
    await vi.advanceTimersByTimeAsync(1)
    expect(host.bars.at(-1)?.until).toBeGreaterThan(before)
  })

  it('asks for the whole screen on the card, with the warning and the way out, and names a window without the length', async () => {
    host.windowList = [{ id: 10, title: 'notes.txt - Notepad', app: 'notepad', focused: true }]
    control = makeWith()
    await control.call('s1', 'desktop_request_control', { reason: 'x' })
    expect(cards[0]?.title).toBe('Let the assistant control this computer')
    expect(cards[0]?.detail).toContain('ask it to work in one window')
    control.stop('done')
    await control.call('s1', 'desktop_request_control', { reason: 'x', window: 'notepad' })
    expect(cards[1]?.title).toBe('Let the assistant use “notes.txt - Notepad”')
  })

  it('keeps a record of each grant when it ends: when, why, what it could use, how long, how many actions, how it ended', async () => {
    host.windowList = [{ id: 10, title: 'notes.txt - Notepad', app: 'notepad', focused: true }]
    control = makeWith()
    const start = Date.now()
    await control.call('s1', 'desktop_request_control', { reason: 'Save the note', window: 'notepad' })
    await run('desktop_click', { x: 1, y: 1 })
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    control.stop('You pressed Stop.')
    control.stop('again')
    expect(kept).toEqual([{ at: start, sessionId: 's1', reason: 'Save the note', scope: 'only the window “notes.txt - Notepad” (notepad)', ms: expect.any(Number), actions: 1, why: 'You pressed Stop.' }])
    expect((kept[0] as { ms: number }).ms).toBeGreaterThanOrEqual(2 * 60_000)
  })

  it('ends normally when keeping the record fails', async () => {
    control = new DesktopControl({
      enabled: () => true,
      host,
      askConsent: async () => true,
      askDuration: async () => 20,
      never: () => [],
      logGrant: () => {
        throw new Error('disk full')
      },
      pendingApprovals: () => 0,
      record: (sessionId, event) => log.push({ sessionId, event })
    })
    await grant()
    control.stop('done')
    expect(control.active()).toBe(false)
    expect(events('desktop.ended')).toHaveLength(1)
  })
})
