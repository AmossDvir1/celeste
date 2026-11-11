import { afterEach, describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import { LABEL, open, seal, sessionKey, type PhonePairRequest, type PhoneCancelPush, type PhoneViewStopPush, type PhoneRequestPush, type SealedReply } from '@shared/phone'
import { PhoneLink, pair, type LinkState, type PhonePairing } from '@shared/phone-client'
import { PhoneBridge, isPrivate } from './bridge'

function makeBridge(opts: { answer?: (r: PhonePairRequest, b: PhoneBridge) => void } = {}) {
  const settings: Record<string, unknown> = { phoneEnabled: true }
  const calls: { method: string; params: unknown[] }[] = []
  const pairings: (PhonePairRequest | null)[] = []
  const bridge: PhoneBridge = new PhoneBridge({
    relayUrl: () => '',
    store: { settings: () => settings, setSetting: (k, v) => void (settings[k] = v) },
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'sessions.send') throw new Error('No such session')
      return { echo: method, params }
    },
    computerName: () => 'TEST-PC',
    version: '9.9.9',
    apkFile: () => null,
    onStatus: () => undefined,
    onPairing: (r) => {
      pairings.push(r)
      if (r) setTimeout(() => opts.answer?.(r, bridge), 10)
    },
    addresses: () => ['127.0.0.1'],
    host: '127.0.0.1',
    port: 0
  })
  return { bridge, settings, calls, pairings }
}

const running: PhoneBridge[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((b) => b.stop()))
})

async function started(opts: Parameters<typeof makeBridge>[0] = {}) {
  const made = makeBridge(opts)
  await made.bridge.start()
  running.push(made.bridge)
  return { ...made, base: `http://127.0.0.1:${made.bridge.port}` }
}

async function paired() {
  const t = await started({ answer: (r, b) => b.answer(r.pairId, true) })
  let shown: string[] = []
  const pairing = await pair(t.base, 'Pixel test', (e) => (shown = e))
  return { ...t, pairing, shown }
}

describe('phone bridge', () => {
  it('keeps its key in the secret store, moving one an older Celeste kept in its settings, and keeps it there without one', async () => {
    const hello = async (settings: Record<string, unknown>, vault: { value: string | null; works: boolean } | null) => {
      const b = new PhoneBridge({
        relayUrl: () => '',
        store: { settings: () => settings, setSetting: (k, v) => void (settings[k] = v) },
        call: async () => null,
        computerName: () => 'TEST-PC',
        version: '1',
        apkFile: () => null,
        onStatus: () => undefined,
        onPairing: () => undefined,
        addresses: () => ['127.0.0.1'],
        host: '127.0.0.1',
        port: 0,
        ...(vault ? { keyStore: { get: async () => vault.value, set: async (v: string) => (vault.works ? ((vault.value = v), true) : false) } } : {})
      })
      await b.start()
      running.push(b)
      return ((await (await fetch(`http://127.0.0.1:${b.port}/hello`)).json()) as { key: string }).key
    }
    // A key an older Celeste kept in its settings moves to the store, and the settings forget it.
    const old = { phoneEnabled: true, phoneKey: { pub: 'OLDPUB', priv: { kty: 'OKP' } } }
    const vault = { value: null as string | null, works: true }
    expect(await hello(old, vault)).toBe('OLDPUB')
    expect(old.phoneKey).toBeNull()
    expect(JSON.parse(vault.value ?? '{}').pub).toBe('OLDPUB')
    // Next time it comes from the store.
    expect(await hello({ phoneEnabled: true }, vault)).toBe('OLDPUB')
    // A new computer: made once, straight into the store.
    const fresh = { value: null as string | null, works: true }
    const settings: Record<string, unknown> = { phoneEnabled: true }
    const key = await hello(settings, fresh)
    expect(JSON.parse(fresh.value ?? '{}').pub).toBe(key)
    expect(settings['phoneKey']).toBeUndefined()
    // No secret store on this computer: the settings keep it, as before.
    const none: Record<string, unknown> = { phoneEnabled: true }
    const k2 = await hello(none, { value: null, works: false })
    expect((none['phoneKey'] as { pub: string }).pub).toBe(k2)
  })

  it('pairs after Allow, with the same three pictures on both screens', async () => {
    const { bridge, pairing, shown, pairings } = await paired()
    expect(shown).toHaveLength(3)
    expect(pairings[0]?.emoji).toEqual(shown)
    expect(pairings[0]?.name).toBe('Pixel test')
    expect(bridge.phones().map((p) => p.id)).toEqual([pairing.phoneId])
    expect(pairing.computer.name).toBe('TEST-PC')
  })

  it('does not pair when the person presses Deny', async () => {
    const t = await started({ answer: (r, b) => b.answer(r.pairId, false) })
    await expect(pair(t.base, 'Pixel', () => undefined)).rejects.toThrow(/said no/)
    expect(t.bridge.phones()).toEqual([])
  })

  it('refuses a reveal that does not match the commitment', async () => {
    const t = await started()
    const start = (await (await fetch(`${t.base}/pair/start`, { method: 'POST', body: JSON.stringify({ commit: 'A'.repeat(44), name: 'x' }) })).json()) as { pairId: string }
    const reveal = await fetch(`${t.base}/pair/reveal`, { method: 'POST', body: JSON.stringify({ pairId: start.pairId, key: 'B'.repeat(44), nonce: 'C'.repeat(24) }) })
    expect(reveal.status).toBe(400)
    expect(t.pairings).toEqual([])
  })

  it('runs allowed methods for a paired phone and refuses the rest', async () => {
    const { pairing, calls, base } = await paired()
    const link = new PhoneLink(pairing)
    // With no relay, the computer says so: a phone that knew one forgets it.
    expect(await link.call('phone.hello')).toEqual({ echo: 'phone.hello', params: [], relay: null })
    await expect(link.call('sessions.send', 's1', { text: 'hi' })).rejects.toThrow('No such session')
    // A method that is not on the list never reaches Core, even when it is sealed properly.
    const key = await sessionKey(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
    const box = await seal(key, { id: 9, method: 'settings.patch', params: [{ desktopControl: true }], ts: Date.now(), n: 'abc' }, LABEL.request)
    const res = (await (await fetch(`${base}/rpc`, { method: 'POST', body: JSON.stringify({ phone: pairing.phoneId, box }) })).json()) as { box: string }
    const reply = await open<SealedReply>(key, res.box, LABEL.response)
    expect(reply).toEqual({ id: 9, ok: false, error: 'Not available from a phone.' })
    expect(calls.map((c) => c.method)).toEqual(['phone.hello', 'sessions.send'])
  })

  it('refuses a request sent twice, a changed one, and one from a removed phone', async () => {
    const { pairing, base, bridge } = await paired()
    const key = await sessionKey(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
    const box = await seal(key, { id: 1, method: 'phone.hello', params: [], ts: Date.now(), n: 'once' }, LABEL.request)
    const send = (b: string) => fetch(`${base}/rpc`, { method: 'POST', body: JSON.stringify({ phone: pairing.phoneId, box: b }) })
    expect((await send(box)).status).toBe(200)
    expect((await send(box)).status).toBe(401)
    const changed = box.slice(0, -4) + (box.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect((await send(changed)).status).toBe(401)
    const old = await seal(key, { id: 2, method: 'phone.hello', params: [], ts: Date.now() - 10 * 60_000, n: 'old' }, LABEL.request)
    expect((await send(old)).status).toBe(401)
    bridge.remove(pairing.phoneId)
    await expect(new PhoneLink(pairing).call('phone.hello')).rejects.toThrow(/not paired/)
  })

  it('a phone with a key of its own making cannot get in', async () => {
    const { pairing } = await paired()
    const { pairing: other } = await paired()
    const forged: PhonePairing = { ...other, phoneId: pairing.phoneId, base: pairing.base }
    await expect(new PhoneLink(forged).call('phone.hello')).rejects.toThrow(/not paired/)
  })

  it('streams the pushes a phone may see, sealed, in order', async () => {
    const { pairing, bridge } = await paired()
    const got: (CorePush | PhoneRequestPush | PhoneCancelPush | PhoneViewStopPush)[] = []
    const states: LinkState[] = []
    const stop = new PhoneLink(pairing).listen((p) => got.push(p), (s) => states.push(s))
    await waitFor(() => states.includes('connected'))
    bridge.broadcast({ type: 'terminal', sessionId: 's', data: 'secret' })
    bridge.broadcast({ type: 'removed', id: 'a' })
    bridge.broadcast({ type: 'removed', id: 'b' })
    bridge.broadcast({ type: 'vendor', vendor: 'claude', progress: { state: 'done', account: 'x' } })
    bridge.broadcast({ type: 'removed', id: 'c' })
    await waitFor(() => got.length === 3)
    expect(got).toEqual([{ type: 'removed', id: 'a' }, { type: 'removed', id: 'b' }, { type: 'removed', id: 'c' }])
    // Removing the phone ends its stream, and it is not let back in.
    bridge.remove(pairing.phoneId)
    await waitFor(() => states.at(-1) === 'refused')
    stop()
  })

  it('answers nothing but the install page, hello and pairing to a phone that is not paired', async () => {
    const t = await started()
    expect((await fetch(`${t.base}/hello`)).status).toBe(200)
    expect((await fetch(`${t.base}/`)).status).toBe(200)
    expect((await fetch(`${t.base}/celeste.apk`)).status).toBe(404)
    expect((await fetch(`${t.base}/events?phone=nobody&auth=x`)).status).toBe(401)
    expect((await fetch(`${t.base}/rpc`, { method: 'POST', body: JSON.stringify({ phone: 'nobody', box: 'x' }) })).status).toBe(401)
  })

  it('starts the stream again when it goes quiet past the pings, and pushes reach the new one', async () => {
    const { pairing, bridge } = await paired()
    const got: (CorePush | PhoneRequestPush | PhoneCancelPush | PhoneViewStopPush)[] = []
    const states: LinkState[] = []
    // The bridge pings every 20 s: a phone that expects to hear something every 300 ms takes the line for dead.
    const stop = new PhoneLink(pairing, { silentMs: 300 }).listen((p) => got.push(p), (s) => states.push(s))
    await waitFor(() => states.filter((s) => s === 'connected').length >= 2)
    // Quietly: the app never shows itself offline for it.
    expect(states.slice(0, 3)).toEqual(['connecting', 'connected', 'connected'])
    bridge.broadcast({ type: 'removed', id: 'after' })
    await waitFor(() => got.length === 1)
    expect(bridge.listening()).toHaveLength(1)
    stop()
  })

  it('opens a new stream at once when asked, without going offline, and pushes reach it', async () => {
    const { pairing, bridge } = await paired()
    const got: (CorePush | PhoneRequestPush | PhoneCancelPush | PhoneViewStopPush)[] = []
    const states: LinkState[] = []
    const link = new PhoneLink(pairing)
    const stop = link.listen((p) => got.push(p), (s) => states.push(s))
    await waitFor(() => states.includes('connected'))
    link.reopen()
    await waitFor(() => states.filter((s) => s === 'connected').length === 2)
    expect(states).toEqual(['connecting', 'connected', 'connected'])
    await waitFor(() => bridge.listening().length === 1)
    bridge.broadcast({ type: 'removed', id: 'after' })
    await waitFor(() => got.length === 1)
    // Once stopped, asking again does nothing.
    stop()
    link.reopen()
    await new Promise((r) => setTimeout(r, 100))
    expect(states).toEqual(['connecting', 'connected', 'connected'])
  })

  it('stops listening when turned off', async () => {
    const t = await started()
    await t.bridge.setEnabled(false)
    expect(t.bridge.status().running).toBe(false)
    await expect(fetch(`${t.base}/hello`)).rejects.toThrow()
  })

  it('knows which addresses are on the local network', () => {
    for (const a of ['192.168.1.5', '10.0.0.2', '172.16.4.1', '172.31.255.1', '127.0.0.1', '::1', '::ffff:192.168.0.9', 'fe80::1', 'fd00::5']) expect(isPrivate(a)).toBe(true)
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', undefined]) expect(isPrivate(a)).toBe(false)
  })
})

async function waitFor(ok: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error('Timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
