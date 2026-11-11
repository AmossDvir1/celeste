// The direct link between a phone and its computer (docs/PHONE_PLAN.md 7.1, A4c): one WebRTC data channel that carries the
// same frames as the relay's socket (RelayPhoneFrame and RelayHostFrame in phone.ts), so everything above it is unchanged
// and every frame is still sealed with the pairing key. A data channel takes only small messages, so a frame is cut into
// pieces here and put together again on the other side.

/** The channel's name. The phone creates it; the computer answers only this one. */
export const DIRECT_CHANNEL = 'celeste'
/** Characters in one piece: a piece stays well under the 64 KB every WebRTC stack accepts, whatever the characters are. */
export const DIRECT_PIECE = 12_000
/** The largest frame put together (the sealed upload parts are the biggest, about 1.4 MB). */
export const DIRECT_MAX_FRAME = 4_000_000
/** How long a half-received frame is kept. */
const STALE_MS = 30_000

let counter = 0

/** A frame as pieces, each `<id>.<n>.<more>:<text>`: `more` is 1 until the last. */
export function pieces(frame: string): string[] {
  const id = (counter++ % 46656).toString(36)
  const count = Math.max(1, Math.ceil(frame.length / DIRECT_PIECE))
  return Array.from({ length: count }, (_, n) => `${id}.${n}.${n < count - 1 ? 1 : 0}:${frame.slice(n * DIRECT_PIECE, (n + 1) * DIRECT_PIECE)}`)
}

/** The part of an RTCDataChannel used here, so the same code runs in the phone's WebView and in Node (node-datachannel's polyfill). */
export interface ChannelLike {
  readyState: string
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  send(data: string): void
  close(): void
  onmessage: ((e: { data: unknown }) => void) | null
  onbufferedamountlow: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

/** The part of the standard RTCPeerConnection used here (both the browser's and node-datachannel's polyfill fit it). */
export interface PeerLike {
  connectionState: string
  iceGatheringState: string
  localDescription: { sdp?: string } | null
  onconnectionstatechange: (() => void) | null
  onicegatheringstatechange: (() => void) | null
  ondatachannel: ((e: { channel: ChannelLike & { label: string; onopen: (() => void) | null } }) => void) | null
  createDataChannel(label: string): ChannelLike & { onopen: (() => void) | null }
  createOffer(): Promise<{ type: string; sdp?: string }>
  createAnswer(): Promise<{ type: string; sdp?: string }>
  setLocalDescription(d: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(d: { type: string; sdp: string }): Promise<void>
  close(): void
}

/** Resolves when the peer has gathered its addresses (no trickling: the description sent carries them all), or after `ms`. */
export const gathered = (pc: PeerLike, ms: number) =>
  new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const t = setTimeout(resolve, ms)
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t)
        resolve()
      }
    }
  })

/** More than this waiting to go out, and sending waits: a big upload must not pile up in memory. */
const HIGH_WATER = 1_000_000

/** Whole frames over a data channel: cut into pieces going out, put together coming in, with sending that waits when the channel is full. */
export class FrameChannel {
  private readonly re = new Reassembler()
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly dc: ChannelLike,
    onFrame: (frame: string) => void,
    onClosed: () => void
  ) {
    dc.bufferedAmountLowThreshold = HIGH_WATER / 2
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      const whole = this.re.add(e.data)
      if (whole !== null) onFrame(whole)
    }
    const gone = () => {
      if (this.closed) return
      this.closed = true
      onClosed()
    }
    dc.onclose = gone
    dc.onerror = gone
  }

  get open(): boolean {
    return !this.closed && this.dc.readyState === 'open'
  }

  /** Sends one frame; frames go out in the order they were given. Rejects when the channel is gone. */
  send(frame: string): Promise<void> {
    const run = async () => {
      for (const piece of pieces(frame)) {
        if (!this.open) throw new Error('The direct link closed')
        while (this.dc.bufferedAmount > HIGH_WATER) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 200)
            this.dc.onbufferedamountlow = () => (clearTimeout(t), resolve())
          })
          if (!this.open) throw new Error('The direct link closed')
        }
        this.dc.send(piece)
      }
    }
    const next = this.tail.then(run)
    this.tail = next.catch(() => undefined)
    return next
  }

  close(): void {
    this.closed = true
    try {
      this.dc.close()
    } catch {
      // Closed already.
    }
  }
}

/** Puts the pieces of each frame together, in the order they arrive (a data channel keeps order). */
export class Reassembler {
  private readonly open = new Map<string, { parts: string[]; size: number; at: number }>()

  /** The whole frame when this piece completes one; null otherwise. A piece that does not fit the rules is dropped. */
  add(piece: string, now = Date.now()): string | null {
    const cut = piece.indexOf(':')
    if (cut < 3 || cut > 16) return null
    const [id, n, more] = piece.slice(0, cut).split('.')
    if (!id || n === undefined || (more !== '0' && more !== '1')) return null
    const seq = Number(n)
    if (!Number.isInteger(seq) || seq < 0) return null
    for (const [k, v] of this.open) if (now - v.at > STALE_MS) this.open.delete(k)
    let cur = this.open.get(id)
    if (seq === 0) this.open.set(id, (cur = { parts: [], size: 0, at: now }))
    if (!cur || cur.parts.length !== seq) return this.discard(id)
    const text = piece.slice(cut + 1)
    cur.size += text.length
    if (cur.size > DIRECT_MAX_FRAME || this.open.size > 32) return this.discard(id)
    cur.parts.push(text)
    if (more === '1') return null
    this.open.delete(id)
    return cur.parts.join('')
  }

  private discard(id: string): null {
    this.open.delete(id)
    return null
  }
}
