import { describe, expect, it } from 'vitest'
import { afterClosing, cleanUserAgent, displayUrl, isLocalHost, isLocalUrl, isOpenable, isWindowKey, originOf, resolveAddress, type KeyInput } from './browser'

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, control: false, shift: false, alt: false, meta: false, ...mods })

describe('resolveAddress', () => {
  it('leaves a full address as it is', () => {
    expect(resolveAddress('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(resolveAddress('  http://localhost:3000  ')).toBe('http://localhost:3000')
    expect(resolveAddress('about:blank')).toBe('about:blank')
  })

  it('makes a site of something that looks like one', () => {
    expect(resolveAddress('example.com')).toBe('https://example.com')
    expect(resolveAddress('docs.example.co.uk/guide')).toBe('https://docs.example.co.uk/guide')
    expect(resolveAddress('bücher.de')).toBe('https://bücher.de')
  })

  it('uses plain http for this computer', () => {
    expect(resolveAddress('localhost:3000')).toBe('http://localhost:3000')
    expect(resolveAddress('localhost')).toBe('http://localhost')
    expect(resolveAddress('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
    expect(resolveAddress('shop.localhost:5173')).toBe('http://shop.localhost:5173')
  })

  it('searches for anything else', () => {
    expect(resolveAddress('weather in paris')).toBe('https://www.google.com/search?q=weather%20in%20paris')
    expect(resolveAddress('cats', 'duckduckgo')).toBe('https://duckduckgo.com/?q=cats')
    expect(resolveAddress('what is 1.5 + 2', 'bing')).toBe('https://www.bing.com/search?q=what%20is%201.5%20%2B%202')
    expect(resolveAddress('react')).toBe('https://www.google.com/search?q=react')
  })

  it('refuses addresses the pane does not open, and nothing', () => {
    expect(resolveAddress('')).toBeNull()
    expect(resolveAddress('   ')).toBeNull()
    expect(resolveAddress('javascript:alert(1)')).toBeNull()
    expect(resolveAddress('data:text/html,<b>x</b>')).toBeNull()
    expect(resolveAddress('chrome://settings')).toBeNull()
    expect(resolveAddress('ms-settings:network')).toBeNull()
  })

  it('opens a file address', () => {
    expect(resolveAddress('file:///C:/notes/a.html')).toBe('file:///C:/notes/a.html')
  })
})

describe('what is local', () => {
  it('knows this computer', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLocalHost(host)).toBe(true)
    for (const host of ['example.com', 'localhost.example.com', '10.0.0.5', '128.0.0.1']) expect(isLocalHost(host)).toBe(false)
  })

  it('counts a file as local and a remote page as not', () => {
    expect(isLocalUrl('http://localhost:3000/x')).toBe(true)
    expect(isLocalUrl('file:///C:/a.html')).toBe(true)
    expect(isLocalUrl('https://example.com')).toBe(false)
    expect(isLocalUrl('nonsense')).toBe(false)
  })

  it('opens only web and file addresses', () => {
    expect(isOpenable('https://a.b')).toBe(true)
    expect(isOpenable('http://a.b')).toBe(true)
    expect(isOpenable('file:///a')).toBe(true)
    expect(isOpenable('about:blank')).toBe(true)
    expect(isOpenable('javascript:1')).toBe(false)
    expect(isOpenable('ftp://a.b')).toBe(false)
    expect(isOpenable('intent://x')).toBe(false)
  })
})

describe('names', () => {
  it('names a site by scheme, host and port', () => {
    expect(originOf('https://example.com/a/b?c')).toBe('https://example.com')
    expect(originOf('http://localhost:3000/')).toBe('http://localhost:3000')
    expect(originOf('not an address')).toBe('')
  })

  it('shows an address briefly', () => {
    expect(displayUrl('https://www.example.com/')).toBe('example.com')
    expect(displayUrl('https://example.com/a/b?x=1#top')).toBe('example.com/a/b?x=1#top')
    expect(displayUrl('http://localhost:3000/')).toBe('localhost:3000')
    expect(displayUrl('about:blank')).toBe('')
    expect(displayUrl('')).toBe('')
    expect(displayUrl('file:///C:/notes/a%20b.html')).toBe('C:/notes/a b.html')
  })

  it('takes Electron and the app name out of the user agent', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) celeste/1.1.0 Chrome/156.0.8078.80 Electron/45.2.3 Safari/537.36'
    expect(cleanUserAgent(ua)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Safari/537.36')
    expect(cleanUserAgent('Mozilla/5.0 Chrome/150 Safari/537.36')).toBe('Mozilla/5.0 Chrome/150 Safari/537.36')
  })
})

describe('keys the page hands back', () => {
  it('hands back the window keys and the browser keys', () => {
    for (const k of ['k', ',', 'n', 'b', '1', '2', '3', 'l', 't', 'w', 'r']) expect(isWindowKey(key(k, { control: true }))).toBe(true)
    expect(isWindowKey(key('K', { meta: true }))).toBe(true)
    expect(isWindowKey(key('B', { control: true, shift: true }))).toBe(true)
    expect(isWindowKey(key('ArrowLeft', { alt: true }))).toBe(true)
    expect(isWindowKey(key('ArrowRight', { alt: true }))).toBe(true)
    expect(isWindowKey(key('F5'))).toBe(true)
    expect(isWindowKey(key('F12'))).toBe(true)
  })

  it('leaves the page its own keys', () => {
    expect(isWindowKey(key('a', { control: true }))).toBe(false)
    expect(isWindowKey(key('c', { control: true }))).toBe(false)
    expect(isWindowKey(key('v', { control: true }))).toBe(false)
    expect(isWindowKey(key('Escape'))).toBe(false)
    expect(isWindowKey(key('Enter'))).toBe(false)
    expect(isWindowKey(key('k'))).toBe(false)
    expect(isWindowKey(key('ArrowLeft'))).toBe(false)
    expect(isWindowKey(key('t', { control: true, shift: true }))).toBe(false)
    expect(isWindowKey(key('w', { control: true, alt: true }))).toBe(false)
  })
})

describe('afterClosing', () => {
  it('picks the tab before, else the one after', () => {
    expect(afterClosing(['a', 'b', 'c'], 'b')).toBe('a')
    expect(afterClosing(['a', 'b', 'c'], 'a')).toBe('b')
    expect(afterClosing(['a', 'b', 'c'], 'c')).toBe('b')
  })

  it('has none when the last tab closes', () => {
    expect(afterClosing(['a'], 'a')).toBeNull()
    expect(afterClosing([], 'a')).toBeNull()
  })
})
