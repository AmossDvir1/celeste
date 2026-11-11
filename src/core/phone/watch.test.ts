import { afterEach, describe, expect, it } from 'vitest'
import type { IceServer, PhonePairRequest } from '@shared/phone'
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
    }
  })
  await bridge.start()
  stops.push(() => bridge.stop())
  const pairing: PhonePairing = await pair(`http://127.0.0.1:${bridge.port}`, 'Pixel test', () => undefined)
  return { bridge, control, started, stopped, link: new PhoneLink(pairing, { rtc: null }), pairing }
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
