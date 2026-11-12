import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBarState, Rect } from '@shared/desktop'

interface Rec {
  id: number
  ownerId: number
  pid: number
  title: string
  app: string
  bounds: Rect
  minimized: boolean
}

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
    barHandlers: undefined as undefined | { onStop(): void; onExtend(): void; onResume(): void },
    capture: { shot: { mime: 'image/jpeg' as const, data: 'AAAA', width: 1500, height: 844 }, geometry: { origin: { x: 0, y: 0 }, scaleX: 1.28, scaleY: 1.28, width: 1500, height: 844 } },
    captures: [] as unknown[][],
    calls: [] as string[],
    driverFails: false,
    cursor: { x: 0, y: 0 },
    // What Windows says: the windows topmost first, who has the keyboard, and what is under a click or in the field with the keyboard.
    win: { list: [] as Rec[], fg: null as Rec | null, fields: [{}] as { label?: string; password?: boolean }[], fieldCalls: 0, element: {} as { label?: string; password?: boolean }, elements: [] as { role: string; name: string; bounds: Rect; password?: boolean }[], focusOk: true, focused: 0 }
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
  screen: { dipToScreenRect: (_w: unknown, r: Rect) => r, getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) }
}))

vi.mock('./bar', () => ({
  ControlBar: class {
    constructor(handlers: { onStop(): void; onExtend(): void; onResume(): void }) {
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

vi.mock('./screen', () => ({
  capture: async (...args: unknown[]) => {
    s.captures.push(args)
    return s.capture
  },
  displayOf: () => ({ id: 1 })
}))

vi.mock('./windows', () => ({
  createWindowsApi: () => ({
    list: () => s.win.list,
    foreground: () => s.win.fg,
    at: (p: { x: number; y: number }) => s.win.list.find((w) => p.x >= w.bounds.x && p.y >= w.bounds.y && p.x < w.bounds.x + w.bounds.width && p.y < w.bounds.y + w.bounds.height) ?? null,
    byId: (id: number) => s.win.list.find((w) => w.id === id) ?? null,
    focus: (id: number) => {
      s.win.focused = id
      return s.win.focusOk
    },
    focusedField: () => s.win.fields[Math.min(s.win.fieldCalls++, s.win.fields.length - 1)] ?? {},
    elementAt: () => s.win.element,
    elementsOf: () => s.win.elements
  })
}))

vi.mock('./driver', async (original) => ({
  ...(await original<typeof import('./driver')>()),
  createWindowsDriver: () => ({
    cursor: () => s.cursor,
    move: (p: { x: number; y: number }) => {
      s.cursor = p
      s.calls.push(`move ${p.x},${p.y}`)
    },
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
const state: DesktopBarState = { sessionId: 's1', until: Date.now() + 900_000, lines: [], scope: { kind: 'screen' }, never: [], paused: null }
const rec = (id: number, title: string, app: string, bounds: Rect, over: Partial<Rec> = {}): Rec => ({ id, ownerId: id, pid: 5000 + id, title, app, bounds, minimized: false, ...over })
// Programs, topmost first. Their screen positions are chosen so that a point in the picture (1.28 screen pixels each) lands in only one.
const NOTEPAD = rec(10, 'notes.txt - Notepad', 'notepad', { x: 1000, y: 200, width: 640, height: 480 })
const SAVE_AS = rec(11, 'Save As', 'notepad', { x: 1100, y: 300, width: 300, height: 200 }, { ownerId: 10 })
const BROWSER = rec(20, 'Inbox - Mail', 'chrome', { x: 1000, y: 800, width: 500, height: 200 })
const VAULT = rec(30, 'KeePass', 'keepass', { x: 1700, y: 100, width: 200, height: 300 })
// Where those are in the picture.
const IN_NOTEPAD = { x: 900, y: 300 }
const IN_BROWSER = { x: 900, y: 700 }
const IN_VAULT = { x: 1360, y: 150 }
const scoped = (scope: DesktopBarState['scope'], never: string[] = []): DesktopBarState => ({ ...state, scope, never })

let stops: string[]
let extended: number
let resumed: number
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
  s.captures = []
  s.cursor = { x: 0, y: 0 }
  s.win = { list: [], fg: null, fields: [{}], fieldCalls: 0, element: {}, elements: [], focusOk: true, focused: 0 }
  resumed = 0
  service = new DesktopService({ stop: (why) => stops.push(why), extend: () => void extended++, resume: () => void resumed++ })
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

  it('allows a click where another program’s window is in front of Celeste, and refuses it where Celeste is on top', async () => {
    const dialog = rec(40, 'New Document', 'photoshop', { x: 300, y: 200, width: 400, height: 400 })
    const celesteOnTop = rec(41, 'Celeste', 'electron', CELESTE, { pid: process.pid })
    s.win.list = [dialog, celesteOnTop]
    expect(await click(390, 312)).toEqual({ ok: true }) // (500, 400): inside both, the dialog is in front
    expect(s.calls).toContain('left down')
    s.calls = []
    s.win.list = [celesteOnTop, dialog]
    expect(await click(390, 312)).toMatchObject({ ok: false, reason: expect.stringContaining('inside a Celeste window') })
    expect(s.calls).toEqual([])
  })

  it('refuses a drag that ends on Celeste even when it starts on a window in front of it', async () => {
    const dialog = rec(40, 'New Document', 'photoshop', { x: 100, y: 100, width: 300, height: 300 })
    s.win.list = [dialog, rec(41, 'Celeste', 'electron', CELESTE, { pid: process.pid })]
    expect(await call('act', { type: 'drag', from: { x: 150, y: 150 }, to: { x: 390, y: 312 } })).toMatchObject({ ok: false })
    expect(s.calls).toEqual([])
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

describe('scope: one window, one program, or the whole screen', () => {
  const act = (kind: 'click' | 'type' | 'key', at = IN_NOTEPAD) =>
    kind === 'click' ? call('act', { type: 'click', at, button: 'left', count: 1 }) : kind === 'type' ? call('act', { type: 'type', text: 'hello' }) : call('act', { type: 'key', keys: 'enter' })

  beforeEach(() => {
    s.win.list = [SAVE_AS, NOTEPAD, BROWSER, VAULT]
    s.win.fg = NOTEPAD
  })

  describe('a window', () => {
    beforeEach(async () => {
      await call('bar', scoped({ kind: 'window', id: 10, title: NOTEPAD.title, app: 'notepad' }))
      await call('screenshot')
    })

    it('clicks inside it, and types while it has the keyboard', async () => {
      expect(await act('click')).toEqual({ ok: true })
      expect(await act('type')).toEqual({ ok: true })
      expect(await act('key')).toEqual({ ok: true })
    })

    it('refuses a click on another window, and says which and why', async () => {
      const r = await act('click', IN_BROWSER)
      expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('Inbox - Mail') })
      expect(r).toMatchObject({ reason: expect.stringContaining('outside what you were given') })
      expect(s.calls).toEqual([])
    })

    it('refuses a click where there is no window at all', async () => {
      expect(await act('click', { x: 100, y: 800 })).toMatchObject({ ok: false, reason: expect.stringContaining('not in any window') })
    })

    it('refuses a drag that ends outside, and a scroll over another window', async () => {
      expect(await call('act', { type: 'drag', from: IN_NOTEPAD, to: IN_BROWSER })).toMatchObject({ ok: false })
      expect(await call('act', { type: 'scroll', at: IN_BROWSER, dx: 0, dy: 3 })).toMatchObject({ ok: false })
      expect(s.calls).toEqual([])
    })

    it('allows a dialog the window opened, which is owned by it', async () => {
      expect(await act('click', { x: 1000, y: 300 })).toEqual({ ok: true }) // (1280, 384): inside Save As
      s.win.fg = SAVE_AS
      expect(await act('type')).toEqual({ ok: true })
    })

    it('refuses typing and keys while another window has the keyboard', async () => {
      s.win.fg = BROWSER
      expect(await act('type')).toMatchObject({ ok: false, reason: expect.stringContaining('The keyboard') })
      expect(await act('key')).toMatchObject({ ok: false })
      expect(s.calls).toEqual([])
    })

    it('refuses everything when the window has been closed', async () => {
      s.win.list = [BROWSER]
      expect(await act('click')).toMatchObject({ ok: false, reason: expect.stringContaining('has been closed') })
      await expect(call('screenshot')).rejects.toThrow(/is closed/)
    })

    it('takes a picture of the window only, with everything else painted over', async () => {
      s.captures = []
      await call('screenshot')
      const [, crop, redaction] = s.captures[0] as [unknown, Rect, { base: string; layers: { rect: Rect; show: boolean }[] }]
      // The window and the dialog it owns, as one box.
      expect(crop).toEqual({ x: 1000, y: 200, width: 640, height: 480 })
      expect(redaction.base).toBe('hide')
      // Bottom to top, so what is in front paints over what is behind. Only the window and its dialog are shown.
      expect(redaction.layers.map((l) => l.show)).toEqual([false, false, true, true])
      expect(redaction.layers[0]).toMatchObject({ rect: VAULT.bounds })
    })

    it('says so when the window is minimized instead of giving a picture of nothing', async () => {
      s.win.list = [{ ...NOTEPAD, minimized: true }, BROWSER]
      await expect(call('screenshot')).rejects.toThrow(/minimized or not open/)
    })
  })

  describe('a program', () => {
    beforeEach(async () => {
      await call('bar', scoped({ kind: 'app', app: 'notepad' }))
      await call('screenshot')
    })

    it('allows all its windows and nothing else', async () => {
      expect(await act('click')).toEqual({ ok: true })
      expect(await act('click', IN_BROWSER)).toMatchObject({ ok: false })
    })

    it('takes a picture of the whole display with the other programs painted over', async () => {
      s.captures = []
      await call('screenshot')
      const [, crop, redaction] = s.captures[0] as [unknown, unknown, { base: string; layers: { show: boolean }[] }]
      expect(crop).toBeUndefined()
      expect(redaction.base).toBe('hide')
      expect(redaction.layers.filter((l) => l.show).length).toBe(2)
    })
  })

  describe('the never list', () => {
    it('refuses a program on it even when the whole screen was given', async () => {
      await call('bar', scoped({ kind: 'screen' }, ['keepass']))
      await call('screenshot')
      expect(await act('click', IN_VAULT)).toMatchObject({ ok: false, reason: expect.stringContaining('never controlled') })
      expect(await act('click')).toEqual({ ok: true })
      s.win.fg = VAULT
      expect(await act('type')).toMatchObject({ ok: false })
    })

    it('matches a word in a window title too, in any case', async () => {
      await call('bar', scoped({ kind: 'screen' }, ['INBOX']))
      await call('screenshot')
      expect(await act('click', IN_BROWSER)).toMatchObject({ ok: false })
    })

    it('paints it over in the picture of the whole screen, and leaves the rest', async () => {
      await call('bar', scoped({ kind: 'screen' }, ['keepass']))
      s.captures = []
      await call('screenshot')
      const [, , redaction] = s.captures[0] as [unknown, unknown, { base: string; layers: { rect: Rect; show: boolean }[] }]
      expect(redaction.base).toBe('show')
      expect(redaction.layers).toEqual([{ rect: VAULT.bounds, show: false }])
    })

    it('has no redaction at all when the screen is given and the list is empty', async () => {
      await call('bar', scoped({ kind: 'screen' }))
      s.captures = []
      await call('screenshot')
      expect((s.captures[0] as unknown[])[2]).toBeUndefined()
    })

    it('is checked when the person changes it in Settings, at the next update of the bar', async () => {
      await call('bar', scoped({ kind: 'screen' }))
      await call('screenshot')
      expect(await act('click', IN_VAULT)).toEqual({ ok: true })
      await call('bar', scoped({ kind: 'screen' }, ['keepass']))
      expect(await act('click', IN_VAULT)).toMatchObject({ ok: false })
    })
  })

  describe('the list of windows and bringing one to the front', () => {
    beforeEach(() => {
      s.win.list = [NOTEPAD, BROWSER, VAULT, rec(40, 'Celeste', 'electron', { x: 0, y: 0, width: 900, height: 700 }, { pid: process.pid })]
    })

    it('leaves out Celeste’s own windows and the never list, and says which is in front', async () => {
      const list = (await call('windows', { never: ['keepass'] })) as { id: number; focused: boolean }[]
      expect(list.map((w) => w.id)).toEqual([10, 20])
      expect(list.find((w) => w.id === 10)?.focused).toBe(true)
    })

    it('only lists what is inside the scope while control is on', async () => {
      await call('bar', scoped({ kind: 'app', app: 'chrome' }))
      expect(((await call('windows', { never: [] })) as { id: number }[]).map((w) => w.id)).toEqual([20])
    })

    it('brings a window of the scope to the front', async () => {
      await call('bar', scoped({ kind: 'screen' }))
      expect(await call('focus', { id: 20 })).toEqual({ ok: true, title: 'Inbox - Mail', app: 'chrome' })
      expect(s.win.focused).toBe(20)
    })

    it('refuses a window outside the scope, a never-list window, a Celeste window and one that is gone', async () => {
      await call('bar', scoped({ kind: 'window', id: 10, title: NOTEPAD.title, app: 'notepad' }, ['keepass']))
      expect(await call('focus', { id: 20 })).toMatchObject({ ok: false, reason: expect.stringContaining('outside what you were given') })
      await call('bar', scoped({ kind: 'screen' }, ['keepass']))
      expect(await call('focus', { id: 30 })).toMatchObject({ ok: false, reason: expect.stringContaining('never controlled') })
      expect(await call('focus', { id: 40 })).toMatchObject({ ok: false, reason: expect.stringContaining('Celeste') })
      expect(await call('focus', { id: 99 })).toMatchObject({ ok: false })
      expect(s.win.focused).toBe(0)
    })

    it('says so when Windows will not bring it forward', async () => {
      await call('bar', scoped({ kind: 'screen' }))
      s.win.focusOk = false
      expect(await call('focus', { id: 20 })).toMatchObject({ ok: false, reason: expect.stringContaining('did not bring') })
    })

    it('does nothing while control is not on', async () => {
      expect(await call('focus', { id: 20 })).toMatchObject({ ok: false, reason: 'Control is not on.' })
    })
  })
})

describe('elements: exact positions from Windows instead of aiming at a picture', () => {
  const SAVE = { role: 'button', name: 'Save', bounds: { x: 1100, y: 300, width: 100, height: 40 } }
  const OFFSCREEN = { role: 'button', name: 'Far', bounds: { x: 5000, y: 300, width: 100, height: 40 } }
  const PASSWORD = { role: 'password field', name: '', bounds: { x: 1100, y: 400, width: 100, height: 40 }, password: true }
  beforeEach(async () => {
    await call('bar', state)
    s.win.list = [NOTEPAD, BROWSER]
    s.win.fg = NOTEPAD
    s.win.elements = [SAVE, OFFSCREEN, PASSWORD]
  })

  it('needs a screenshot first, and control to be on', async () => {
    expect(await call('elements', {})).toMatchObject({ ok: false, reason: expect.stringContaining('screenshot first') })
    await call('bar', null)
    expect(await call('elements', {})).toMatchObject({ ok: false, reason: 'Control is not on.' })
  })

  it('numbers the elements of the window in front, in the picture’s pixels, leaving out what is off the picture', async () => {
    await call('screenshot')
    const r = (await call('elements', {})) as { ok: true; elements: unknown[]; window: string; width: number }
    expect(r.ok).toBe(true)
    expect(r.elements).toEqual([
      { id: 1, role: 'button', name: 'Save', x: 898, y: 250 },
      { id: 2, role: 'password field', name: '', x: 898, y: 328 }
    ])
    expect(r.window).toContain('notepad')
  })

  it('turns a number into the point it is at, and the click lands on it', async () => {
    await call('screenshot')
    await call('elements', {})
    const at = (await call('resolve', { id: 1 })) as { ok: true; at: { x: number; y: number } }
    expect(at.ok).toBe(true)
    expect(await call('act', { type: 'click', at: at.at, button: 'left', count: 1 })).toEqual({ ok: true })
    expect(s.calls[0]).toBe('move 1150,320')
  })

  it('does not know a number that was not listed, or a list from before the window moved', async () => {
    await call('screenshot')
    expect(await call('resolve', { id: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('desktop_elements again') })
    await call('elements', {})
    expect(await call('resolve', { id: 9 })).toMatchObject({ ok: false })
    s.win.list = [{ ...NOTEPAD, bounds: { ...NOTEPAD.bounds, x: 1010 } }, BROWSER]
    expect(await call('resolve', { id: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('moved') })
  })

  it('leaves out what another window covers', async () => {
    await call('screenshot')
    s.win.list = [SAVE_AS, NOTEPAD]
    const r = (await call('elements', {})) as { ok: true; elements: unknown[] }
    expect(r.elements).toEqual([])
  })

  it('will not read Celeste’s windows, the never list, or a window outside the scope', async () => {
    await call('screenshot')
    const own = rec(1, 'Celeste', 'celeste', { x: 0, y: 0, width: 500, height: 500 }, { pid: process.pid })
    s.win.list = [own, NOTEPAD, BROWSER, VAULT]
    expect(await call('elements', { window: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('off limits') })
    await call('bar', { ...state, never: ['keepass'] })
    expect(await call('elements', { window: 30 })).toMatchObject({ ok: false, reason: expect.stringContaining('never controlled') })
    await call('bar', scoped({ kind: 'app', app: 'notepad' }))
    expect(await call('elements', { window: 20 })).toMatchObject({ ok: false, reason: expect.stringContaining('outside what you were given') })
  })

  it('forgets the list when control ends', async () => {
    await call('screenshot')
    await call('elements', {})
    await call('bar', null)
    await call('bar', state)
    await call('screenshot')
    expect(await call('resolve', { id: 1 })).toMatchObject({ ok: false })
  })
})

describe('what is under an action', () => {
  beforeEach(async () => {
    s.win.list = [NOTEPAD]
    await call('bar', state)
    await call('screenshot')
    s.win.fieldCalls = 0 // the picture asked once already
  })

  it('tells what a click would press', async () => {
    s.win.element = { label: 'Delete', password: false }
    expect(await call('inspect', { type: 'click', at: IN_NOTEPAD, button: 'left', count: 1 })).toEqual({ label: 'Delete', password: false })
  })

  it('looks twice at the field that has the keyboard before typing, because a page only describes itself when asked', async () => {
    s.win.fields = [{}, { label: 'Password', password: true }]
    expect(await call('inspect', { type: 'type', text: 'x' })).toEqual({ password: true, label: 'Password' })
    expect(s.win.fieldCalls).toBe(2)
  })

  it('says it is not a password field when neither look says so', async () => {
    s.win.fields = [
      { label: 'Name', password: false },
      { label: 'Name', password: false }
    ]
    expect(await call('inspect', { type: 'type', text: 'x' })).toMatchObject({ password: false })
  })

  it('looks at the field for Enter and Space, and at nothing for other keys and moves', async () => {
    s.win.fields = [{ label: 'Send' }]
    expect(await call('inspect', { type: 'key', keys: 'enter' })).toEqual({ label: 'Send' })
    expect(await call('inspect', { type: 'key', keys: 'ctrl+c' })).toEqual({})
    expect(await call('inspect', { type: 'move', at: IN_NOTEPAD })).toEqual({})
    expect(await call('inspect', { nonsense: true })).toEqual({})
  })

  it('answers nothing while control is not on', async () => {
    await call('bar', null)
    expect(await call('inspect', { type: 'type', text: 'x' })).toEqual({})
  })
})

describe('when the person moves the mouse', () => {
  beforeEach(async () => {
    await call('bar', state)
    await call('screenshot')
    await click(1000, 500)
  })

  it('holds the next action back and says why, so Core can pause', async () => {
    s.cursor = { x: s.cursor.x + 200, y: s.cursor.y }
    s.calls = []
    expect(await click(1000, 500)).toMatchObject({ ok: false, moved: true })
    expect(s.calls).toEqual([])
  })

  it('holds back typing too: the person is using the computer', async () => {
    s.cursor = { x: 5, y: 700 }
    expect(await call('act', { type: 'type', text: 'x' })).toMatchObject({ ok: false, moved: true })
  })

  it('does not take a small shift of the pointer for the person', async () => {
    s.cursor = { x: s.cursor.x + 6, y: s.cursor.y }
    expect(await click(1000, 500)).toEqual({ ok: true })
  })

  it('carries on from where the mouse is when the person presses Continue', async () => {
    s.cursor = { x: 5, y: 700 }
    expect(await click(1000, 500)).toMatchObject({ moved: true })
    s.barHandlers?.onResume()
    expect(resumed).toBe(1)
    expect(await click(1000, 500)).toEqual({ ok: true })
  })

  it('forgets where the mouse was when control ends, so the next time starts clean', async () => {
    await call('bar', null)
    s.cursor = { x: 5, y: 700 }
    await call('bar', state)
    await call('screenshot')
    expect(await click(1000, 500)).toEqual({ ok: true })
  })
})
