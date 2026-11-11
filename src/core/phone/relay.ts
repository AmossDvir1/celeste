// The computer's line to the relay (docs/PHONE_PLAN.md 7.1, relay/README.md): one WebSocket, opened outward, that
// phones away from home reach this computer through. It carries the same sealed requests and pushes as the Wi-Fi; the
// bridge checks every one exactly as it does there. This file only keeps the line up and splits what arrives by phone.

import WebSocket from 'ws'
import { RELAY_HOST_PROTOCOL, relaySocketUrl, type IceServer } from '@shared/phone'

export type RelayState = 'off' | 'connecting' | 'connected'

export interface RelayLineDeps {
  /** Something a phone's connection sent. */
  onFrame: (conn: string, text: string) => void
  /** A phone's connection closed, or the whole line dropped (`conn` null): its listeners go. */
  onGone: (conn: string | null) => void
  onState: (state: RelayState) => void
  /** How a wake went: `ok`, or why it did not (the relay's code: UNREGISTERED means the phone's token is dead). */
  onWake?: (id: string, result: { ok: boolean; code?: string }) => void
  /** How often to ask the relay whether the line is still there. Tests use a short one. */
  pingMs?: number
}

const PING_MS = 30_000
const CONN = 12

export class RelayLine {
  private ws: WebSocket | null = null
  private target: { url: string; room: string; secret: string } | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  private delay = 1000
  private heard = 0
  state: RelayState = 'off'

  constructor(private readonly deps: RelayLineDeps) {}

  private set(state: RelayState): void {
    if (this.state === state) return
    this.state = state
    this.deps.onState(state)
  }

  /** Keeps a line open to this room, or (null) closes it. Asking again for the same room changes nothing. */
  use(target: { url: string; room: string; secret: string } | null): void {
    const t = this.target
    if (t?.url === target?.url && t?.room === target?.room && t?.secret === target?.secret) return
    this.target = target
    this.drop()
    this.delay = 1000
    if (target) this.open()
    else this.set('off')
  }

  private drop(): void {
    if (this.retry) clearTimeout(this.retry)
    if (this.ping) clearInterval(this.ping)
    this.retry = this.ping = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.removeAllListeners()
      ws.on('error', () => undefined)
      ws.terminate()
      this.deps.onGone(null)
    }
  }

  private open(): void {
    const t = this.target
    if (!t) return
    this.set('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(relaySocketUrl(t.url, t.room), [RELAY_HOST_PROTOCOL, t.secret], { handshakeTimeout: 15_000, maxPayload: 8_000_000 })
    } catch {
      return this.again()
    }
    this.ws = ws
    ws.on('open', () => {
      this.delay = 1000
      this.heard = Date.now()
      this.set('connected')
      const every = this.deps.pingMs ?? PING_MS
      this.ping = setInterval(() => {
        // Two pings with no answer: the line is gone though the socket never said so (sleep, a changed network).
        if (Date.now() - this.heard > every * 2.5) return this.lost()
        if (ws.readyState === WebSocket.OPEN) ws.send('ping')
      }, every)
      this.ping.unref?.()
    })
    ws.on('message', (data, binary) => {
      this.heard = Date.now()
      if (binary) return
      const text = data.toString()
      if (text.startsWith('!wake ')) {
        try {
          const r = JSON.parse(text.slice(6)) as { id?: unknown; ok?: unknown; code?: unknown }
          if (typeof r.id === 'string') this.deps.onWake?.(r.id, { ok: r.ok === true, ...(typeof r.code === 'string' ? { code: r.code } : {}) })
        } catch {
          // Not an answer.
        }
        return
      }
      if (text.startsWith('!turn ')) {
        try {
          const r = JSON.parse(text.slice(6)) as { id?: unknown; ok?: unknown; servers?: unknown }
          const waiting = typeof r.id === 'string' ? this.turns.get(r.id) : undefined
          if (waiting) waiting(r.ok === true && Array.isArray(r.servers) ? (r.servers as IceServer[]) : null)
        } catch {
          // Not an answer.
        }
        return
      }
      if (text === 'pong' || text[CONN] !== ' ') return
      const conn = text.slice(0, CONN)
      const rest = text.slice(CONN + 1)
      if (rest === '-') this.deps.onGone(conn)
      else this.deps.onFrame(conn, rest)
    })
    ws.on('error', () => undefined)
    // 403: the room is another computer's. It can't become ours by trying again quickly.
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 403) this.delay = 600_000
      res.resume()
      this.lost()
    })
    ws.on('close', () => this.lost())
  }

  private lost(): void {
    if (!this.ws) return
    this.drop()
    this.again()
  }

  private again(): void {
    if (!this.target) return
    this.set('connecting')
    this.retry = setTimeout(() => this.open(), this.delay)
    this.retry.unref?.()
    this.delay = Math.min(this.delay * 2, 60_000)
  }

  send(conn: string, text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(`${conn} ${text}`)
  }

  /** Asks the relay to wake a phone through Firebase with this sealed box. False when the line is not up. */
  wake(w: { id: string; token: string; box: string; ttl: number }): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(`!wake ${JSON.stringify(w)}`)
    return true
  }

  private readonly turns = new Map<string, (servers: IceServer[] | null) => void>()
  private cached: { servers: IceServer[]; until: number } | null = null

  /**
   * The addresses for the direct link (STUN, and TURN when the relay has it), kept for most of their life. Null when the line
   * is not up or the relay does not answer: the link then stays on the relay.
   */
  async iceServers(timeoutMs = 8000): Promise<IceServer[] | null> {
    if (this.cached && this.cached.until > Date.now()) return this.cached.servers
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return null
    const id = Math.random().toString(36).slice(2, 12)
    const servers = await new Promise<IceServer[] | null>((resolve) => {
      const timer = setTimeout(() => (this.turns.delete(id), resolve(null)), timeoutMs)
      this.turns.set(id, (s) => (clearTimeout(timer), this.turns.delete(id), resolve(s)))
      ws.send(`!turn ${JSON.stringify({ id })}`)
    })
    // Credentials last 6 hours; keep them for 2, so a session that starts late still has plenty.
    if (servers) this.cached = { servers, until: Date.now() + 2 * 3600_000 }
    return servers
  }

  /** Closes one phone's connection at the relay. */
  close(conn: string): void {
    this.send(conn, '!close')
  }
}
