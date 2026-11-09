import { afterEach, describe, expect, it } from 'vitest'
import type { PhoneRequest } from '@shared/phone'
import { PhoneLink, pair } from '@shared/phone-client'
import { PhoneBridge } from './bridge'
import { PhoneTools } from './tools'

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
  const tools = new PhoneTools(() => bridge, (id) => `Chat ${id}`)
  return { bridge, tools, base: `http://127.0.0.1:${bridge.port}` }
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
      void link.call('phone.reply', { id: p.request.id, ...answer(p.request) })
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
    expect(tools.list().length).toBe(12)
    await bridge.setEnabled(false)
    expect(tools.list()).toEqual([])
    await bridge.setEnabled(true)
    expect(tools.list().map((t) => t.name)).toEqual(['phone_status', 'phone_notifications', 'phone_notification_reply', 'phone_open', 'phone_alarm', 'phone_request_control', 'phone_screen', 'phone_tap', 'phone_type', 'phone_swipe', 'phone_key', 'phone_release_control'])
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
    expect(p.asked).toEqual([])
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
          void link.call('phone.ack', { id: push.request.id })
          setTimeout(() => void link.call('phone.reply', { id: push.request.id, ok: true, text: 'Allowed after a while' }), 600)
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
          if (push.type === 'phoneRequest') void link.call('phone.ack', { id: push.request.id })
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
})
