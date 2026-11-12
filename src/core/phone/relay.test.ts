import { afterEach, describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import { LABEL, RELAY_HOST_PROTOCOL, RELAY_PHONE_PROTOCOL, open, relaySocketUrl, seal, sessionKey, type PhoneBootstrap, type PhoneCancelPush, type PhonePairRequest, type PhoneRequestPush, type PhoneWake, type SealedReply } from '@shared/phone'
import { PhoneLink, pair, type LinkState, type PhonePairing } from '@shared/phone-client'
import { BURST, CLOSE, hostFrame, role, take } from '../../../relay/src/rules'
import { startGoogle, type StandInGoogle } from '../testing/google'
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
/** With the real Worker: where `verify:relay` told it Google is, and the key it was told to trust. */
const REAL_GOOGLE = REAL ? (JSON.parse(process.env['CELESTE_RELAY_TEST_GOOGLE'] ?? 'null') as { port: number; privatePem: string } | null) : null
const standIn = REAL ? it.skip : it

const FAKE_TOKEN = 'fcm-token-for-the-test-phone:APA91b' + 'x'.repeat(60)

/** A computer with phones on, a relay, and one phone paired on the Wi-Fi. */
async function setup() {
  const google: StandInGoogle = await startGoogle(REAL_GOOGLE ?? {})
  stops.push(() => google.stop())
  const relay: StandInRelay = REAL ? { url: REAL, seen: [], dropAll: () => undefined, stop: async () => undefined } : await startRelay(google.env)
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
    relayUrl: () => relay.url,
    chatTitle: () => 'Build the app'
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
  return { relay, google, bridge, base, settings, pairing: { ...pairing, relay: boot.relay } as PhonePairing }
}

/** What the app's background service does when it is woken: opens the sealed box Firebase brought, and answers over HTTP. */
async function woken(pairing: PhonePairing, box: string): Promise<PhoneWake> {
  const key = await sessionKey(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
  return open<PhoneWake>(key, box, LABEL.push)
}
async function answerOverHttp(relay: StandInRelay, pairing: PhonePairing, method: string, params: unknown[]): Promise<{ status: number; reply?: SealedReply }> {
  const key = await sessionKey(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
  const call = { id: 1, method, params, ts: Date.now(), n: Math.random().toString(36).repeat(3).slice(2, 18) }
  const url = `${relay.url.replace(/^ws/, 'http')}/v1/${pairing.relay!.room}/rpc`
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ phone: pairing.phoneId, box: await seal(key, call, LABEL.request) }) })
  const v = (await res.json()) as { box?: string }
  return { status: res.status, ...(v.box ? { reply: await open<SealedReply>(key, v.box, LABEL.response) } : {}) }
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
    await expect(phone.link.call('sessions.removeAll' as never)).rejects.toThrow('Not available from a phone.')

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

describe('the addresses for a direct link', () => {
  it('are handed to a phone by the computer, from the relay: TURN when the project set it up, STUN alone when not', async () => {
    const { bridge, google, pairing } = await setup()
    // Over the relay, as a phone away from home asks.
    const phone = away(pairing)
    await waitFor(() => phone.states.includes('connected'))
    const info = await phone.link.call<{ servers: { urls: string[]; username?: string; credential?: string }[] | null }>('phone.linkInfo')
    expect(info.servers?.[0]?.urls[0]).toMatch(/^stun:/)
    expect(info.servers?.some((s) => s.username?.startsWith('user-') && s.urls.some((u) => u.startsWith('turn')))).toBe(true)
    // Kept for a while, not asked of Cloudflare for every phone.
    await phone.link.call('phone.linkInfo')
    if (!REAL) expect(google.turnAsked).toHaveLength(1)
    expect(bridge.listening()).toHaveLength(1)
  })
})

describe('waking a closed app', () => {
  it('wakes a phone through Firebase with a sealed notice only the phone can open', async () => {
    const { bridge, google, pairing } = await setup()
    const link = new PhoneLink(pairing)
    await expect(link.call('phone.push', 'short')).rejects.toThrow('That is not a push token.')
    await link.call('phone.push', FAKE_TOKEN)
    expect(bridge.phones()[0]?.push?.token).toBe(FAKE_TOKEN)

    bridge.broadcast({ type: 'event', sessionId: 's1', stored: { seq: 1, at: 1, event: { type: 'approval.requested', requestId: 'r1', kind: 'shell', title: 'Run npm test', detail: 'in D:/secret-project' } } } as CorePush)
    bridge.broadcast({ type: 'event', sessionId: 's1', stored: { seq: 2, at: 2, event: { type: 'turn.completed', turnId: 't' } } } as CorePush)
    await waitFor(() => google.sent.length >= 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(google.sent).toHaveLength(1)
    const m = google.sent[0]!
    expect(m).toMatchObject({ token: FAKE_TOKEN, priority: 'HIGH', ttl: '300s' })
    expect(Object.keys(m.data)).toEqual(['b'])
    expect(m.data['b']).not.toContain('npm test')
    expect(await woken(pairing, m.data['b']!)).toEqual({ type: 'notify', kind: 'approval', id: 'r1', sessionId: 's1', chat: 'Build the app', text: 'Run npm test: in D:/secret-project' })

    // The phone no longer wants to be woken.
    await link.call('phone.push', null)
    expect(bridge.phones()[0]?.push).toBeUndefined()
  })

  it('asks a closed phone to do something, and takes its answer over HTTP, with no stream open', async () => {
    const { bridge, google, relay, pairing } = await setup()
    await new PhoneLink(pairing).call('phone.push', FAKE_TOKEN)
    expect(bridge.listening()).toHaveLength(0)
    expect(bridge.reachable().map((p) => p.id)).toEqual([pairing.phoneId])

    const asked = bridge.ask(pairing.phoneId, 'status', {}, 'Build the app', 20_000, 's1', 20_000)
    await waitFor(() => google.sent.length === 1)
    expect(google.sent[0]).toMatchObject({ ttl: '120s' })
    const wake = (await woken(pairing, google.sent[0]!.data['b']!)) as PhoneRequestPush
    expect(wake).toMatchObject({ type: 'phoneRequest', request: { ability: 'status', chat: 'Build the app' } })

    // The service says it got it, then answers: both are sealed requests POSTed to the relay.
    expect((await answerOverHttp(relay, pairing, 'phone.ack', [{ id: wake.request.id }])).reply).toMatchObject({ ok: true })
    expect((await answerOverHttp(relay, pairing, 'phone.reply', [{ id: wake.request.id, ok: true, text: 'The phone is here.' }])).reply).toMatchObject({ ok: true })
    expect(await asked).toEqual({ ok: true, text: 'The phone is here.' })
  })

  it('asks the phone to drop its cards when Stop is pressed, even with the app closed', async () => {
    const { bridge, google, pairing } = await setup()
    await new PhoneLink(pairing).call('phone.push', FAKE_TOKEN)
    void bridge.ask(pairing.phoneId, 'status', {}, 'chat', 20_000, 's1', 20_000)
    await waitFor(() => google.sent.length === 1)
    bridge.cancel('s1', 'Stopped.')
    await waitFor(() => google.sent.length === 2)
    expect(await woken(pairing, google.sent[1]!.data['b']!)).toMatchObject({ type: 'phoneCancel', endControl: true, why: 'Stopped.' })
  })

  it('forgets a token Google says is no longer registered, and carries on after an access token expires', async () => {
    const { bridge, google, pairing } = await setup()
    const link = new PhoneLink(pairing)
    await link.call('phone.push', FAKE_TOKEN)
    const approval = (n: number) => ({ type: 'event', sessionId: 's1', stored: { seq: n, at: n, event: { type: 'approval.requested', requestId: `r${n}`, kind: 'shell', title: 'Run it' } } }) as CorePush

    bridge.broadcast(approval(1))
    await waitFor(() => google.sent.length === 1)
    google.expireToken()
    bridge.broadcast(approval(2))
    await waitFor(() => google.sent.length === 2)
    expect(google.tokens()).toBe(2)

    google.unregistered.add(FAKE_TOKEN)
    bridge.broadcast(approval(3))
    await waitFor(() => bridge.phones()[0]?.push === undefined)
    expect(google.sent).toHaveLength(2)
    expect(bridge.reachable()).toHaveLength(0)
  })

  it('does not answer a request over HTTP when the computer is not connected, or for a phone that is not paired', async () => {
    const { bridge, relay, pairing } = await setup()
    const stranger = { ...pairing, phoneId: 'nobody' }
    expect((await answerOverHttp(relay, stranger, 'sessions.get', ['x'])).status).toBe(401)
    await bridge.setEnabled(false)
    await waitFor(() => bridge.status().relay === 'off')
    expect((await answerOverHttp(relay, pairing, 'sessions.get', ['x'])).status).toBe(503)
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
