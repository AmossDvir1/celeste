// The computer's end of the direct link (docs/PHONE_PLAN.md 7.1, A4c): a WebRTC data channel from a phone, opened with the
// phone's offer (which arrives as a sealed call, over the Wi-Fi or the relay) and answered here. Once open it carries the same
// frames as the relay's socket, so the bridge treats each channel like one more connection; the frames inside are sealed with
// the pairing key and checked exactly as on the Wi-Fi. The library is loaded only when a phone asks, and when it cannot be
// (no prebuilt file for this system) the answer is "no" and the phone stays on the relay.

import { randomBytes } from 'node:crypto'
import { DIRECT_CHANNEL, FrameChannel, gathered, type PeerLike } from '@shared/direct'
import type { IceServer } from '@shared/phone'

export interface DirectDeps {
  /** A frame a phone sent over its channel. */
  onFrame: (conn: string, text: string) => void
  /** A channel ended (the phone went away, or the link failed). */
  onGone: (conn: string) => void
  /** The servers to gather candidates with (STUN, and TURN when the relay has it). */
  iceServers: () => Promise<IceServer[] | null>
}

interface Line {
  phoneId: string
  pc: PeerLike
  chan: FrameChannel | null
}

const MAX_LINES = 8
const OPEN_MS = 20_000
const GATHER_MS = 6_000
const MAX_SDP = 40_000

interface Lib {
  RTCPeerConnection: new (config: { iceServers: IceServer[] }) => PeerLike
}

export class DirectLines {
  private readonly lines = new Map<string, Line>()
  private lib: Promise<Lib | null> | null = null

  constructor(private readonly deps: DirectDeps) {}

  private load(): Promise<Lib | null> {
    return (this.lib ??= import('node-datachannel/polyfill').then(
      (m) => m as unknown as Lib,
      () => null
    ))
  }

  /** The servers a phone should gather with, or null when a direct link cannot be made here. */
  async info(): Promise<IceServer[] | null> {
    if (!(await this.load())) return null
    return (await this.deps.iceServers()) ?? []
  }

  /**
   * Answers a phone's offer. The reply is the answer to give back, or null when this computer cannot. The channel is
   * announced to the bridge (`onFrame`) only once it opens, and closed again if it does not within a while.
   */
  async accept(phoneId: string, offer: string): Promise<string | null> {
    const lib = await this.load()
    if (!lib || offer.length > MAX_SDP) return null
    // One channel per phone: a new offer replaces the old.
    for (const [conn, l] of [...this.lines]) if (l.phoneId === phoneId) this.drop(conn)
    if (this.lines.size >= MAX_LINES) return null
    const servers = (await this.deps.iceServers()) ?? []
    const conn = `d${randomBytes(6).toString('hex').slice(0, 11)}`
    const pc = new lib.RTCPeerConnection({ iceServers: servers })
    const line: Line = { phoneId, pc, chan: null }
    this.lines.set(conn, line)
    const timer = setTimeout(() => this.lines.get(conn)?.chan || this.drop(conn), OPEN_MS)
    timer.unref?.()
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.drop(conn)
    }
    pc.ondatachannel = (e) => {
      const dc = e.channel
      if (dc.label !== DIRECT_CHANNEL || line.chan) return dc.close()
      const open = () => {
        clearTimeout(timer)
        line.chan = new FrameChannel(dc, (frame) => this.deps.onFrame(conn, frame), () => this.drop(conn))
      }
      if (dc.readyState === 'open') open()
      else dc.onopen = open
    }
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer })
      await pc.setLocalDescription(await pc.createAnswer())
      await gathered(pc, GATHER_MS)
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('No answer')
      return sdp
    } catch {
      this.drop(conn)
      return null
    }
  }

  /** True while this channel is open. */
  isOpen(conn: string): boolean {
    return !!this.lines.get(conn)?.chan?.open
  }

  /** Whether `conn` is one of these channels, as opposed to one of the relay's connections. */
  owns(conn: string): boolean {
    return this.lines.has(conn)
  }

  send(conn: string, text: string): void {
    void this.lines.get(conn)?.chan?.send(text).catch(() => this.drop(conn))
  }

  close(conn: string): void {
    this.drop(conn)
  }

  closeAll(): void {
    for (const conn of [...this.lines.keys()]) this.drop(conn)
  }

  private drop(conn: string): void {
    const l = this.lines.get(conn)
    if (!l) return
    this.lines.delete(conn)
    l.chan?.close()
    try {
      l.pc.close()
    } catch {
      // Closed already.
    }
    this.deps.onGone(conn)
  }
}
