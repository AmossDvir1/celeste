import { afterEach, describe, expect, it } from 'vitest'
import { RTCPeerConnection } from 'node-datachannel/polyfill'
import type { CorePush } from '@shared/api'
import { PhoneLink, pair, type LinkState, type PhonePairing } from '@shared/phone-client'
import type { PeerLike } from '@shared/direct'
import type { PhoneBootstrap, PhonePairRequest } from '@shared/phone'
import { startRelay, type StandInRelay } from '../testing/relay'
import { PhoneBridge } from './bridge'

const stops: (() => unknown)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

const Rtc = RTCPeerConnection as unknown as new (config: { iceServers: { urls: string[] }[] }) => PeerLike

async function waitFor(ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('Timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** A computer with a stand-in relay that hands out no ICE servers (so nothing here reaches the internet), and one paired phone. */
async function setup(fixedIce: { urls: string[] }[] | undefined = []) {
  const relay: StandInRelay = await startRelay({ ...(fixedIce ? { fixedIce } : {}) })
  stops.push(() => relay.stop())
  const settings: Record<string, unknown> = { phoneEnabled: true }
  const bridge: PhoneBridge = new PhoneBridge({
    store: { settings: () => settings, setSetting: (k, v) => void (settings[k] = v) },
    call: async (method, params) => (method === 'phone.hello' ? { computer: 'TEST-PC', version: '9.9.9', userName: 'Dana', theme: 'dark', sessions: [] } : { echo: method, size: JSON.stringify(params).length }),
    computerName: () => 'TEST-PC',
    version: '9.9.9',
    apkFile: () => null,
    onStatus: () => undefined,
    onPairing: (r: PhonePairRequest | null) => void (r && setTimeout(() => bridge.answer(r.pairId, true), 10)),
    addresses: () => ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0,
    relayUrl: () => relay.url,
    chatTitle: () => 'Build the app'
  })
  await bridge.start()
  stops.push(() => bridge.stop())
  const base = `http://127.0.0.1:${bridge.port}`
  const pairing = await pair(base, 'Pixel test', () => undefined)
  await waitFor(() => bridge.status().relay === 'connected')
  const boot = await new PhoneLink(pairing, { rtc: null }).call<PhoneBootstrap>('phone.hello')
  return { relay, bridge, pairing: { ...pairing, relay: boot.relay } as PhonePairing }
}

/** A phone that is away from home (the Wi-Fi address does not answer). */
function away(pairing: PhonePairing, rtc: typeof Rtc | null = Rtc) {
  const got: CorePush[] = []
  const states: LinkState[] = []
  const link = new PhoneLink(pairing, { fetch: () => Promise.reject(new Error('unreachable')), probeMs: 200, rtc })
  stops.push(link.listen((p) => got.push(p as CorePush), (s) => states.push(s)))
  return { link, got, states }
}

describe('the direct link, away from home', () => {
  it('opens over the relay and then carries calls and pushes, without the relay seeing them', async () => {
    const { relay, bridge, pairing } = await setup()
    const phone = away(pairing)
    await waitFor(() => phone.link.route === 'direct')
    expect(bridge.listening()).toHaveLength(1)

    const before = relay.seen.length
    expect(await phone.link.call('sessions.get', 'a-private-chat-id')).toEqual({ echo: 'sessions.get', size: expect.any(Number) })
    // A frame larger than one piece, and larger than a data channel takes in one message.
    const big = 'q'.repeat(1_300_000)
    expect(await phone.link.call('sessions.get', big)).toMatchObject({ echo: 'sessions.get' })
    expect(relay.seen.length).toBe(before)

    // One push, once: the phone also has its relay line open, and must not hear everything twice.
    bridge.broadcast({ type: 'removed', id: 'only-once' })
    bridge.broadcast({ type: 'removed', id: 'and-in-order' })
    await waitFor(() => phone.got.length >= 2)
    await new Promise((r) => setTimeout(r, 300))
    expect(phone.got).toEqual([
      { type: 'removed', id: 'only-once' },
      { type: 'removed', id: 'and-in-order' }
    ])
    expect(relay.seen.length).toBe(before)
  }, 40_000)

  it('stays on the relay when the phone cannot do WebRTC', async () => {
    const { bridge, pairing } = await setup()
    const phone = away(pairing, null)
    await waitFor(() => phone.states.includes('connected'))
    await new Promise((r) => setTimeout(r, 500))
    expect(phone.link.route).toBe('relay')
    expect(await phone.link.call('sessions.get', 'x')).toMatchObject({ echo: 'sessions.get' })
    expect(bridge.listening()).toHaveLength(1)
  })

  it('goes back to the relay when the link closes, and catches up', async () => {
    const { bridge, pairing } = await setup()
    const phone = away(pairing)
    await waitFor(() => phone.link.route === 'direct')
    const connects = phone.states.filter((s) => s === 'connected').length
    ;(bridge as unknown as { direct: { closeAll(): void } }).direct.closeAll()
    await waitFor(() => phone.link.route === 'relay')
    // It told the app it is connected again, so the app fetches what it missed.
    await waitFor(() => phone.states.filter((s) => s === 'connected').length > connects)
    expect(await phone.link.call('sessions.get', 'x')).toMatchObject({ echo: 'sessions.get' })
    bridge.broadcast({ type: 'removed', id: 'after-the-drop' })
    await waitFor(() => phone.got.some((p) => (p as { id?: string }).id === 'after-the-drop'))
  }, 40_000)

  it('refuses a direct channel that is not from a paired phone', async () => {
    const { bridge, pairing } = await setup()
    const stranger = { ...pairing, phoneId: 'nobody-here', keys: pairing.keys }
    const link = new PhoneLink(stranger, { fetch: () => Promise.reject(new Error('unreachable')), rtc: Rtc })
    await expect(link.call('phone.linkInfo')).rejects.toThrow()
    expect(bridge.listening()).toHaveLength(0)
  })
})
