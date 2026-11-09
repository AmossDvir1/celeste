import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBarState, Rect } from '@shared/desktop'

// The real service, with the screen, the windows, the keyboard hook and the input stood in for. What is checked is what the service
// decides: what it refuses, what it converts, and that it is always possible to stop it.
const s = vi.hoisted(() => {
  interface FakeWindow {
    isDestroyed(): boolean
    isVisible(): boolean
    isMinimized(): boolean
    getBounds(): Rect
    isFocused(): boolean
    setContentProtection(on: boolean): void
    protectedNow: boolean
  }
  return {
    windows: [] as FakeWindow[],
    barWindows: [] as FakeWindow[],
    shortcuts: new Map<string, () => void>(),
    registerOk: true,
    barFails: false,
    bar: null as unknown,
    barHandlers: undefined as undefined | { onStop(): void; onExtend(): void },
    capture: { shot: { mime: 'image/jpeg' as const, data: 'AAAA', width: 1500, height: 844 }, geometry: { origin: { x: 0, y: 0 }, scaleX: 1.28, scaleY: 1.28, width: 1500, height: 844 } },
    calls: [] as string[],
    driverFails: false
  }
})

vi.mock('electron', () => ({
  app: { on: vi.fn(), off: vi.fn() },
  BrowserWindow: { getAllWindows: () => [...s.windows, ...s.barWindows] },
  globalShortcut: {
    register: (key: string, cb: () => void) => {
      if (s.registerOk) s.shortcuts.set(key, cb)
      return s.registerOk
    },
    unregister: (key: string) => void s.shortcuts.delete(key)
  },
  screen: { dipToScreenRect: (_w: unknown, r: Rect) => r }
}))

vi.mock('./bar', () => ({
  ControlBar: class {
    constructor(handlers: { onStop(): void; onExtend(): void }) {
      s.barHandlers = handlers
    }
    windows() {
      return s.barWindows
    }
    isBorder() {
      return false
    }
    async show(state: DesktopBarState) {
      if (s.barFails) throw new Error('no bar')
      s.bar = state
    }
    hide() {
      s.bar = null
      s.barWindows.length = 0
    }
  }
}))

vi.mock('./screen', () => ({ captureMain: async () => s.capture }))

vi.mock('./driver', async (original) => ({
  ...(await original<typeof import('./driver')>()),
  createWindowsDriver: () => ({
    cursor: () => ({ x: 0, y: 0 }),
    move: (p: { x: number; y: number }) => void s.calls.push(`move ${p.x},${p.y}`),
    button: (b: string, down: boolean) => {
      if (s.driverFails && !down) throw new Error('stuck')
      s.calls.push(`${b} ${down ? 'down' : 'up'}`)
    },
    wheel: (dx: number, dy: number) => void s.calls.push(`wheel ${dx},${dy}`),
    text: async (t: string) => void s.calls.push(`text ${t}`),
    keys: async (mods: string[], key: string) => void s.calls.push(`keys ${[...mods, key].join('+')}`)
  })
}))

import { DesktopService } from './service'

const fakeWindow = (bounds: Rect, focused = false) => ({
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  getBounds: () => bounds,
  isFocused: () => focused,
  setContentProtection(on: boolean) {
    this.protectedNow = on
  },
  protectedNow: false
})

// Celeste's window covers the left of the screen; its Allow button is at (500, 400). The bar is at the top.
const CELESTE: Rect = { x: 0, y: 0, width: 900, height: 700 }
const BAR: Rect = { x: 700, y: 12, width: 520, height: 132 }
const state: DesktopBarState = { sessionId: 's1', until: Date.now() + 900_000, lines: [] }

let stops: string[]
let extended: number
let service: DesktopService
const call = (method: string, arg?: unknown) => service.handle(method, arg)
// The picture is 1500 wide for a 1920 screen: a point in it is 1.28 screen pixels per picture pixel.
const click = (x: number, y: number) => call('act', { type: 'click', at: { x, y }, button: 'left', count: 1 })

beforeEach(() => {
  s.windows = [fakeWindow(CELESTE)]
  s.barWindows = []
  s.shortcuts.clear()
  s.registerOk = true
  s.barFails = false
  s.bar = null
  s.calls = []
  s.driverFails = false
  stops = []
  extended = 0
  service = new DesktopService({ stop: (why) => stops.push(why), extend: () => void extended++ })
})

describe('starting', () => {
  it('registers the stop key, hides Celeste’s windows from the screen, and shows the bar', async () => {
    await call('bar', state)
    expect(s.shortcuts.has('Control+Alt+Esc')).toBe(true)
    expect((s.windows[0] as { protectedNow: boolean }).protectedNow).toBe(true)
    expect(s.bar).toEqual(state)
  })

  it('stops control when the key is pressed, and when the bar’s Stop is', async () => {
    await call('bar', state)
    s.shortcuts.get('Control+Alt+Esc')?.()
    s.barHandlers?.onStop()
    s.barHandlers?.onExtend()
    expect(stops).toEqual(['You pressed the stop key.', 'You pressed Stop.'])
    expect(extended).toBe(1)
  })

  it('does not start at all when the stop key is taken by another program', async () => {
    s.registerOk = false
    await expect(call('bar', state)).rejects.toThrow(/stop key/)
    expect(s.bar).toBeNull()
    expect((s.windows[0] as { protectedNow: boolean }).protectedNow).toBe(false)
    expect(await call('act', { type: 'type', text: 'x' })).toMatchObject({ ok: false, reason: 'Control is not on.' })
  })

  it('takes everything down if the bar cannot be shown', async () => {
    s.barFails = true
    await expect(call('bar', state)).rejects.toThrow('no bar')
    expect(s.shortcuts.size).toBe(0)
    expect((s.windows[0] as { protectedNow: boolean }).protectedNow).toBe(false)
  })

  it('takes everything down at the end, and shows Celeste’s windows to the screen again', async () => {
    await call('bar', state)
    await call('bar', null)
    expect(s.shortcuts.size).toBe(0)
    expect(s.bar).toBeNull()
    expect((s.windows[0] as { protectedNow: boolean }).protectedNow).toBe(false)
  })

  it('refuses a bar state that is not a bar state', async () => {
    await expect(call('bar', { sessionId: 1 })).rejects.toThrow(/not valid/)
    await expect(call('nonsense')).rejects.toThrow(/Unknown/)
  })

  it('says why it cannot work on another system', () => {
    const was = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      expect(service.unsupported()).toMatch(/Windows/)
    } finally {
      Object.defineProperty(process, 'platform', { value: was })
    }
  })
})

describe('acting', () => {
  beforeEach(async () => {
    await call('bar', state)
    await call('screenshot')
  })

  it('refuses everything while control is not on', async () => {
    await call('bar', null)
    expect(await click(1400, 700)).toMatchObject({ ok: false, reason: 'Control is not on.' })
    await expect(call('screenshot')).rejects.toThrow(/not on/)
    expect(s.calls).toEqual([])
  })

  it('refuses a point before there has been a screenshot to aim in', async () => {
    await call('bar', null)
    await call('bar', state)
    expect(await click(1400, 700)).toMatchObject({ ok: false, reason: expect.stringContaining('Take a screenshot first') })
    expect(s.calls).toEqual([])
  })

  it('converts a point in the picture into a point on the screen, and clicks there', async () => {
    expect(await click(1000, 500)).toEqual({ ok: true })
    expect(s.calls).toEqual(['move 1280,640', 'left down', 'left up'])
  })

  it('double-clicks, right-clicks, scrolls and drags', async () => {
    await call('act', { type: 'click', at: { x: 1000, y: 500 }, button: 'right', count: 2 })
    expect(s.calls).toEqual(['move 1280,640', 'right down', 'right up', 'right down', 'right up'])
    s.calls = []
    await call('act', { type: 'scroll', at: { x: 1000, y: 500 }, dx: 0, dy: 3 })
    expect(s.calls).toEqual(['move 1280,640', 'wheel 0,3'])
    s.calls = []
    await call('act', { type: 'drag', from: { x: 1000, y: 500 }, to: { x: 1100, y: 500 } })
    expect(s.calls[0]).toBe('move 1280,640')
    expect(s.calls[1]).toBe('left down')
    expect(s.calls.at(-1)).toBe('left up')
    expect(s.calls.at(-2)).toBe('move 1408,640')
  })

  it('types and presses keys', async () => {
    expect(await call('act', { type: 'type', text: 'hello' })).toEqual({ ok: true })
    expect(await call('act', { type: 'key', keys: 'ctrl+shift+t' })).toEqual({ ok: true })
    expect(s.calls).toEqual(['text hello', 'keys ctrl+shift+t'])
  })

  it('refuses a point outside the picture', async () => {
    expect(await click(1500, 100)).toMatchObject({ ok: false, reason: expect.stringContaining('outside the screenshot') })
    expect(await click(-5, 100)).toMatchObject({ ok: false })
    expect(s.calls).toEqual([])
  })

  it('refuses an action that is not valid', async () => {
    for (const bad of [{ type: 'click', at: { x: 'a', y: 1 }, button: 'left', count: 1 }, { type: 'type', text: '' }, { type: 'format' }, { type: 'scroll', at: { x: 1, y: 1 }, dx: 0, dy: 999 }, null]) {
      expect(await call('act', bad)).toMatchObject({ ok: false, reason: 'The action was not valid.' })
    }
    expect(s.calls).toEqual([])
  })

  it('never sends the keys that lock the computer or the stop key, even if Core were to ask', async () => {
    for (const keys of ['win+l', 'ctrl+alt+delete', 'ctrl+alt+esc', 'nonsense+key']) {
      expect(await call('act', { type: 'key', keys })).toMatchObject({ ok: false })
    }
    expect(s.calls).toEqual([])
  })

  it('reports a failure of the input, and lets go of the mouse button it held', async () => {
    s.driverFails = true
    const r = await call('act', { type: 'drag', from: { x: 1000, y: 500 }, to: { x: 1100, y: 500 } })
    expect(r).toMatchObject({ ok: false, reason: 'stuck' })
    expect(s.calls).toContain('left down')
  })
})

describe('Celeste’s own windows cannot be used, so the assistant cannot approve for itself or stop itself', () => {
  beforeEach(async () => {
    s.barWindows.push(fakeWindow(BAR))
    await call('bar', state)
    await call('screenshot')
  })

  // The Allow button is at (500, 400) on the screen, which is (390, 312) in the picture.
  it('refuses a click on Celeste’s Allow button', async () => {
    expect(await click(390, 312)).toMatchObject({ ok: false, reason: expect.stringContaining('inside a Celeste window') })
    expect(s.calls).toEqual([])
  })

  it('refuses a click on the bar’s Stop button, a drag into Celeste, a scroll over it and a move onto it', async () => {
    // The bar's Stop button: (1150, 60) on the screen.
    expect(await click(898, 47)).toMatchObject({ ok: false })
    expect(await call('act', { type: 'drag', from: { x: 1200, y: 700 }, to: { x: 390, y: 312 } })).toMatchObject({ ok: false })
    expect(await call('act', { type: 'scroll', at: { x: 390, y: 312 }, dx: 0, dy: 3 })).toMatchObject({ ok: false })
    expect(await call('act', { type: 'move', at: { x: 390, y: 312 } })).toMatchObject({ ok: false })
    expect(s.calls).toEqual([])
  })

  it('refuses typing and keys while a Celeste window has the keyboard', async () => {
    s.windows = [fakeWindow(CELESTE, true)]
    expect(await call('act', { type: 'type', text: 'yes' })).toMatchObject({ ok: false, reason: expect.stringContaining('in front') })
    expect(await call('act', { type: 'key', keys: 'enter' })).toMatchObject({ ok: false, reason: expect.stringContaining('in front') })
    expect(s.calls).toEqual([])
  })

  it('does not count a window that is hidden or minimised, and does not block anything outside', async () => {
    s.windows = [{ ...fakeWindow(CELESTE), isMinimized: () => true }]
    expect(await click(390, 312)).toEqual({ ok: true })
    s.windows = [fakeWindow(CELESTE)]
    expect(await click(1000, 500)).toEqual({ ok: true })
  })

  it('takes a window that opens during control into account at once', async () => {
    s.windows.push(fakeWindow({ x: 1200, y: 400, width: 400, height: 300 }))
    expect(await click(1000, 400)).toMatchObject({ ok: false })
  })
})

describe('closing', () => {
  it('tells Core to end control, once, and only if it is on', async () => {
    service.stopAll('You closed Celeste.')
    expect(stops).toEqual([])
    await call('bar', state)
    service.stopAll('You closed Celeste.')
    service.stopAll('again')
    expect(stops).toEqual(['You closed Celeste.'])
    expect(s.bar).toBeNull()
    expect(s.shortcuts.size).toBe(0)
  })

  it('takes the bar down when Core goes away', async () => {
    await call('bar', state)
    service.reset()
    expect(s.bar).toBeNull()
    expect(s.shortcuts.size).toBe(0)
    expect(stops).toEqual([])
  })

  it('knows which windows are its own, so closing the last of Celeste’s is noticed', async () => {
    const bar = fakeWindow(BAR)
    s.barWindows.push(bar)
    await call('bar', state)
    expect(service.owns(bar as never)).toBe(true)
    expect(service.owns(s.windows[0] as never)).toBe(false)
  })
})
