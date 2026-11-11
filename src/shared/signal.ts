// The backup way to open a direct link when the project's relay cannot be reached (docs/PHONE_PLAN.md 7.2, step A4d): the
// phone and the computer trade their WebRTC descriptions through public MQTT brokers (free, run by others), on a topic only
// the two of them can work out, with every message sealed with their pairing key. A broker sees a topic name that means
// nothing, some bytes it cannot open, and two IP addresses. There is no push (nobody can wake a closed app this way), so
// it serves only while the app is open, and only to open a link: the link itself is the same one the relay helps to open.
//
// MQTT is spoken here by a small client of our own (CONNECT, SUBSCRIBE, PUBLISH, PING: nothing else), so the phone's
// WebView and Node run the same code and nothing has to be added to either.

/** Public brokers that speak MQTT over a secure WebSocket. A message goes to all of them, so one being down costs nothing. */
export const PUBLIC_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081']
/** Public STUN servers for the backup link (no TURN: there is no relay to hand out credentials). */
export const PUBLIC_ICE = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['stun:stun.l.google.com:19302'] }]

/** What the two ends trade over the brokers, sealed with the pairing key: the phone's offer and the computer's answer. */
export interface SignalMessage {
  from: 'phone' | 'host'
  t: 'offer' | 'answer'
  /** Ties an answer to its offer; an offer is sent again until it is answered, with the same id. */
  id: string
  sdp: string
  ts: number
  n: string
}

const KEEP_ALIVE_S = 30
const utf8 = new TextEncoder()
const text8 = new TextDecoder()

const str = (s: string) => {
  const b = utf8.encode(s)
  return [b.length >> 8, b.length & 255, ...b]
}
const varint = (n: number) => {
  const out: number[] = []
  do {
    let d = n % 128
    n = Math.floor(n / 128)
    if (n > 0) d |= 128
    out.push(d)
  } while (n > 0)
  return out
}
const packet = (type: number, body: number[] | Uint8Array) => Uint8Array.from([type, ...varint(body.length), ...body])

/** One connection to one broker: subscribes to one topic and publishes text on it. */
export class MqttLine {
  private ws: WebSocket | null = null
  private buf = new Uint8Array(0)
  private ping: ReturnType<typeof setInterval> | null = null
  private ready = false
  /** True once the broker accepted the subscription. */
  get subscribed(): boolean {
    return this.ready
  }

  constructor(
    private readonly url: string,
    private readonly topic: string,
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void
  ) {}

  start(): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, ['mqtt'])
    } catch {
      return this.onClose()
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      const id = `celeste-${Math.random().toString(36).slice(2, 12)}`
      ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, 0, KEEP_ALIVE_S, ...str(id)]))
    }
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return
      const more = new Uint8Array(e.data)
      const joined = new Uint8Array(this.buf.length + more.length)
      joined.set(this.buf)
      joined.set(more, this.buf.length)
      this.buf = joined
      this.read(ws)
    }
    ws.onerror = () => undefined
    ws.onclose = () => {
      this.stopPing()
      if (this.ws === ws) this.ws = null
      this.ready = false
      this.onClose()
    }
  }

  private read(ws: WebSocket): void {
    for (;;) {
      if (this.buf.length < 2) return
      let len = 0
      let mult = 1
      let i = 1
      for (;;) {
        if (i >= this.buf.length) return
        const d = this.buf[i++] as number
        len += (d & 127) * mult
        if (!(d & 128)) break
        mult *= 128
        if (mult > 128 ** 3) return void ws.close()
      }
      if (this.buf.length < i + len) return
      const type = (this.buf[0] as number) >> 4
      const body = this.buf.slice(i, i + len)
      this.buf = this.buf.slice(i + len)
      if (type === 2) {
        // CONNACK: accepted when the return code is 0.
        if (body[1] !== 0) return void ws.close()
        ws.send(packet(0x82, [0, 1, ...str(this.topic), 0]))
        this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(packet(0xc0, [])), (KEEP_ALIVE_S * 1000) / 2)
      } else if (type === 9) this.ready = true
      else if (type === 3) {
        const tl = ((body[0] as number) << 8) | (body[1] as number)
        // QoS 0 only is asked for, so there is no packet id before the payload.
        this.onText(text8.decode(body.slice(2 + tl)))
      }
    }
  }

  publish(text: string): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(packet(0x30, [...str(this.topic), ...utf8.encode(text)]))
  }

  private stopPing(): void {
    if (this.ping) clearInterval(this.ping)
    this.ping = null
  }

  stop(): void {
    this.stopPing()
    const ws = this.ws
    this.ws = null
    this.ready = false
    if (!ws) return
    ws.onclose = null
    try {
      ws.close()
    } catch {
      // Closed already.
    }
  }
}

/** The topic for a pairing: 32 hex characters worked out from the pairing key, which only the phone and the computer have. */
export async function signalTopic(keyBytes: Uint8Array): Promise<string> {
  const input = new Uint8Array([...utf8.encode('celeste-signal-topic'), ...keyBytes])
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input))
  return `celeste/${Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** Several brokers at once on one topic: what is sent goes to every one connected, and what arrives twice is heard once. */
export class SignalChannel {
  private readonly lines = new Map<string, MqttLine>()
  private readonly heard: string[] = []
  private retry = new Map<string, ReturnType<typeof setTimeout>>()
  private stopped = true

  constructor(
    private readonly brokers: string[],
    private readonly topic: string,
    private readonly onMessage: (text: string) => void
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.brokers.forEach((b) => this.connect(b, 1000))
  }

  private connect(url: string, delay: number): void {
    if (this.stopped) return
    const line = new MqttLine(
      url,
      this.topic,
      (t) => {
        if (this.heard.includes(t)) return
        this.heard.push(t)
        if (this.heard.length > 200) this.heard.shift()
        this.onMessage(t)
      },
      () => {
        if (this.lines.get(url) === line) this.lines.delete(url)
        if (this.stopped) return
        this.retry.set(url, setTimeout(() => this.connect(url, Math.min(delay * 2, 60_000)), delay))
      }
    )
    this.lines.set(url, line)
    line.start()
  }

  /** How many brokers have accepted the subscription (messages sent now will reach the other side's brokers that are also up). */
  get connected(): number {
    return [...this.lines.values()].filter((l) => l.subscribed).length
  }

  send(text: string): void {
    for (const l of this.lines.values()) l.publish(text)
  }

  stop(): void {
    this.stopped = true
    for (const t of this.retry.values()) clearTimeout(t)
    this.retry.clear()
    for (const l of this.lines.values()) l.stop()
    this.lines.clear()
  }
}
