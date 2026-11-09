import { afterEach, describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import { LABEL, open, seal, sessionKey, type PhonePairRequest, type PhoneCancelPush, type PhoneRequestPush, type SealedReply } from '@shared/phone'
import { PhoneLink, pair, type LinkState, type PhonePairing } from '@shared/phone-client'
import { PhoneBridge, isPrivate } from './bridge'

function makeBridge(opts: { answer?: (r: PhonePairRequest, b: PhoneBridge) => void } = {}) {
  const settings: Record<string, unknown> = { phoneEnabled: true }
  const calls: { method: string; params: unknown[] }[] = []
  const pairings: (PhonePairRequest | null)[] = []
  const bridge: PhoneBridge = new PhoneBridge({
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
    expect(await link.call('phone.hello')).toEqual({ echo: 'phone.hello', params: [] })
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
    const got: (CorePush | PhoneRequestPush | PhoneCancelPush)[] = []
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
