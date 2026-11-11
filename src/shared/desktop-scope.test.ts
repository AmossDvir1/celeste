import { describe, expect, it } from 'vitest'
import { appName, chooseScope, DESKTOP_LIMITS, DESKTOP_SLIDER, describeDuration, describeScope, inScope, isConsequential, neverMatches, pressesFocused, type WindowInfo } from './desktop'

const windows: WindowInfo[] = [
  { id: 10, title: 'notes.txt - Notepad', app: 'notepad', focused: true },
  { id: 20, title: 'Inbox - Mail', app: 'chrome', focused: false },
  { id: 21, title: 'Celeste docs', app: 'chrome', focused: false }
]

describe('appName', () => {
  it('is the program’s file name, lower case, without .exe', () => {
    expect(appName('C:\\Program Files\\KeePass\\KeePass.exe')).toBe('keepass')
    expect(appName('/usr/bin/Firefox')).toBe('firefox')
    expect(appName('')).toBe('')
  })
})

describe('neverMatches', () => {
  const vault = { app: 'keepass', title: 'Passwords - KeePass' }
  it('matches the program by name, with or without .exe, in any case', () => {
    expect(neverMatches(['KeePass'], vault)).toBe(true)
    expect(neverMatches(['keepass.exe'], vault)).toBe(true)
  })
  it('matches a word in the title', () => {
    expect(neverMatches(['my bank'], { app: 'chrome', title: 'Welcome - My Bank Online' })).toBe(true)
  })
  it('matches nothing for an empty list or a blank entry', () => {
    expect(neverMatches([], vault)).toBe(false)
    expect(neverMatches(['', '  '], vault)).toBe(false)
  })
  it('does not match a different program with a similar name', () => {
    expect(neverMatches(['keepass'], { app: 'notepad', title: 'notes.txt' })).toBe(false)
  })
})

describe('chooseScope', () => {
  it('gives the whole screen when nothing is asked for', () => {
    expect(chooseScope({}, windows)).toEqual({ ok: true, scope: { kind: 'screen' } })
    expect(chooseScope({ app: ' ', window: '' }, windows)).toEqual({ ok: true, scope: { kind: 'screen' } })
  })
  it('finds a window by part of its title, in any case, the topmost first', () => {
    expect(chooseScope({ window: 'NOTEPAD' }, windows)).toEqual({ ok: true, scope: { kind: 'window', id: 10, title: 'notes.txt - Notepad', app: 'notepad' } })
    expect(chooseScope({ window: 'o' }, windows)).toMatchObject({ ok: true, scope: { id: 10 } })
  })
  it('finds a program by name, exactly first and then by the start of it', () => {
    expect(chooseScope({ app: 'Chrome.exe' }, windows)).toEqual({ ok: true, scope: { kind: 'app', app: 'chrome' } })
    expect(chooseScope({ app: 'note' }, windows)).toEqual({ ok: true, scope: { kind: 'app', app: 'notepad' } })
  })
  it('fails without saying which windows are open', () => {
    const r = chooseScope({ window: 'bank' }, windows)
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).not.toContain('Inbox')
    expect(chooseScope({ app: 'photoshop' }, windows)).toMatchObject({ ok: false })
  })
  it('refuses both at once', () => {
    expect(chooseScope({ app: 'chrome', window: 'Inbox' }, windows)).toMatchObject({ ok: false })
  })
})

describe('inScope', () => {
  const dialog = { id: 11, app: 'notepad', ownerId: 10 }
  const main = { id: 10, app: 'notepad', ownerId: 10 }
  const other = { id: 20, app: 'chrome', ownerId: 20 }
  it('lets the whole screen through', () => {
    expect(inScope({ kind: 'screen' }, other)).toBe(true)
  })
  it('lets a window and what it owns through, and nothing else', () => {
    const scope = { kind: 'window', id: 10, title: 't', app: 'notepad' } as const
    expect(inScope(scope, main)).toBe(true)
    expect(inScope(scope, dialog)).toBe(true)
    expect(inScope(scope, other)).toBe(false)
  })
  it('lets a program through by name', () => {
    expect(inScope({ kind: 'app', app: 'notepad' }, dialog)).toBe(true)
    expect(inScope({ kind: 'app', app: 'notepad' }, other)).toBe(false)
  })
})

describe('describeScope', () => {
  it('says it in words, and cuts a long title', () => {
    expect(describeScope({ kind: 'screen' })).toBe('the whole main screen')
    expect(describeScope({ kind: 'app', app: 'chrome' })).toBe('only the windows of chrome')
    expect(describeScope({ kind: 'window', id: 1, title: 'a'.repeat(80), app: 'x' })).toBe(`only the window “${'a'.repeat(60)}…” (x)`)
  })
})

describe('isConsequential', () => {
  it.each(['Send', 'Delete all my files', 'Buy now', 'Place order', 'Confirm payment', 'Sign in', 'Allow access', 'Accept and continue', 'Transfer funds', 'Uninstall', 'Submit'])('flags “%s”', (label) => {
    expect(isConsequential(label)).toBe(true)
  })
  it.each(['Open', 'Cancel', 'Next', 'Search', 'File', 'Message', 'Settings', 'Resend'])('does not flag “%s”', (label) => {
    expect(isConsequential(label)).toBe(false)
  })
  it('does not flag nothing, or a whole paragraph', () => {
    expect(isConsequential(undefined)).toBe(false)
    expect(isConsequential('')).toBe(false)
    expect(isConsequential(`Delete ${'x'.repeat(300)}`)).toBe(false)
  })
})

describe('pressesFocused', () => {
  it('is true for Enter and Space, with or without Ctrl or Shift', () => {
    for (const k of ['enter', 'Return', 'space', 'ctrl+enter', 'shift+space']) expect(pressesFocused(k)).toBe(true)
  })
  it('is false for other keys, Alt+Enter, and what is not a key', () => {
    for (const k of ['tab', 'escape', 'ctrl+c', 'alt+enter', 'win+space', 'nonsense']) expect(pressesFocused(k)).toBe(false)
  })
})

describe('describeDuration', () => {
  it('says how long, in words', () => {
    expect(describeDuration(15 * 60_000)).toBe('15 minutes')
    expect(describeDuration(60 * 60_000)).toBe('1 hour')
    expect(describeDuration(2 * 60 * 60_000)).toBe('2 hours')
    expect(describeDuration(DESKTOP_LIMITS.longGrantMs)).toBe('until you stop it')
  })
  it('starts the card’s slider at 20 minutes and lets it go to two hours', () => {
    expect(DESKTOP_SLIDER).toEqual({ min: 5, max: 120, step: 5, value: 20, until: 720 })
    expect(DESKTOP_SLIDER.until * 60_000).toBe(DESKTOP_LIMITS.longGrantMs)
    expect(DESKTOP_SLIDER.value * 60_000).toBe(DESKTOP_LIMITS.grantMs)
    expect(DESKTOP_SLIDER.max * 60_000).toBe(DESKTOP_LIMITS.maxGrantMs)
  })
})
