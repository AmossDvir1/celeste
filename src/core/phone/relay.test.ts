import { afterEach, describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import { RELAY_HOST_PROTOCOL, RELAY_PHONE_PROTOCOL, relaySocketUrl, type PhoneBootstrap, type PhoneCancelPush, type PhonePairRequest, type PhoneRequestPush } from '@shared/phone'
import { PhoneLink, pair, type LinkState, type PhonePairing } from '@shared/phone-client'
import { BURST, CLOSE, hostFrame, role, take } from '../../../relay/src/rules'
import { startRelay, type StandInRelay } from '../testing/relay'
import { PhoneBridge } from './bridge'

const stops: (() => unknown)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

/**
 * Set by `npm run verify:relay` to the address of the real Worker running locally (wrangler dev): the same scenarios then
 * go through it instead of the stand-in. What needs the stand-in's own controls is left out there.
 */
const REAL = process.env['CELESTE_RELAY_TEST_URL']
const standIn = REAL ? it.skip : it

/** A computer with phones on, a relay, and one phone paired on the Wi-Fi. */
async function setup() {
  const relay: StandInRelay = REAL ? { url: REAL, seen: [], dropAll: () => undefined, stop: async () => undefined } : await startRelay()
  stops.push(() => relay.stop())
  const settings: Record<string, unknown> = { phoneEnabled: true }
  const bridge: PhoneBridge = new PhoneBridge({
    store: { settings: () => settings, setSetting: (k, v) => void (settings[k] = v) },
    call: async (method) => (method === 'phone.hello' ? { computer: 'TEST-PC', version: '9.9.9', userName: 'Dana', theme: 'dark', sessions: [] } : { echo: method }),
    computerName: () => 'TEST-PC',
    version: '9.9.9',
    apkFile: () => null,
    onStatus: () => undefined,
    onPairing: (r: PhonePairRequest | null) => void (r && setTimeout(() => bridge.answer(r.pairId, true), 10)),
    addresses: () => ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0,
    relayUrl: () => relay.url
  })
  await bridge.start()
  stops.push(() => bridge.stop())
  const base = `http://127.0.0.1:${bridge.port}`
  expect(bridge.status().relay).toBe('off')
  const pairing = await pair(base, 'Pixel test', () => undefined)
  await waitFor(() => bridge.status().relay === 'connected')
  // On the Wi-Fi the phone learns where the computer is away from home.
  const boot = await new PhoneLink(pairing).call<PhoneBootstrap>('phone.hello')
  expect(boot.relay?.url).toBe(relay.url)
  return { relay, bridge, base, settings, pairing: { ...pairing, relay: boot.relay } as PhonePairing }
}

/** A phone that is away from home: the computer's Wi-Fi address does not answer it, until `home.at` is set. */
function away(pairing: PhonePairing, home = { at: false }) {
  const got: (CorePush | PhoneRequestPush | PhoneCancelPush)[] = []
  const states: LinkState[] = []
  const link = new PhoneLink(pairing, { fetch: (...a) => (home.at ? fetch(...a) : Promise.reject(new Error('unreachable'))), probeMs: 300, homeCheckMs: 100 })
  const stop = link.listen((p) => got.push(p), (s) => states.push(s))
  stops.push(stop)
  return { link, got, states, home }
}

describe('the relay, away from home', () => {
  it('carries calls and pushes for a phone that cannot reach the computer on the Wi-Fi, and reads none of it', async () => {
    const { relay, bridge, pairing } = await setup()
    const phone = away(pairing)
    await waitFor(() => phone.states.includes('connected'))
    expect(phone.link.route).toBe('relay')
    expect(bridge.listening()).toHaveLength(1)

    expect(await phone.link.call('sessions.get', 'a-private-chat-id')).toEqual({ echo: 'sessions.get' })
    await expect(phone.link.call('sessions.remove' as never, 'x')).rejects.toThrow('Not available from a phone.')

    bridge.broadcast({ type: 'removed', id: 'first-private-thing' })
    bridge.broadcast({ type: 'removed', id: 'second-private-thing' })
    bridge.broadcast({ type: 'phone' })
    await waitFor(() => phone.got.length === 2)
    expect(phone.got).toEqual([
      { type: 'removed', id: 'first-private-thing' },
      { type: 'removed', id: 'second-private-thing' }
    ])

    if (REAL) return
    const passed = relay.seen.join('\n')
    expect(relay.seen.length).toBeGreaterThan(4)
    for (const secret of ['sessions.get', 'a-private-chat-id', 'private-thing', 'Not available', 'echo']) expect(passed).not.toContain(secret)
  })

  it('pairs no phone and answers nothing to one that is not paired', async () => {
    const { relay, bridge, pairing } = await setup()
    const ws = new WebSocket(relaySocketUrl(relay.url, pairing.relay!.room), [RELAY_PHONE_PROTOCOL])
    const heard: string[] = []
    let closed = 0
    ws.onmessage = (e) => heard.push(String(e.data))
    ws.onclose = (e) => (closed = e.code)
    await waitFor(() => heard.includes('!host 1'))
    ws.send(JSON.stringify({ t: 'pair', commit: 'x', name: 'Stranger' }))
    ws.send('not json')
    ws.send(JSON.stringify({ t: 'rpc', id: 1, phone: pairing.phoneId, box: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))
    await waitFor(() => heard.length === 2)
    expect(JSON.parse(heard[1] as string)).toMatchObject({ t: 'rpc', id: 1, status: 401 })
    ws.send(JSON.stringify({ t: 'listen', phone: 'nobody', auth: 'x' }))
    await waitFor(() => closed !== 0)
    expect(closed).toBe(CLOSE.byHost)
    expect(JSON.parse(heard[2] as string)).toMatchObject({ t: 'listen', ok: false })
    expect(bridge.listening()).toHaveLength(0)
    expect(bridge.phones()).toHaveLength(1)
  })

  it('cuts off a phone removed on the computer, and closes the line with the last phone', async () => {
    const { bridge, pairing } = await setup()
    const phone = away(pairing)
    await waitFor(() => phone.states.includes('connected'))
    bridge.remove(pairing.phoneId)
    await waitFor(() => bridge.status().relay === 'off')
    expect(bridge.listening()).toHaveLength(0)
    await waitFor(() => phone.states.includes('offline'))
  })

  it('refuses a phone the computer no longer knows', async () => {
    const { bridge, settings, pairing } = await setup()
    // Another phone stays paired, so the line to the relay stays up.
    settings['phones'] = [{ id: 'other', name: 'Other', key: pairing.keys.pub, pairedAt: 1, lastSeen: 1 }]
    const phone = away(pairing)
    await waitFor(() => phone.states.includes('refused'))
    expect(bridge.listening()).toHaveLength(0)
  })

  standIn('comes back by itself after the relay drops every line', async () => {
    const { relay, bridge, pairing } = await setup()
    const phone = away(pairing)
    await waitFor(() => phone.states.includes('connected'))
    relay.dropAll()
    await waitFor(() => phone.states.includes('offline'))
    await waitFor(() => phone.states.filter((s) => s === 'connected').length === 2, 15_000)
    await waitFor(() => bridge.listening().length === 1)
    bridge.broadcast({ type: 'removed', id: 'after' })
    await waitFor(() => phone.got.length === 1)
    expect(await phone.link.call('runs.list')).toEqual({ echo: 'runs.list' })
  })

  it('says offline while the computer is away from the relay, and connects when it returns', async () => {
    const { bridge, pairing } = await setup()
    await bridge.setEnabled(false)
    const phone = away(pairing)
    await waitFor(() => phone.states.includes('offline'))
    expect(phone.states).not.toContain('connected')
    await expect(phone.link.call('runs.list')).rejects.toThrow('Can’t reach TEST-PC.')
    await bridge.setEnabled(true)
    await waitFor(() => phone.states.includes('connected'), 15_000)
    expect(phone.link.route).toBe('relay')
  })

  it('goes back to the Wi-Fi when the computer answers there again', async () => {
    const { bridge, pairing } = await setup()
    const phone = away(pairing)
    await waitFor(() => phone.link.route === 'relay')
    phone.home.at = true
    await waitFor(() => phone.link.route === 'wifi')
    expect(phone.states).not.toContain('offline')
    await waitFor(() => bridge.listening().length === 1)
    bridge.broadcast({ type: 'removed', id: 'at-home' })
    await waitFor(() => phone.got.length === 1)
  })

  it('gives a room to the first computer only, and none to a phone with a made-up room', async () => {
    const { relay, pairing } = await setup()
    const room = pairing.relay!.room
    const code = (ws: WebSocket) => new Promise<string>((resolve) => ((ws.onopen = () => resolve('open')), (ws.onerror = () => resolve('refused'))))
    expect(await code(new WebSocket(relaySocketUrl(relay.url, room), [RELAY_HOST_PROTOCOL, 'x'.repeat(43)]))).toBe('refused')
    expect(await code(new WebSocket(relaySocketUrl(relay.url, 'a'.repeat(22)), [RELAY_PHONE_PROTOCOL]))).toBe('refused')
    expect(await code(new WebSocket(relaySocketUrl(relay.url, room), ['something.else']))).toBe('refused')
  })

  it('closes a phone that sends too much too fast', async () => {
    const { relay, pairing } = await setup()
    const ws = new WebSocket(relaySocketUrl(relay.url, pairing.relay!.room), [RELAY_PHONE_PROTOCOL])
    let closed = 0
    ws.onclose = (e) => (closed = e.code)
    await new Promise((r) => (ws.onopen = r))
    for (let i = 0; i < BURST + 20; i++) ws.send('{}')
    await waitFor(() => closed !== 0)
    expect(closed).toBe(CLOSE.tooFast)
  })
})

describe('the relay’s rules', () => {
  it('tells a computer from a phone by the protocols it asks for', () => {
    expect(role('celeste.phone')).toEqual({ role: 'phone' })
    expect(role(`celeste.host, ${'s'.repeat(43)}`)).toEqual({ role: 'host', secret: 's'.repeat(43) })
    for (const h of [null, '', 'celeste.host', 'celeste.host, short', 'celeste.phone, extra', 'other']) expect(role(h)).toBeNull()
  })

  it('splits a computer’s frame by the phone it is for', () => {
    expect(hostFrame('0123456789ab {"t":"push"}')).toEqual({ conn: '0123456789ab', text: '{"t":"push"}' })
    for (const f of ['', 'host x', 'phone x', '0123456789abx', 'short x']) expect(hostFrame(f)).toBeNull()
  })

  it('lets a phone send a burst, then only as fast as it refills', () => {
    let b = undefined as ReturnType<typeof take>['bucket'] | undefined
    for (let i = 0; i < BURST; i++) {
      const t = take(b, 1000)
      expect(t.ok).toBe(true)
      b = t.bucket
    }
    expect(take(b, 1000).ok).toBe(false)
    expect(take(b, 2000).ok).toBe(true)
  })
})

async function waitFor(ok: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
