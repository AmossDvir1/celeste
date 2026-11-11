import { describe, expect, it } from 'vitest'
import { blockedKeys, describeAction, insideRect, parseKeys, pointsOf, refuseForCeleste, type DesktopAction, type GuardContext } from './desktop'

const keys = (s: string) => {
  const r = parseKeys(s)
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('parseKeys', () => {
  it('reads a combination into modifiers and the key', () => {
    expect(keys('Ctrl+Shift+T')).toEqual({ ok: true, mods: ['ctrl', 'shift'], key: 't' })
    expect(keys('alt+tab')).toEqual({ ok: true, mods: ['alt'], key: 'tab' })
    expect(keys('Enter')).toEqual({ ok: true, mods: [], key: 'enter' })
  })

  it('accepts the usual other names', () => {
    expect(keys('control+c').mods).toEqual(['ctrl'])
    expect(keys('cmd+c').mods).toEqual(['win'])
    expect(keys('esc').key).toBe('escape')
    expect(keys('Return').key).toBe('enter')
    expect(keys('PgDn').key).toBe('pagedown')
    expect(keys('ArrowLeft').key).toBe('left')
    expect(keys('f12').key).toBe('f12')
    expect(keys('ctrl++')).toEqual({ ok: true, mods: ['ctrl'], key: '+' })
  })

  it('refuses what it does not know, and says what to use', () => {
    expect(parseKeys('')).toMatchObject({ ok: false })
    expect(parseKeys('hyper+a')).toMatchObject({ ok: false, reason: expect.stringContaining('not a modifier') })
    expect(parseKeys('banana')).toMatchObject({ ok: false, reason: expect.stringContaining('not a key I know') })
    expect(parseKeys('f25')).toMatchObject({ ok: false })
    expect(parseKeys('ctrl')).toMatchObject({ ok: false, reason: expect.stringContaining('on its own') })
  })
})

describe('blockedKeys', () => {
  it('blocks locking the computer, Ctrl+Alt+Delete, and the stop key', () => {
    expect(blockedKeys(keys('win+l'))).toMatch(/locks/)
    expect(blockedKeys(keys('cmd+L'))).toMatch(/locks/)
    expect(blockedKeys(keys('ctrl+alt+delete'))).toMatch(/Windows/)
    expect(blockedKeys(keys('Ctrl+Alt+Esc'))).toMatch(/stops desktop control/)
    expect(blockedKeys(keys('alt+ctrl+escape'))).toMatch(/stops desktop control/)
  })

  it('lets everyday keys through', () => {
    for (const k of ['ctrl+c', 'alt+tab', 'enter', 'ctrl+alt+t', 'win+r', 'ctrl+escape', 'alt+escape']) expect(blockedKeys(keys(k))).toBeNull()
  })
})

describe('describeAction', () => {
  it('says each action in a line', () => {
    expect(describeAction({ type: 'click', at: { x: 10.4, y: 20.6 }, button: 'left', count: 1 })).toBe('Click at (10, 21)')
    expect(describeAction({ type: 'click', at: { x: 1, y: 2 }, button: 'left', count: 2 })).toBe('Double-click at (1, 2)')
    expect(describeAction({ type: 'click', at: { x: 1, y: 2 }, button: 'right', count: 1 })).toBe('Right-click at (1, 2)')
    expect(describeAction({ type: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).toBe('Drag from (1, 2) to (3, 4)')
    expect(describeAction({ type: 'scroll', at: { x: 1, y: 2 }, dx: 0, dy: -3 })).toBe('Scroll up at (1, 2)')
    expect(describeAction({ type: 'key', keys: 'ctrl+c' })).toBe('Press ctrl+c')
  })

  it('cuts long text short and shows a new line as a symbol', () => {
    expect(describeAction({ type: 'type', text: 'a'.repeat(60) })).toBe(`Type “${'a'.repeat(40)}…”`)
    expect(describeAction({ type: 'type', text: 'one\ntwo' })).toBe('Type “one↵two”')
  })
})

describe('Celeste’s own windows', () => {
  const allowButton = { x: 500, y: 400 }
  const ctx: GuardContext = { celesteRects: [{ x: 100, y: 100, width: 1200, height: 800 }], celesteHasFocus: false }
  const click = (at: { x: number; y: number }): DesktopAction => ({ type: 'click', at, button: 'left', count: 1 })

  it('knows what is inside a rectangle, the first pixel in and the first pixel out', () => {
    const r = { x: 10, y: 10, width: 5, height: 5 }
    expect(insideRect({ x: 10, y: 10 }, r)).toBe(true)
    expect(insideRect({ x: 14, y: 14 }, r)).toBe(true)
    expect(insideRect({ x: 15, y: 14 }, r)).toBe(false)
    expect(insideRect({ x: 9, y: 10 }, r)).toBe(false)
  })

  it('refuses a click on Celeste’s approval card', () => {
    expect(refuseForCeleste(click(allowButton), pointsOf(click(allowButton)), ctx)).toMatch(/inside a Celeste window/)
  })

  it('refuses a click on the stop button of the bar, and a drag that ends in a Celeste window', () => {
    const withBar: GuardContext = { ...ctx, celesteRects: [...ctx.celesteRects, { x: 900, y: 12, width: 520, height: 132 }] }
    const stop = { x: 1300, y: 60 }
    expect(refuseForCeleste(click(stop), [stop], withBar)).toMatch(/inside a Celeste window/)
    const drag: DesktopAction = { type: 'drag', from: { x: 1800, y: 900 }, to: allowButton }
    expect(refuseForCeleste(drag, pointsOf(drag), ctx)).toMatch(/inside a Celeste window/)
    const dragFrom: DesktopAction = { type: 'drag', from: allowButton, to: { x: 1800, y: 900 } }
    expect(refuseForCeleste(dragFrom, pointsOf(dragFrom), ctx)).toMatch(/inside a Celeste window/)
  })

  it('refuses scrolling and moving over it too', () => {
    for (const a of [{ type: 'move', at: allowButton } as const, { type: 'scroll', at: allowButton, dx: 0, dy: 3 } as const]) {
      expect(refuseForCeleste(a, pointsOf(a), ctx)).toMatch(/inside a Celeste window/)
    }
  })

  it('refuses typing and keys while a Celeste window has the keyboard, and only then', () => {
    const focused: GuardContext = { ...ctx, celesteHasFocus: true }
    expect(refuseForCeleste({ type: 'type', text: 'yes' }, [], focused)).toMatch(/in front/)
    expect(refuseForCeleste({ type: 'key', keys: 'enter' }, [], focused)).toMatch(/in front/)
    expect(refuseForCeleste({ type: 'type', text: 'yes' }, [], ctx)).toBeNull()
    expect(refuseForCeleste(click({ x: 1800, y: 900 }), [{ x: 1800, y: 900 }], focused)).toBeNull()
  })

  it('lets a point outside every window through', () => {
    expect(refuseForCeleste(click({ x: 1800, y: 900 }), [{ x: 1800, y: 900 }], ctx)).toBeNull()
  })

  it('lets a point inside Celeste’s bounds through only where another program’s window covers it', () => {
    const covered: GuardContext = { ...ctx, coveredByOther: (p) => p.x < 300 }
    expect(refuseForCeleste(click({ x: 200, y: 400 }), [{ x: 200, y: 400 }], covered)).toBeNull()
    expect(refuseForCeleste(click(allowButton), [allowButton], covered)).toMatch(/inside a Celeste window/)
  })
})
