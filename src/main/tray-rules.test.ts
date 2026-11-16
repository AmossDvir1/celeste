import { describe, expect, it } from 'vitest'
import { hidesOnClose, paintDot, pauseItem, quitQuestion, shouldNotify, startsHidden, tooltip } from './tray-rules'

const base = { platform: 'win32' as const, closeToTray: true, quitting: false, trayReady: true }

describe('hidesOnClose', () => {
  it('hides on Windows when the person wants it and the tray is there', () => {
    expect(hidesOnClose(base)).toBe(true)
  })
  it('really closes when quitting, when the setting is off, or when there is no tray icon', () => {
    expect(hidesOnClose({ ...base, quitting: true })).toBe(false)
    expect(hidesOnClose({ ...base, closeToTray: false })).toBe(false)
    expect(hidesOnClose({ ...base, trayReady: false })).toBe(false)
  })
  it('leaves the Mac and Linux as they were', () => {
    expect(hidesOnClose({ ...base, platform: 'darwin' })).toBe(false)
    expect(hidesOnClose({ ...base, platform: 'linux' })).toBe(false)
  })
})

describe('tooltip', () => {
  it('says only Celeste when nothing is going on', () => {
    expect(tooltip(0, 0)).toBe('Celeste')
  })
  it('counts what is working and what needs the person', () => {
    expect(tooltip(2, 0)).toBe('Celeste: 2 working')
    expect(tooltip(0, 1)).toBe('Celeste: 1 needs you')
    expect(tooltip(2, 3)).toBe('Celeste: 2 working, 3 need you')
  })
})

describe('the schedules in the tray', () => {
  it('says so in the tooltip while they are paused', () => {
    expect(tooltip(0, 0, true)).toBe('Celeste: schedules paused')
    expect(tooltip(1, 0, true)).toBe('Celeste: 1 working, schedules paused')
    expect(tooltip(0, 0, false)).toBe('Celeste')
  })
  it('offers to pause when there are schedules, to resume when they are paused, and nothing when there are none', () => {
    expect(pauseItem(0, false)).toBeNull()
    expect(pauseItem(2, false)).toBe('Pause all schedules')
    expect(pauseItem(2, true)).toBe('Resume all schedules')
    expect(pauseItem(0, true)).toBe('Resume all schedules')
  })
})

describe('startsHidden', () => {
  const start = { background: true, platform: 'win32' as const, trayReady: true }
  it('stays in the tray when started with the computer and there is a tray icon to open it from', () => {
    expect(startsHidden(start)).toBe(true)
  })
  it('shows the window for any other start, and when there would be no way back to it', () => {
    expect(startsHidden({ ...start, background: false })).toBe(false)
    expect(startsHidden({ ...start, trayReady: false })).toBe(false)
    expect(startsHidden({ ...start, platform: 'darwin' })).toBe(false)
  })
})

describe('quitQuestion', () => {
  it('does not ask when nothing is going on', () => {
    expect(quitQuestion(0, 0)).toBeNull()
  })
  it('asks, in the singular and the plural', () => {
    expect(quitQuestion(1, 0)).toContain('One chat, workflow or command is still going')
    expect(quitQuestion(1, 1)).toContain('2 chats, workflows and commands are still going')
  })
})

describe('shouldNotify', () => {
  it('notifies when there is no window, or it is hidden, minimised or in the background', () => {
    expect(shouldNotify(null)).toBe(true)
    expect(shouldNotify({ visible: false, minimized: false, focused: false })).toBe(true)
    expect(shouldNotify({ visible: true, minimized: true, focused: false })).toBe(true)
    expect(shouldNotify({ visible: true, minimized: false, focused: false })).toBe(true)
  })
  it('stays quiet when the person is looking at Celeste', () => {
    expect(shouldNotify({ visible: true, minimized: false, focused: true })).toBe(false)
  })
})

describe('paintDot', () => {
  it('paints the bottom right corner and leaves the top left alone', () => {
    const size = 32
    const picture = Buffer.alloc(size * size * 4, 10)
    const out = paintDot(picture, size)
    const at = (x: number, y: number) => (y * size + x) * 4
    expect([...out.subarray(at(0, 0), at(0, 0) + 4)]).toEqual([10, 10, 10, 10])
    expect([...out.subarray(at(size - 9, size - 9), at(size - 9, size - 9) + 4)]).toEqual([157, 95, 244, 255])
    expect(picture[at(size - 9, size - 9)]).toBe(10)
  })
})
