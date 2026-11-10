import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PhoneRequest } from '@shared/phone'
import { PhoneLink, pair } from '@shared/phone-client'
import { PhoneBridge } from './bridge'
import { PHOTOS_SHOWN_BYTES, PhoneTools, realTime, safeName, shownPhotos } from './tools'

const running: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const stop of running.splice(0)) await stop()
})

async function setup() {
  const settings: Record<string, unknown> = { phoneEnabled: true }
  const bridge: PhoneBridge = new PhoneBridge({
    store: { settings: () => settings, setSetting: (k, v) => void (settings[k] = v) },
    call: async () => null,
    computerName: () => 'TEST-PC',
    version: '1.0.0',
    apkFile: () => null,
    onStatus: () => undefined,
    onPairing: (r) => void (r && setTimeout(() => bridge.answer(r.pairId, true), 5)),
    addresses: () => ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0
  })
  await bridge.start()
  running.push(() => bridge.stop())
  const received = mkdtempSync(join(tmpdir(), 'celeste-phone-'))
  running.push(() => rmSync(received, { recursive: true, force: true }))
  const tools = new PhoneTools(() => bridge, (id) => `Chat ${id}`, () => received)
  return { bridge, tools, received, base: `http://127.0.0.1:${bridge.port}` }
}

/** A stand-in phone: answers every request with `answer`, and remembers what it was asked. */
async function phone(base: string, answer: (r: PhoneRequest) => { ok: boolean; text: string }) {
  const pairing = await pair(base, 'Stand-in', () => undefined)
  const link = new PhoneLink(pairing)
  const asked: PhoneRequest[] = []
  let connected = false
  const stop = link.listen(
    (p) => {
      if (p.type !== 'phoneRequest') return
      asked.push(p.request)
      void link.call('phone.reply', { id: p.request.id, ...answer(p.request) }).catch(() => undefined)
    },
    (s) => (connected = s === 'connected')
  )
  running.push(stop)
  const until = Date.now() + 5000
  while (!connected && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
  return { asked, link }
}

describe('phone abilities as tools', () => {
  it('are listed while phones may connect, and not when that is off', async () => {
    const { tools, bridge } = await setup()
    expect(tools.list().length).toBe(20)
    await bridge.setEnabled(false)
    expect(tools.list()).toEqual([])
    await bridge.setEnabled(true)
    expect(tools.list().map((t) => t.name)).toEqual([
      'phone_status',
      'phone_notifications',
      'phone_notification_reply',
      'phone_notification_dismiss',
      'phone_open',
      'phone_alarm',
      'phone_location',
      'phone_photos',
      'phone_files',
      'phone_calendar',
      'phone_calendar_add',
      'phone_message',
      'phone_call',
      'phone_request_control',
      'phone_screen',
      'phone_tap',
      'phone_type',
      'phone_swipe',
      'phone_key',
      'phone_release_control'
    ])
  })

  it('send the request to the phone, with the chat’s name, and return its answer', async () => {
    const { tools, base } = await setup()
    const p = await phone(base, (r) => (r.ability === 'open' ? { ok: true, text: 'Opened Spotify.' } : { ok: false, text: 'The person said no.' }))
    expect(await tools.call('s1', 'phone_open', { app: 'Spotify' })).toEqual({ text: 'Opened Spotify.', isError: false })
    expect(p.asked[0]).toMatchObject({ ability: 'open', args: { app: 'Spotify' }, chat: 'Chat s1' })
    expect(await tools.call('s1', 'phone_alarm', { hour: 7, minute: 30 })).toEqual({ text: 'The person said no.', isError: true })
  })

  it('check what they are given before the phone sees it', async () => {
    const { tools, base } = await setup()
    const p = await phone(base, () => ({ ok: true, text: 'ok' }))
    expect((await tools.call('s', 'phone_open', {})).isError).toBe(true)
    expect((await tools.call('s', 'phone_open', { app: 'A', url: 'https://x' })).isError).toBe(true)
    expect((await tools.call('s', 'phone_alarm', { hour: 25 })).isError).toBe(true)
    expect((await tools.call('s', 'phone_notification_reply', { key: 'k', text: 'hi', extra: 1 })).isError).toBe(true)
    expect((await tools.call('s', 'phone_calendar_add', { title: 'Dentist', start: '2026-02-30' })).text).toMatch(/not a date/)
    expect((await tools.call('s', 'phone_calendar_add', { title: 'Dentist', start: '2026-03-02T10:00', end: '2026-03-02' })).text).toMatch(/same way/)
    expect((await tools.call('s', 'phone_calendar_add', { title: 'Dentist', start: '2026-03-02T10:00', end: '2026-03-02T09:00' })).text).toMatch(/before the start/)
    expect((await tools.call('s', 'phone_calendar_add', { title: 'Dentist', start: '2026-03-02 10:00' })).isError).toBe(true)
    expect((await tools.call('s', 'phone_calendar', { from: '2026-13-01' })).isError).toBe(true)
    expect((await tools.call('s', 'phone_calendar', { days: 90 })).isError).toBe(true)
    expect((await tools.call('s', 'phone_call', { to: '*21*0541234567#' })).text).toMatch(/not a phone number/)
    expect((await tools.call('s', 'phone_message', { to: '050-1234567' })).isError).toBe(true)
    expect((await tools.call('s', 'phone_photos', { max: 11 })).isError).toBe(true)
    expect(p.asked).toEqual([])
    expect((await tools.call('s', 'phone_call', { to: '+972 (50) 123-4567' })).isError).toBe(false)
    expect((await tools.call('s', 'phone_message', { to: 'Mom', text: 'On my way' })).isError).toBe(false)
    expect((await tools.call('s', 'phone_calendar_add', { title: 'Trip', start: '2026-03-02', end: '2026-03-04' })).isError).toBe(false)
    expect(p.asked.map((r) => r.ability)).toEqual(['call', 'message', 'calendar_add'])
  })

  it('know a real date, and make a safe file name from any name', () => {
    expect(realTime('2028-02-29')).toBe(true)
    expect(realTime('2026-02-29')).toBe(false)
    expect(realTime('2026-01-01T24:00')).toBe(false)
    expect(realTime('2026-01-01T23:59')).toBe(true)
    expect(safeName('IMG_2041.jpg', 'image/jpeg', 0)).toBe('IMG_2041.jpg')
    expect(safeName('../../evil:name?.pdf', 'application/pdf', 0)).toBe('.._.._evil_name_.pdf')
    expect(safeName('CON', 'text/plain', 0)).toBe('_CON.txt')
    expect(safeName('', 'image/jpeg', 2)).toBe('photo-3.jpg')
    expect(safeName('..', 'application/octet-stream', 0)).toBe('file-1')
    expect(safeName('a'.repeat(300) + '.pdf', 'application/pdf', 0)).toHaveLength(120)
  })

  it('show photos to the assistant up to a total size, and say how many were left out', () => {
    const photo = (mb: number, mime = 'image/jpeg') => ({ name: 'p.jpg', mime, data: Buffer.alloc(Math.round(mb * 1_048_576)) })
    const few = shownPhotos([photo(0.5), photo(0.5)])
    expect([few.images.length, few.left]).toEqual([2, 0])
    // Eight 1.8 MB photos: four fit under the cap (7.2 MB), the rest are only saved.
    const many = shownPhotos(Array.from({ length: 8 }, () => photo(1.8)))
    expect(many.images.length * 1.8 * 1_048_576).toBeLessThanOrEqual(PHOTOS_SHOWN_BYTES)
    expect([many.images.length, many.left]).toEqual([4, 4])
    expect(shownPhotos([photo(2.5), photo(0.1, 'image/heic')]).left).toBe(2)
  })

  it('a chat is not remembered: only a workflow step’s requests end when the step ends', async () => {
    const t = await setup()
    const tools = new PhoneTools(() => t.bridge, (id) => `Chat ${id}`, () => t.received, (id) => id.startsWith('wf-'))
    const p = await phone(t.base, () => ({ ok: true, text: 'ok' }))
    await tools.call('chat-1', 'phone_status', {})
    await tools.call('wf-1', 'phone_status', {})
    expect(p.asked).toHaveLength(2)
    expect((tools as unknown as { used: Set<string> }).used).toEqual(new Set(['wf-1']))
  })

  it('write phone control into the chat: started when allowed, each action, the person’s pause and Continue, and the end', async () => {
    const t = await setup()
    const events: { sessionId: string; type: string; [k: string]: unknown }[] = []
    const tools = new PhoneTools(() => t.bridge, (id) => `Chat ${id}`, () => t.received, () => false, (sessionId, e) => void events.push({ sessionId, ...e }))
    await phone(t.base, (r) =>
      r.ability === 'control_request'
        ? { ok: true, text: 'The user allowed it: you have control of the phone for up to 15 minutes.' }
        : r.ability === 'control_tap'
          ? { ok: true, text: 'Tapped "Sessions". Call phone_screen to see what changed.' }
          : r.ability === 'control_type'
            ? { ok: false, text: 'That is a password field. Ask the user to type it themselves.' }
            : { ok: true, text: 'ok' }
    )
    await tools.call('c1', 'phone_tap', { x: 1, y: 2 })
    expect(events).toEqual([])
    await tools.call('c1', 'phone_request_control', { reason: 'Find my best pace' })
    await tools.call('c1', 'phone_tap', { id: 13 })
    await tools.call('c1', 'phone_type', { text: 'hunter2' })
    await tools.call('c2', 'phone_screen', {})
    tools.controlReport({ state: 'paused' })
    tools.controlReport({ state: 'resumed' })
    tools.controlReport({ state: 'ended', why: 'The user pressed Stop on the phone.', actions: 3 })
    tools.controlReport({ state: 'paused' })
    const grantId = events[0]?.['grantId']
    expect(events.map(({ sessionId, type, text, ok, note, why, actions, where, reason }) => ({ sessionId, type, text, ok, note, why, actions, where, reason }))).toEqual([
      { sessionId: 'c1', type: 'desktop.started', where: 'phone', reason: 'Find my best pace', text: undefined, ok: undefined, note: undefined, why: undefined, actions: undefined },
      { sessionId: 'c1', type: 'desktop.action', text: 'Tapped "Sessions"', ok: true, note: undefined, why: undefined, actions: undefined, where: undefined, reason: undefined },
      { sessionId: 'c1', type: 'desktop.action', text: 'That is a password field', ok: false, note: undefined, why: undefined, actions: undefined, where: undefined, reason: undefined },
      { sessionId: 'c1', type: 'desktop.action', text: 'Paused: you touched the phone', ok: true, note: true, why: undefined, actions: undefined, where: undefined, reason: undefined },
      { sessionId: 'c1', type: 'desktop.action', text: 'Continue pressed on the phone', ok: true, note: true, why: undefined, actions: undefined, where: undefined, reason: undefined },
      { sessionId: 'c1', type: 'desktop.ended', why: 'The user pressed Stop on the phone.', actions: 3, text: undefined, ok: undefined, note: undefined, where: undefined, reason: undefined }
    ])
    expect(events.every((e) => e['grantId'] === grantId)).toBe(true)
  })

  it('say so when the phone is not connected, and nothing waits forever', async () => {
    const { tools, base, bridge } = await setup()
    await pair(base, 'Gone', () => undefined)
    const r = await tools.call('s', 'phone_status', {})
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not connected/)
    // A phone that is connected but never answers: the request ends with a refusal.
    const silent = await pair(base, 'Silent', () => undefined)
    const link = new PhoneLink(silent)
    let up = false
    running.push(link.listen(() => undefined, (s) => (up = s === 'connected')))
    while (!up) await new Promise((res) => setTimeout(res, 20))
    expect(await bridge.ask(silent.phoneId, 'status', {}, 'x', 200)).toEqual({ ok: false, text: 'Nobody answered on the phone in time.' })
  })

  it('give up within seconds on a phone that does not say it got the request', async () => {
    const { bridge, base } = await setup()
    const silent = await pair(base, 'Asleep', () => undefined)
    const link = new PhoneLink(silent)
    let up = false
    running.push(link.listen(() => undefined, (s) => (up = s === 'connected')))
    while (!up) await new Promise((res) => setTimeout(res, 20))
    const started = Date.now()
    const r = await bridge.ask(silent.phoneId, 'open', { app: 'Chrome' }, 'x', 60_000, 's', 300)
    expect(r.ok).toBe(false)
    expect(r.text).toMatch(/did not respond/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('a phone that says it got the request is waited for', async () => {
    const { bridge, base } = await setup()
    const p = await pair(base, 'Slow', () => undefined)
    const link = new PhoneLink(p)
    let up = false
    running.push(
      link.listen(
        (push) => {
          if (push.type !== 'phoneRequest') return
          void link.call('phone.ack', { id: push.request.id }).catch(() => undefined)
          setTimeout(() => void link.call('phone.reply', { id: push.request.id, ok: true, text: 'Allowed after a while' }).catch(() => undefined), 600)
        },
        (s) => (up = s === 'connected')
      )
    )
    while (!up) await new Promise((res) => setTimeout(res, 20))
    expect(await bridge.ask(p.phoneId, 'open', { app: 'Chrome' }, 'x', 60_000, 's', 300)).toEqual({ ok: true, text: 'Allowed after a while' })
  })

  it('Stop in the chat ends its waiting requests and tells the phone to drop them and end control', async () => {
    const { bridge, base } = await setup()
    const p = await pair(base, 'Holder', () => undefined)
    const link = new PhoneLink(p)
    const seen: unknown[] = []
    let up = false
    running.push(
      link.listen(
        (push) => {
          seen.push(push)
          if (push.type === 'phoneRequest') void link.call('phone.ack', { id: push.request.id }).catch(() => undefined)
        },
        (s) => (up = s === 'connected')
      )
    )
    while (!up) await new Promise((res) => setTimeout(res, 20))
    const waiting = bridge.ask(p.phoneId, 'open', { app: 'Chrome' }, 'x', 60_000, 'chat-1')
    const other = bridge.ask(p.phoneId, 'alarm', { hour: 7 }, 'y', 60_000, 'chat-2')
    await new Promise((res) => setTimeout(res, 300))
    bridge.cancel('chat-1')
    expect(await waiting).toEqual({ ok: false, text: 'The user stopped it.' })
    await new Promise((res) => setTimeout(res, 300))
    const cancel = seen.find((x) => (x as { type: string }).type === 'phoneCancel') as { ids: string[]; endControl: boolean }
    expect(cancel.endControl).toBe(true)
    expect(cancel.ids).toHaveLength(1)
    // The other chat's request is still waiting.
    bridge.cancel('chat-2')
    expect((await other).text).toBe('The user stopped it.')
  })

  it('a workflow step that used the phone ends what it started there when it ends, and one that did not leaves the phone alone', async () => {
    const { tools, base } = await setup()
    const p = await pair(base, 'Holder', () => undefined)
    const link = new PhoneLink(p)
    const seen: { type: string; why?: string; ids?: string[] }[] = []
    let up = false
    running.push(
      link.listen(
        (push) => {
          seen.push(push as never)
          if (push.type === 'phoneRequest') void link.call('phone.ack', { id: push.request.id }).catch(() => undefined)
        },
        (s) => (up = s === 'connected')
      )
    )
    while (!up) await new Promise((res) => setTimeout(res, 20))
    tools.ended('wf-other')
    const waiting = tools.call('wf-1', 'phone_open', { app: 'Chrome' })
    await new Promise((res) => setTimeout(res, 300))
    expect(seen.filter((x) => x.type === 'phoneCancel')).toEqual([])
    tools.ended('wf-1')
    expect(await waiting).toEqual({ text: 'The workflow step on the computer ended.', isError: true })
    await new Promise((res) => setTimeout(res, 300))
    expect(seen.find((x) => x.type === 'phoneCancel')).toMatchObject({ endControl: true, why: 'The workflow step on the computer ended.', ids: [expect.any(String)] })
    // Once is enough: it is forgotten after.
    tools.ended('wf-1')
    await new Promise((res) => setTimeout(res, 200))
    expect(seen.filter((x) => x.type === 'phoneCancel')).toHaveLength(1)
  })

  it('take an answer only from the phone that was asked', async () => {
    const { bridge, base } = await setup()
    const a = await phone(base, () => ({ ok: true, text: 'from A' }))
    void a
    const b = await pair(base, 'Other', () => undefined)
    const target = bridge.listening()[0]?.id as string
    const pending = bridge.ask(target, 'status', {}, 'x', 2000)
    // The other phone guesses at the id: refused, and the real answer still arrives.
    await expect(new PhoneLink(b).call('phone.reply', { id: 'guess', ok: true, text: 'forged' })).rejects.toThrow(/Nothing is waiting/)
    expect(await pending).toEqual({ ok: true, text: 'from A' })
  })
  it('carry a screenshot from the phone back to the assistant', async () => {
    const { tools, base } = await setup()
    await phone(base, () => ({ ok: true, text: 'Elements on screen: [1] Button Connections', image: { mime: 'image/jpeg', data: 'AAAA' } }) as never)
    const r = await tools.call('s', 'phone_screen', { screenshot: true })
    expect(r).toEqual({ text: 'Elements on screen: [1] Button Connections', isError: false, image: { mime: 'image/jpeg', data: 'AAAA' } })
    expect((await tools.call('s', 'phone_tap', { x: 5 })).isError).toBe(true)
  })

  it('save the photos the person picked, in parts, and show them to the assistant', async () => {
    const { tools, base, received } = await setup()
    const p = await pair(base, 'Picker', () => undefined)
    const link = new PhoneLink(p)
    let up = false
    running.push(
      link.listen(
        (push) => {
          if (push.type !== 'phoneRequest') return
          const id = push.request.id
          const b64 = (s: string) => Buffer.from(s).toString('base64')
          void (async () => {
            await link.call('phone.ack', { id })
            await link.call('phone.attach', { id, file: 0, name: 'IMG_1.jpg', mime: 'image/jpeg', part: 0, data: b64('hello '), last: false })
            await link.call('phone.attach', { id, file: 0, name: 'IMG_1.jpg', mime: 'image/jpeg', part: 1, data: b64('world'), last: true })
            await link.call('phone.attach', { id, file: 1, name: '', mime: 'image/png', part: 0, data: b64('png'), last: true })
            // A file that never finished is left out.
            await link.call('phone.attach', { id, file: 2, name: 'cut.jpg', mime: 'image/jpeg', part: 0, data: b64('half'), last: false })
            await link.call('phone.reply', { id, ok: true, text: 'The user picked 2 photos.' })
          })()
        },
        (s) => (up = s === 'connected')
      )
    )
    while (!up) await new Promise((res) => setTimeout(res, 20))
    const r = await tools.call('s', 'phone_photos', {})
    expect(r.isError).toBe(false)
    const day = readdirSync(received)[0] as string
    expect(readdirSync(join(received, day)).sort()).toEqual(['IMG_1.jpg', 'photo-2.png'])
    expect(readFileSync(join(received, day, 'IMG_1.jpg'), 'utf8')).toBe('hello world')
    expect(r.text).toContain(join(received, day, 'IMG_1.jpg'))
    expect(r.images).toEqual([
      { mime: 'image/jpeg', data: Buffer.from('hello world').toString('base64') },
      { mime: 'image/png', data: Buffer.from('png').toString('base64') }
    ])
    // The same name again gets a name of its own.
    await tools.call('s', 'phone_photos', {})
    expect(readdirSync(join(received, day)).sort()).toEqual(['IMG_1 (2).jpg', 'IMG_1.jpg', 'photo-2 (2).png', 'photo-2.png'])
  })

  it('take file parts only from the phone that was asked, in order, and within the limits', async () => {
    const { bridge, base } = await setup()
    const asked: string[] = []
    const p = await pair(base, 'Sender', () => undefined)
    const link = new PhoneLink(p)
    let up = false
    running.push(link.listen((push) => void (push.type === 'phoneRequest' && asked.push(push.request.id)), (s) => (up = s === 'connected')))
    while (!up) await new Promise((res) => setTimeout(res, 20))
    const other = new PhoneLink(await pair(base, 'Other', () => undefined))
    const pending = bridge.ask(p.phoneId, 'files', {}, 'x', 5000)
    while (!asked.length) await new Promise((res) => setTimeout(res, 20))
    const id = asked[0] as string
    const part = (file: number, n: number, last = true, data = 'AAAA') => ({ id, file, name: 'a.bin', mime: 'application/octet-stream', part: n, data, last })
    await expect(other.call('phone.attach', part(0, 0))).rejects.toThrow(/Nothing is waiting/)
    await expect(link.call('phone.attach', { ...part(0, 0), id: 'guess' })).rejects.toThrow(/Nothing is waiting/)
    await expect(link.call('phone.attach', part(0, 1))).rejects.toThrow(/out of order/)
    await expect(link.call('phone.attach', part(1, 0))).rejects.toThrow(/out of order/)
    await expect(link.call('phone.attach', part(0, 0, true, 'A'.repeat(1_400_000)))).rejects.toThrow(/not right/)
    await expect(link.call('phone.attach', part(0, 0, true, 'not base64!'))).rejects.toThrow(/not right/)
    for (let f = 0; f < 10; f++) await link.call('phone.attach', part(f, 0))
    await expect(link.call('phone.attach', part(10, 0))).rejects.toThrow(/At most 10/)
    await link.call('phone.reply', { id, ok: true, text: 'Ten files.' })
    const r = await pending
    expect(r.files).toHaveLength(10)
    expect(r.files?.[0]?.data).toEqual(Buffer.from('AAAA', 'base64'))
  })
})
