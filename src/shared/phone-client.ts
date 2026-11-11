// The phone's side of the phone protocol (src/shared/phone.ts). Used by the Android app, and by tests as a stand-in phone.
// Only fetch, WebSocket and WebCrypto, so it runs the same in a WebView and in Node. The live stream is read from fetch's body
// rather than EventSource, which Node does not have and which cannot be told to stop retrying a refused phone.

import type { CorePush } from './api'
import { DIRECT_CHANNEL, FrameChannel, gathered, type PeerLike } from './direct'
import { PUBLIC_BROKERS, PUBLIC_ICE, SignalChannel, signalTopic, type SignalMessage } from './signal'
import {
  LABEL,
  RELAY_PHONE_PROTOCOL,
  commitment,
  makeKeyPair,
  open,
  pairingEmoji,
  randomB64,
  relaySocketUrl,
  seal,
  sessionKey,
  sessionKeyBytes,
  type IceServer,
  type PhoneHello,
  type PhoneLinkAnswer,
  type PhoneLinkInfo,
  type PhoneLinkOffer,
  type PhoneMethod,
  type PhoneCancelPush,
  type PhoneViewStopPush,
  type PhoneRelayInfo,
  type PhoneRequestPush,
  type RelayHostFrame,
  type RelayPhoneFrame,
  type SealedCall,
  type SealedReply,
  type StoredKeyPair
} from './phone'

/** What the phone keeps after pairing, to connect again later without asking. */
export interface PhonePairing {
  /** Where the computer was last found, like http://192.168.1.5:41234 */
  base: string
  phoneId: string
  keys: StoredKeyPair
  computer: PhoneHello
  /** Where the computer is found away from home, as it last said (`phone.hello`). */
  relay?: PhoneRelayInfo | null
}

type Fetch = typeof fetch

async function json<T>(res: Response): Promise<T> {
  const v = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new PhoneError(v.error ?? `The computer answered ${res.status}.`, res.status)
  return v
}

export class PhoneError extends Error {
  constructor(
    message: string,
    readonly status = 0
  ) {
    super(message)
  }
}

/** Asks the computer at `base` who it is. Fails fast when nothing is there. */
export async function hello(base: string, f: Fetch = fetch, timeoutMs = 4000): Promise<PhoneHello> {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), timeoutMs)
  try {
    return await json<PhoneHello>(await f(`${base}/hello`, { signal: stop.signal }))
  } catch (err) {
    if (err instanceof PhoneError) throw err
    throw new PhoneError('Celeste did not answer at that address.')
  } finally {
    clearTimeout(timer)
  }
}

const post = (f: Fetch, url: string, body: unknown, signal?: AbortSignal) =>
  // text/plain keeps the request "simple", so a WebView sends it without asking permission first.
  f(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) })

/**
 * Pairs with the computer at `base`. `onPictures` is called with the three pictures to show while the person checks them
 * on the computer. Resolves once they press Allow there; rejects if they press Deny, or it times out.
 */
export async function pair(base: string, name: string, onPictures: (emoji: string[]) => void, opts: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<PhonePairing> {
  const f = opts.fetch ?? fetch
  const computer = await hello(base, f)
  const keys = await makeKeyPair()
  const nonce = randomB64(16)
  const started = await json<{ pairId: string; key: string; nonce: string }>(await post(f, `${base}/pair/start`, { commit: await commitment(keys.pub, nonce), name }, opts.signal))
  if (started.key !== computer.key) throw new PhoneError('The computer changed its key while pairing. Try again.')
  await json(await post(f, `${base}/pair/reveal`, { pairId: started.pairId, key: keys.pub, nonce }, opts.signal))
  onPictures(await pairingEmoji(started.key, keys.pub, nonce, started.nonce))
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new PhoneError('Cancelled.')
    const r = await json<{ state: 'waiting' | 'allowed' | 'denied'; phoneId?: string }>(
      await f(`${base}/pair/wait?pairId=${encodeURIComponent(started.pairId)}`, opts.signal ? { signal: opts.signal } : {})
    )
    if (r.state === 'allowed' && r.phoneId) return { base, phoneId: r.phoneId, keys, computer }
    if (r.state === 'denied') throw new PhoneError(`${computer.name} said no, or the time ran out.`)
  }
  throw new PhoneError('Nobody answered on the computer.')
}

export type LinkState = 'connecting' | 'connected' | 'offline' | 'refused'

/**
 * The computer pings the stream every 20 seconds (core/phone/bridge.ts). A stream silent for longer than this is gone,
 * even when the socket never said so: after the WebView froze the page, the phone slept, or its Wi-Fi dropped for a moment.
 */
const SILENT_MS = 45_000

type Push = CorePush | PhoneRequestPush | PhoneCancelPush | PhoneViewStopPush
/** How the phone reaches the computer just now: straight over the Wi-Fi, or through the relay. */
export type LinkRoute = 'wifi' | 'relay' | 'direct'

/** How long the phone waits for the computer to answer on the Wi-Fi before it goes through the relay. */
const PROBE_MS = 1500
/** While on the relay, how often the phone looks for the computer on the Wi-Fi again (it came home). */
const HOME_CHECK_MS = 60_000
/** After a direct link fails to open, how long before the next try (the relay carries everything meanwhile). */
const DIRECT_RETRY_MS = 45_000
/** When the computer cannot make direct links at all, how long before asking again. */
const DIRECT_NO_MS = 10 * 60_000
/** A request through the relay that is not answered in this long has failed. */
const RELAY_CALL_MS = 60_000

/** A paired phone's line to the computer: sealed calls, and a stream of sealed pushes that reconnects by itself. */
export class PhoneLink {
  private key: Promise<CryptoKey>
  private nextId = 1
  private readonly f: Fetch
  private readonly silentMs: number
  private readonly probeMs: number
  private readonly homeCheckMs: number
  private reopenStream: (() => void) | null = null
  /** Sends a frame to the computer through the relay, while that is the route and the computer is there. */
  private relaySend: ((frame: RelayPhoneFrame) => void) | null = null
  private readonly relayCalls = new Map<number, { done: (f: Extract<RelayHostFrame, { t: 'rpc' }>) => void; fail: () => void; viaDirect?: boolean }>()
  private current: LinkRoute | null = null
  /** The direct link (A4c): a WebRTC data channel to the computer, opened over the relay and used instead of it while it lasts. */
  private readonly rtc: (new (config: { iceServers: IceServer[] }) => PeerLike) | null
  /** The public brokers the backup uses (A4d). Tests give their own. */
  private readonly brokers: string[]
  private directSend: ((frame: string) => Promise<void>) | null = null
  private directPeer: PeerLike | null = null
  private directChan: FrameChannel | null = null
  private directGen = 0
  private directNext = 0

  constructor(
    private pairing: PhonePairing,
    opts: { fetch?: Fetch; silentMs?: number; probeMs?: number; homeCheckMs?: number; rtc?: (new (config: { iceServers: IceServer[] }) => PeerLike) | null; brokers?: string[] } = {}
  ) {
    this.brokers = opts.brokers ?? PUBLIC_BROKERS
    this.rtc = opts.rtc !== undefined ? opts.rtc : ((globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection as (new (config: { iceServers: IceServer[] }) => PeerLike) | undefined) ?? null
    this.f = opts.fetch ?? ((...a) => fetch(...a))
    this.silentMs = opts.silentMs ?? SILENT_MS
    this.probeMs = opts.probeMs ?? PROBE_MS
    this.homeCheckMs = opts.homeCheckMs ?? HOME_CHECK_MS
    this.key = sessionKey(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
  }

  get base(): string {
    return this.pairing.base
  }

  /** The route in use while connected; null otherwise. */
  get route(): LinkRoute | null {
    return this.current
  }

  /** The computer moved to another address (found again on the network). */
  moveTo(base: string): void {
    this.pairing = { ...this.pairing, base }
  }

  /** The computer said where it is found away from home (or that it no longer is). Used from the next connection on. */
  setRelay(relay: PhoneRelayInfo | null): void {
    this.pairing = { ...this.pairing, relay }
  }

  async call<T = unknown>(method: PhoneMethod, ...params: unknown[]): Promise<T> {
    const key = await this.key
    const call: SealedCall = { id: this.nextId++, method, params, ts: Date.now(), n: randomB64(12) }
    const sealed = await seal(key, call, LABEL.request)
    const unreachable = () => new PhoneError(`Can’t reach ${this.pairing.computer.name}.`)
    let box: string
    const send = this.frameSend()
    if (send) {
      const answer = await new Promise<Extract<RelayHostFrame, { t: 'rpc' }>>((resolve, reject) => {
        const timer = setTimeout(() => this.relayCalls.get(call.id)?.fail(), RELAY_CALL_MS)
        const settle = () => {
          clearTimeout(timer)
          this.relayCalls.delete(call.id)
        }
        this.relayCalls.set(call.id, { done: (f) => (settle(), resolve(f)), fail: () => (settle(), reject(unreachable())) })
        try {
          send({ t: 'rpc', id: call.id, phone: this.pairing.phoneId, box: sealed })
        } catch {
          this.relayCalls.get(call.id)?.fail()
        }
      })
      if (answer.status !== 200 || !answer.box) throw new PhoneError(answer.error ?? `The computer answered ${answer.status}.`, answer.status)
      box = answer.box
    } else {
      let res: Response
      try {
        res = await post(this.f, `${this.pairing.base}/rpc`, { phone: this.pairing.phoneId, box: sealed })
      } catch {
        throw unreachable()
      }
      box = (await json<{ box: string }>(res)).box
    }
    const reply = await open<SealedReply>(key, box, LABEL.response)
    if (!reply.ok) throw new PhoneError(reply.error)
    return reply.result as T
  }

  /** Where a frame goes now: over the direct link when it is up, otherwise through the relay (null: neither). */
  private frameSend(): ((frame: RelayPhoneFrame) => void) | null {
    const direct = this.directSend
    if (!direct) return this.relaySend
    return (frame) => {
      const call = frame.t === 'rpc' ? this.relayCalls.get(frame.id) : undefined
      if (call) call.viaDirect = true
      direct(JSON.stringify(frame)).catch(() => call?.fail())
    }
  }

  /** Closes the direct link, if there is one. Calls waiting on it fail; the relay line, if still up, carries the next ones. */
  private closeDirect(): void {
    this.directGen++
    this.directSend = null
    const chan = this.directChan
    const pc = this.directPeer
    this.directChan = this.directPeer = null
    for (const c of [...this.relayCalls.values()]) if (c.viaDirect) c.fail()
    chan?.close()
    try {
      pc?.close()
    } catch {
      // Closed already.
    }
  }

  /**
   * Opens a WebRTC data channel to the computer: makes the offer, gives it to `exchange` (which gets it to the computer and
   * brings the answer back), waits for the channel, and proves itself with `listen` the way the relay line does. Resolves
   * once the computer has admitted it. `lost` is called if the link ends afterwards. Throws when it does not work.
   */
  private async dial(
    Rtc: new (config: { iceServers: IceServer[] }) => PeerLike,
    servers: IceServer[],
    key: CryptoKey,
    exchange: (sdp: string) => Promise<string>,
    onPush: (push: Push) => void,
    lost: () => void,
    stale: () => boolean
  ): Promise<FrameChannel> {
    const pc = new Rtc({ iceServers: servers })
    this.directPeer = pc
    const dc = pc.createDataChannel(DIRECT_CHANNEL)
    const opened = new Promise<void>((resolve, reject) => {
      dc.onopen = () => resolve()
      setTimeout(() => reject(new Error('The direct link did not open')), 20_000)
    })
    opened.catch(() => undefined)
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc, 5000)
    const sdp = pc.localDescription?.sdp
    if (!sdp || stale()) throw new Error('No offer')
    await pc.setRemoteDescription({ type: 'answer', sdp: await exchange(sdp) })
    await opened
    if (stale()) throw new Error('Superseded')
    let pushes: Promise<void> = Promise.resolve()
    const onLost = () => {
      if (this.directPeer === pc) lost()
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) onLost()
    }
    let admitted: (ok: boolean) => void = () => undefined
    const admission = new Promise<boolean>((resolve) => (admitted = resolve))
    const chan = new FrameChannel(
      dc,
      (text) => {
        let f: RelayHostFrame
        try {
          f = JSON.parse(text) as RelayHostFrame
        } catch {
          return
        }
        if (f.t === 'rpc') this.relayCalls.get(f.id)?.done(f)
        else if (f.t === 'listen') admitted(f.ok)
        else if (f.t === 'push') {
          const box = f.box
          pushes = pushes.then(async () => onPush(await open<Push>(key, box, LABEL.push))).catch(() => undefined)
        }
      },
      onLost
    )
    this.directChan = chan
    const auth = await seal(key, { ts: Date.now(), n: randomB64(12) }, LABEL.listen)
    await chan.send(JSON.stringify({ t: 'listen', phone: this.pairing.phoneId, auth } satisfies RelayPhoneFrame))
    const ok = await Promise.race([admission, new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))])
    if (!ok || stale()) throw new Error('The computer did not admit the direct link')
    return chan
  }

  /**
   * Opens a direct link to the computer while the relay carries the phone (A4c). Two sealed calls over the relay trade the
   * descriptions; then the channel takes over. Any failure leaves the relay as it was and tries again later.
   */
  private async openDirect(key: CryptoKey, onPush: (push: Push) => void, reopen: () => void, connected: (route: LinkRoute) => void): Promise<void> {
    const Rtc = this.rtc
    if (!Rtc || this.directPeer || Date.now() < this.directNext) return
    const gen = ++this.directGen
    const stale = () => gen !== this.directGen
    try {
      const info = await this.call<PhoneLinkInfo>('phone.linkInfo')
      if (stale()) return
      if (!info.servers) {
        this.directNext = Date.now() + DIRECT_NO_MS
        return
      }
      const chan = await this.dial(
        Rtc,
        info.servers,
        key,
        async (sdp) => (await this.call<PhoneLinkAnswer>('phone.link', { sdp } satisfies PhoneLinkOffer)).sdp,
        onPush,
        () => {
          // The link ended on its own (the phone moved networks, the computer went): back to the relay, and catch up.
          this.closeDirect()
          this.current = this.relaySend ? 'relay' : null
          reopen()
        },
        stale
      )
      this.directSend = (frame) => chan.send(frame)
      this.current = 'direct'
      connected('direct')
    } catch {
      // A newer attempt, or the relay going away, owns the peer now and has closed it; otherwise this one failed.
      if (!stale()) {
        this.closeDirect()
        this.directNext = Date.now() + DIRECT_RETRY_MS
      }
    }
  }

  /**
   * The backup (A4d): the relay cannot be reached, so the offer goes to the computer through public MQTT brokers, sealed
   * with the pairing key, and the answer comes back the same way. The link that opens is the same direct link; it is the
   * only line there is, so this resolves (false) when it ends, like a stream. Throws when no link could be opened.
   */
  private async publicStream(key: CryptoKey, ctl: AbortController, onPush: (push: Push) => void, connected: (route: LinkRoute) => void): Promise<boolean> {
    const Rtc = this.rtc
    if (!Rtc) throw new Error('No WebRTC here')
    const topic = await signalTopic(await sessionKeyBytes(this.pairing.keys.priv, this.pairing.computer.key, this.pairing.computer.key, this.pairing.keys.pub))
    const gen = ++this.directGen
    const stale = () => gen !== this.directGen || ctl.signal.aborted
    const waiting = new Map<string, (sdp: string) => void>()
    const signal = new SignalChannel(this.brokers, topic, (text) => {
      void open<SignalMessage>(key, text, LABEL.signal).then(
        (m) => m.from === 'host' && m.t === 'answer' && typeof m.sdp === 'string' && waiting.get(m.id)?.(m.sdp),
        () => undefined
      )
    })
    signal.start()
    // An offer is sent again every few seconds (a broker may drop a message, the computer may only now be listening).
    const exchange = (sdp: string) =>
      new Promise<string>((resolve, reject) => {
        const id = randomB64(9).replace(/[^a-z0-9]/gi, '')
        const send = async () => signal.send(await seal(key, { from: 'phone', t: 'offer', id, sdp, ts: Date.now(), n: randomB64(12) } satisfies SignalMessage, LABEL.signal))
        const done = () => {
          clearInterval(tick)
          clearTimeout(timer)
          waiting.delete(id)
        }
        const timer = setTimeout(() => (done(), reject(new Error('Nobody answered'))), 25_000)
        const tick = setInterval(() => void send().catch(() => undefined), 3000)
        waiting.set(id, (answer) => (done(), resolve(answer)))
        void send().catch(() => undefined)
      })
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const end = () => {
          ctl.signal.removeEventListener('abort', end)
          this.closeDirect()
          this.current = null
          resolve(false)
        }
        ctl.signal.addEventListener('abort', end)
        this.dial(Rtc, PUBLIC_ICE, key, exchange, onPush, end, stale).then(
          (chan) => {
            if (stale()) return end()
            this.directSend = (frame) => chan.send(frame)
            this.current = 'direct'
            connected('direct')
          },
          (e: unknown) => {
            ctl.signal.removeEventListener('abort', end)
            this.closeDirect()
            reject(e instanceof Error ? e : new Error('The direct link failed'))
          }
        )
      })
    } finally {
      signal.stop()
    }
  }

  /** True when the paired computer answers on the Wi-Fi within the probe time. */
  private async atHome(): Promise<boolean> {
    try {
      return (await hello(this.pairing.base, this.f, this.probeMs)).key === this.pairing.computer.key
    } catch {
      return false
    }
  }

  /**
   * Listens for pushes until the returned function is called. Reconnects after a drop, slower each time, up to 15 s.
   * A stream that goes quiet past the computer's pings, or that `reopen` drops, is opened again at once without going
   * `offline`. Every new stream says `connected` again, so the caller can catch up on what it missed.
   *
   * With a relay known, each connection first asks whether the computer answers on the Wi-Fi; when it does not, the
   * stream goes through the relay, and moves back to the Wi-Fi by itself once the computer answers there again.
   */
  listen(onPush: (push: Push) => void, onState: (state: LinkState) => void): () => void {
    let stopped = false
    let controller: AbortController | null = null
    let delay = 1000
    let live = false
    let again = false
    const reopen = () => {
      if (!live) return
      again = true
      controller?.abort()
    }
    this.reopenStream = reopen
    const run = async () => {
      while (!stopped) {
        const quiet = again
        again = false
        if (!quiet) onState('connecting')
        const ctl = new AbortController()
        controller = ctl
        const connected = (route: LinkRoute) => {
          live = true
          this.current = route
          delay = 1000
          onState('connected')
        }
        let refused = false
        let viaRelay = false
        try {
          const key = await this.key
          const relay = this.pairing.relay
          if (relay && !(await this.atHome())) {
            viaRelay = true
            refused = await this.relayStream(relay, key, ctl, onPush, connected, () => onState('offline'), reopen)
          } else refused = await this.wifiStream(key, ctl, onPush, connected, reopen)
        } catch {
          // Dropped, gone quiet, or the computer is not there: try again shortly. When it was the relay that could not be
          // reached, the backup opens a direct link through public brokers instead (A4d).
          if (viaRelay && !stopped && !ctl.signal.aborted && this.rtc && this.brokers.length) {
            try {
              refused = await this.publicStream(await this.key, ctl, onPush, connected)
            } catch {
              // No one answered there either.
            }
          }
        } finally {
          live = false
          this.current = null
        }
        if (refused) {
          onState('refused')
          return
        }
        if (stopped) return
        if (again) continue
        onState('offline')
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 15_000)
      }
    }
    void run()
    return () => {
      stopped = true
      if (this.reopenStream === reopen) this.reopenStream = null
      controller?.abort()
    }
  }

  /** The stream on the Wi-Fi, until it ends. True when the computer refused this phone. */
  private async wifiStream(key: CryptoKey, ctl: AbortController, onPush: (push: Push) => void, connected: (route: LinkRoute) => void, reopen: () => void): Promise<boolean> {
    let watch: ReturnType<typeof setInterval> | null = null
    try {
      const auth = await seal(key, { ts: Date.now(), n: randomB64(12) }, LABEL.listen)
      const res = await this.f(`${this.pairing.base}/events?phone=${encodeURIComponent(this.pairing.phoneId)}&auth=${encodeURIComponent(auth)}`, { signal: ctl.signal })
      if (res.status === 401) return true
      if (!res.ok || !res.body) throw new Error(String(res.status))
      connected('wifi')
      // Checked often rather than one long timer: a WebView in the background runs timers late, and on its return the
      // first check finds the silence at once.
      let heard = Date.now()
      watch = setInterval(() => Date.now() - heard > this.silentMs && reopen(), Math.min(5000, this.silentMs / 3))
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        heard = Date.now()
        buf += decoder.decode(value, { stream: true })
        let cut: number
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('')
          if (!data) continue
          try {
            onPush(await open<Push>(key, data, LABEL.push))
          } catch {
            // A push that does not open is dropped, never shown.
          }
        }
      }
      return false
    } finally {
      if (watch) clearInterval(watch)
    }
  }

  /**
   * The stream through the relay, until its socket ends. True when the computer refused this phone. While the computer
   * itself is away from the relay the socket stays open and the link says `offline`; it listens again when it returns.
   */
  private relayStream(
    relay: PhoneRelayInfo,
    key: CryptoKey,
    ctl: AbortController,
    onPush: (push: Push) => void,
    connected: (route: LinkRoute) => void,
    hostAway: () => void,
    reopen: () => void
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(relaySocketUrl(relay.url, relay.room), [RELAY_PHONE_PROTOCOL])
      let heard = Date.now()
      let refused = false
      let listening = false
      let pushes: Promise<void> = Promise.resolve()
      const send = (frame: RelayPhoneFrame) => ws.send(JSON.stringify(frame))
      const askToListen = async () => send({ t: 'listen', phone: this.pairing.phoneId, auth: await seal(key, { ts: Date.now(), n: randomB64(12) }, LABEL.listen) })
      const away = () => {
        this.closeDirect()
        this.relaySend = null
        for (const c of [...this.relayCalls.values()]) c.fail()
      }
      // The relay answers "ping" itself, so a quiet socket is a dead one whatever the computer is doing.
      const watch = setInterval(
        () => {
          if (Date.now() - heard > this.silentMs) return reopen(), end()
          if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        },
        Math.min(15_000, this.silentMs / 3)
      )
      // Back on the Wi-Fi with the computer: leave the relay for it.
      const home = setInterval(() => void this.atHome().then((yes) => yes && listening && reopen()), this.homeCheckMs)
      let ended = false
      // Ends the stream now. It does not wait for the socket to finish closing: a line that has gone may never say so.
      const end = () => {
        if (ended) return
        ended = true
        clearInterval(watch)
        clearInterval(home)
        ctl.signal.removeEventListener('abort', end)
        away()
        ws.onmessage = null
        try {
          ws.close()
        } catch {
          // Not open yet, or closed already.
        }
        if (refused) resolve(true)
        else if (listening) resolve(false)
        else reject(new Error('The relay line closed'))
      }
      ctl.signal.addEventListener('abort', end)
      ws.onmessage = (e) => {
        heard = Date.now()
        const text = typeof e.data === 'string' ? e.data : ''
        if (text === 'pong' || !text) return
        if (text === '!host 1') return void askToListen().catch(() => end())
        if (text === '!host 0') {
          away()
          hostAway()
          listening = false
          return
        }
        let f: RelayHostFrame
        try {
          f = JSON.parse(text) as RelayHostFrame
        } catch {
          return
        }
        if (f.t === 'rpc') this.relayCalls.get(f.id)?.done(f)
        else if (f.t === 'listen') {
          if (!f.ok) {
            refused = true
            return end()
          }
          listening = true
          this.relaySend = send
          connected('relay')
          void this.openDirect(key, onPush, reopen, connected)
        } else if (f.t === 'push') {
          const box = f.box
          // In order, as they were sent.
          pushes = pushes.then(async () => onPush(await open<Push>(key, box, LABEL.push))).catch(() => undefined)
        }
      }
      ws.onerror = () => undefined
      ws.onclose = () => end()
    })
  }

  /**
   * Drops the stream and opens a new one at once, for when the app comes back to the screen. Android's WebView freezes a
   * page about a minute after it is hidden, and a stream that was open across the freeze never delivers again: no error,
   * no end, and the socket stays open, so neither side can tell.
   */
  reopen(): void {
    this.reopenStream?.()
  }
}
