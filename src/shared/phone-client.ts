// The phone's side of the phone protocol (src/shared/phone.ts). Used by the Android app, and by tests as a stand-in phone.
// Only fetch and WebCrypto, so it runs the same in a WebView and in Node. The live stream is read from fetch's body
// rather than EventSource, which Node does not have and which cannot be told to stop retrying a refused phone.

import type { CorePush } from './api'
import {
  LABEL,
  commitment,
  makeKeyPair,
  open,
  pairingEmoji,
  randomB64,
  seal,
  sessionKey,
  type PhoneHello,
  type PhoneMethod,
  type PhoneCancelPush,
  type PhoneRequestPush,
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

/** A paired phone's line to the computer: sealed calls, and a stream of sealed pushes that reconnects by itself. */
export class PhoneLink {
  private key: Promise<CryptoKey>
  private nextId = 1
  private readonly f: Fetch

  constructor(
    private pairing: PhonePairing,
    opts: { fetch?: Fetch } = {}
  ) {
    this.f = opts.fetch ?? ((...a) => fetch(...a))
    this.key = sessionKey(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
  }

  get base(): string {
    return this.pairing.base
  }

  /** The computer moved to another address (found again on the network). */
  moveTo(base: string): void {
    this.pairing = { ...this.pairing, base }
  }

  async call<T = unknown>(method: PhoneMethod, ...params: unknown[]): Promise<T> {
    const key = await this.key
    const call: SealedCall = { id: this.nextId++, method, params, ts: Date.now(), n: randomB64(12) }
    let res: Response
    try {
      res = await post(this.f, `${this.pairing.base}/rpc`, { phone: this.pairing.phoneId, box: await seal(key, call, LABEL.request) })
    } catch {
      throw new PhoneError(`Can’t reach ${this.pairing.computer.name}.`)
    }
    const { box } = await json<{ box: string }>(res)
    const reply = await open<SealedReply>(key, box, LABEL.response)
    if (!reply.ok) throw new PhoneError(reply.error)
    return reply.result as T
  }

  /** Listens for pushes until the returned function is called. Reconnects after a drop, slower each time, up to 15 s. */
  listen(onPush: (push: CorePush | PhoneRequestPush | PhoneCancelPush) => void, onState: (state: LinkState) => void): () => void {
    let stopped = false
    let controller: AbortController | null = null
    let delay = 1000
    const run = async () => {
      while (!stopped) {
        onState('connecting')
        controller = new AbortController()
        try {
          const key = await this.key
          const auth = await seal(key, { ts: Date.now(), n: randomB64(12) }, LABEL.listen)
          const res = await this.f(`${this.pairing.base}/events?phone=${encodeURIComponent(this.pairing.phoneId)}&auth=${encodeURIComponent(auth)}`, { signal: controller.signal })
          if (res.status === 401) {
            onState('refused')
            return
          }
          if (!res.ok || !res.body) throw new Error(String(res.status))
          onState('connected')
          delay = 1000
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
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
                onPush(await open<CorePush | PhoneRequestPush | PhoneCancelPush>(key, data, LABEL.push))
              } catch {
                // A push that does not open is dropped, never shown.
              }
            }
          }
        } catch {
          // Dropped, or the computer is not there: try again shortly.
        }
        if (stopped) return
        onState('offline')
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 15_000)
      }
    }
    void run()
    return () => {
      stopped = true
      controller?.abort()
    }
  }
}
