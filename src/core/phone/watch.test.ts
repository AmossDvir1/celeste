import { afterEach, describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import type { IceServer, PhonePairRequest, PhoneViewStopPush } from '@shared/phone'
import { PhoneLink, pair, type PhonePairing } from '@shared/phone-client'
import { PhoneBridge } from './bridge'

const stops: (() => unknown)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'

/** A computer with a fake main process for the screen: `control` says whether the assistant has the computer. */
async function setup() {
  const control = { on: true }
  const started: { phoneId: string; offer: string; servers: IceServer[] }[] = []
  const stopped: (string | undefined)[] = []
  const offered: { phoneId: string; name: string; offer: string; servers: IceServer[] }[] = []
  const ended: string[] = []
  const settings: Record<string, unknown> = { phoneEnabled: true }
  const bridge: PhoneBridge = new PhoneBridge({
    store: { settings: () => settings, setSetting: (k, v) => void (settings[k] = v) },
    call: async () => ({}),
    computerName: () => 'TEST-PC',
    version: '9.9.9',
    apkFile: () => null,
    onStatus: () => undefined,
    onPairing: (r: PhonePairRequest | null) => void (r && setTimeout(() => bridge.answer(r.pairId, true), 10)),
    addresses: () => ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0,
    relayUrl: () => '',
    watch: {
      start: async (phoneId, offer, servers) => {
        if (!control.on) throw new Error('The assistant is not using the computer now.')
        started.push({ phoneId, offer, servers })
        return 'v=0\r\nanswer'
      },
      stop: async (phoneId) => void stopped.push(phoneId)
    },
    view: {
      offer: async (phoneId, name, offer, servers) => {
        offered.push({ phoneId, name, offer, servers })
        return 'v=0\r\nview-answer'
      },
      end: (phoneId) => void ended.push(phoneId)
    }
  })
  await bridge.start()
  stops.push(() => bridge.stop())
  const pairing: PhonePairing = await pair(`http://127.0.0.1:${bridge.port}`, 'Pixel test', () => undefined)
  return { bridge, control, started, stopped, offered, ended, link: new PhoneLink(pairing, { rtc: null }), pairing }
}

describe('watching the computer’s screen from the phone', () => {
  it('is refused until the person allows that phone, then answers with the screen', async () => {
    const { bridge, link, started } = await setup()
    await expect(link.call('phone.watch', { sdp: OFFER })).rejects.toThrow(/Show the computer’s screen on this phone/)
    expect(started).toHaveLength(0)

    const phone = bridge.phones()[0]!
    bridge.setWatch(phone.id, true)
    expect(bridge.status().phones[0]?.watch).toBe(true)
    expect(await link.call('phone.watch', { sdp: OFFER })).toEqual({ sdp: 'v=0\r\nanswer' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ phoneId: phone.id, offer: OFFER })
    // Servers to find the other side with, always: public STUN when there is no relay.
    expect(started[0]?.servers.length).toBeGreaterThan(0)
  })

  it('says so when the assistant is not using the computer', async () => {
    const { bridge, link, control } = await setup()
    bridge.setWatch(bridge.phones()[0]!.id, true)
    control.on = false
    await expect(link.call('phone.watch', { sdp: OFFER })).rejects.toThrow('The assistant is not using the computer now.')
  })

  it('refuses a request that is not an offer', async () => {
    const { bridge, link, started } = await setup()
    bridge.setWatch(bridge.phones()[0]!.id, true)
    for (const bad of [undefined, 'nope', { sdp: 5 }, { sdp: 'not sdp' }, { sdp: 'v=0'.padEnd(50_000, 'x') }]) await expect(link.call('phone.watch', bad)).rejects.toThrow(/not a valid request/)
    expect(started).toHaveLength(0)
  })

  it('ends when the phone says so, when watching is switched off, and when the phone is removed', async () => {
    const { bridge, link, stopped } = await setup()
    const id = bridge.phones()[0]!.id
    bridge.setWatch(id, true)
    await link.call('phone.watchStop')
    expect(stopped).toEqual([id])
    bridge.setWatch(id, false)
    expect(stopped).toEqual([id, id])
    expect(bridge.status().phones[0]?.watch).toBeUndefined()
    // Switched off, it is refused again.
    await expect(link.call('phone.watch', { sdp: OFFER })).rejects.toThrow(/Show the computer’s screen/)
    bridge.setWatch(id, true)
    bridge.remove(id)
    expect(stopped).toEqual([id, id, id])
  })
})

describe('showing the phone’s screen on the computer', () => {
  it('hands the phone’s offer to the window, and the window’s answer back, with servers to connect through', async () => {
    const { link, offered, bridge } = await setup()
    expect(await link.call('phone.view', { sdp: OFFER })).toEqual({ sdp: 'v=0\r\nview-answer' })
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ phoneId: bridge.phones()[0]!.id, name: 'Pixel test', offer: OFFER })
    expect(offered[0]?.servers.length).toBeGreaterThan(0)
  })

  it('refuses what is not an offer', async () => {
    const { link, offered } = await setup()
    for (const bad of [undefined, 'nope', { sdp: 5 }, { sdp: 'not sdp' }, { sdp: 'v=0'.padEnd(50_000, 'x') }]) await expect(link.call('phone.view', bad)).rejects.toThrow(/not a valid request/)
    expect(offered).toHaveLength(0)
  })

  it('ends when the phone says so, and when the phone is removed', async () => {
    const { link, ended, bridge } = await setup()
    const id = bridge.phones()[0]!.id
    await link.call('phone.viewStop')
    expect(ended).toEqual([id])
    bridge.remove(id)
    expect(ended).toEqual([id, id])
  })

  it('tells the phone to stop sharing when the person presses Stop on the computer', async () => {
    const { link, bridge } = await setup()
    const got: (CorePush | PhoneViewStopPush)[] = []
    const stop = link.listen((p) => got.push(p as CorePush | PhoneViewStopPush), () => undefined)
    stops.push(stop)
    await new Promise((r) => setTimeout(r, 300))
    bridge.viewStop(bridge.phones()[0]!.id)
    const end = Date.now() + 5000
    while (!got.some((p) => p.type === 'phoneViewStop') && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
    expect(got.filter((p) => p.type === 'phoneViewStop')).toHaveLength(1)
  })
})

