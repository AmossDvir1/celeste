// Celeste's relay: lets the Celeste app on a phone reach Celeste on a computer when they are not on the same Wi-Fi.
// A Cloudflare Worker with one Durable Object per computer (a "room"). See rules.ts for what passes through, and
// ../README.md for running it. It keeps nothing but, per room, a hash of the computer's secret.
//
// The room uses WebSocket hibernation: while nobody sends anything it is not running, and costs nothing.

import { DurableObject } from 'cloudflare:workers'
import { sendWake, type FcmEnv } from './fcm'
import { iceServers, type TurnEnv } from './turn'
import {
  CLOSE,
  FORGET_AFTER_MS,
  HOST_PROTOCOL,
  HTTP_RPC_PER_MINUTE,
  HTTP_RPC_WAIT_MS,
  MAX_FRAME,
  MAX_PHONES,
  MAX_WAKE_BOX,
  PHONE_PROTOCOL,
  ROOM_RE,
  TOKEN_RE,
  TURNS_PER_HOUR,
  WAKES_PER_HOUR,
  WAKE_TTL,
  hostFrame,
  newConn,
  role,
  same,
  sha256Hex,
  take,
  type Bucket
} from './rules'

interface Env extends FcmEnv, TurnEnv {
  ROOMS: DurableObjectNamespace<Room>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/') return new Response('Celeste relay. It passes sealed messages between a phone and its computer, and reads none of them.\n')
    const m = /^\/v1\/([^/]+)(\/rpc)?$/.exec(url.pathname)
    if (!m || !ROOM_RE.test(m[1] as string)) return new Response('Not found', { status: 404 })
    // The app's background service has no WebSocket: it sends one request over HTTP and waits for the answer.
    if (m[2]) return request.method === 'POST' ? env.ROOMS.get(env.ROOMS.idFromName(m[1] as string)).fetch(request) : new Response('POST only', { status: 405 })
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    if (!role(request.headers.get('sec-websocket-protocol'))) return new Response('Not a Celeste connection', { status: 400 })
    return env.ROOMS.get(env.ROOMS.idFromName(m[1] as string)).fetch(request)
  }
} satisfies ExportedHandler<Env>

/** What is remembered about a socket across hibernation. */
type Tag = { role: 'host' } | { role: 'phone'; conn: string; bucket?: Bucket }

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private host(): WebSocket | undefined {
    return this.ctx.getWebSockets('host')[0]
  }

  /** Requests from the app's background service, waiting for the computer's answer. */
  private readonly http = new Map<string, (text: string) => void>()
  private httpCount = { minute: 0, n: 0 }

  private async rpcOverHttp(request: Request): Promise<Response> {
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    const now = Math.floor(Date.now() / 60_000)
    if (this.httpCount.minute !== now) this.httpCount = { minute: now, n: 0 }
    if (++this.httpCount.n > HTTP_RPC_PER_MINUTE) return json(429, { error: 'Too many requests.' })
    const host = this.host()
    if (!host) return json(503, { error: 'The computer is not connected.' })
    const text = await request.text()
    if (text.length > MAX_FRAME) return json(413, { error: 'Too large.' })
    let body: { phone?: unknown; box?: unknown }
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      return json(400, { error: 'Bad request' })
    }
    if (typeof body.phone !== 'string' || typeof body.box !== 'string') return json(400, { error: 'Bad request' })
    const conn = newConn()
    const answer = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => (this.http.delete(conn), resolve(null)), HTTP_RPC_WAIT_MS)
      this.http.set(conn, (t) => (clearTimeout(timer), this.http.delete(conn), resolve(t)))
    })
    host.send(`${conn} ${JSON.stringify({ t: 'rpc', id: 1, phone: body.phone, box: body.box })}`)
    const reply = await answer
    if (reply === null) return json(504, { error: 'The computer did not answer.' })
    try {
      const f = JSON.parse(reply) as { status?: number; box?: string; error?: string }
      return f.box ? json(f.status ?? 200, { box: f.box }) : json(f.status ?? 400, { error: f.error ?? 'Refused' })
    } catch {
      return json(502, { error: 'Bad answer' })
    }
  }

  /** The computer asks for a phone to be woken: sends the box through Google, and says how it went. */
  private async wake(ws: WebSocket, text: string): Promise<void> {
    let w: { id?: unknown; token?: unknown; box?: unknown; ttl?: unknown }
    try {
      w = JSON.parse(text) as typeof w
    } catch {
      return
    }
    const id = typeof w.id === 'string' ? w.id.slice(0, 40) : ''
    const answer = (value: Record<string, unknown>) => {
      try {
        ws.send(`!wake ${JSON.stringify({ id, ...value })}`)
      } catch {
        // The computer is gone.
      }
    }
    if (typeof w.token !== 'string' || !TOKEN_RE.test(w.token) || typeof w.box !== 'string' || w.box.length > MAX_WAKE_BOX) return answer({ ok: false, code: 'INVALID' })
    // This many an hour for a computer, kept so it holds when the room sleeps between messages.
    const hour = Math.floor(Date.now() / 3_600_000)
    const used = (await this.ctx.storage.get<{ hour: number; n: number }>('wakes')) ?? { hour, n: 0 }
    const n = used.hour === hour ? used.n : 0
    if (n >= WAKES_PER_HOUR) return answer({ ok: false, code: 'LIMIT' })
    await this.ctx.storage.put('wakes', { hour, n: n + 1 })
    const ttl = Math.max(WAKE_TTL.min, Math.min(WAKE_TTL.max, typeof w.ttl === 'number' && Number.isFinite(w.ttl) ? Math.floor(w.ttl) : 300))
    answer(await sendWake(this.env, w.token, w.box, ttl))
  }

  /** The computer asks for the addresses of the direct link (STUN, and TURN when the project set it up). */
  private async turn(ws: WebSocket, text: string): Promise<void> {
    let id = ''
    try {
      id = String((JSON.parse(text) as { id?: unknown }).id ?? '').slice(0, 40)
    } catch {
      return
    }
    // A handful an hour is plenty: the computer keeps what it got until it nearly expires.
    const hour = Math.floor(Date.now() / 3_600_000)
    const used = (await this.ctx.storage.get<{ hour: number; n: number }>('turns')) ?? { hour, n: 0 }
    const n = used.hour === hour ? used.n : 0
    if (n >= TURNS_PER_HOUR) return void ws.send(`!turn ${JSON.stringify({ id, ok: false, code: 'LIMIT' })}`)
    await this.ctx.storage.put('turns', { hour, n: n + 1 })
    const { servers, turn } = await iceServers(this.env)
    try {
      ws.send(`!turn ${JSON.stringify({ id, ok: true, servers, turn })}`)
    } catch {
      // The computer is gone.
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith('/rpc')) return this.rpcOverHttp(request)
    const who = role(request.headers.get('sec-websocket-protocol'))
    if (!who) return new Response('Not a Celeste connection', { status: 400 })

    if (who.role === 'host') {
      // The first computer to come to a room owns it: later ones must bring the same secret.
      const hash = await sha256Hex(who.secret)
      const owner = await this.ctx.storage.get<string>('owner')
      if (owner && !same(owner, hash)) return new Response('This room belongs to another computer', { status: 403 })
      if (!owner) await this.ctx.storage.put('owner', hash)
      await this.ctx.storage.deleteAlarm()
      for (const old of this.ctx.getWebSockets('host')) old.close(CLOSE.replaced, 'Another connection from this computer took over')
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1], ['host'])
      pair[1].serializeAttachment({ role: 'host' } satisfies Tag)
      for (const p of this.ctx.getWebSockets('phone')) p.send('!host 1')
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'sec-websocket-protocol': HOST_PROTOCOL } })
    }

    // A room no computer ever came to takes no phones: a made-up room name gets nothing.
    if (!(await this.ctx.storage.get<string>('owner'))) return new Response('No such room', { status: 404 })
    if (this.ctx.getWebSockets('phone').length >= MAX_PHONES) return new Response('Too many phones', { status: 429 })
    const conn = newConn()
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], ['phone', conn])
    pair[1].serializeAttachment({ role: 'phone', conn } satisfies Tag)
    pair[1].send(this.host() ? '!host 1' : '!host 0')
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'sec-websocket-protocol': PHONE_PROTOCOL } })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tag = ws.deserializeAttachment() as Tag | null
    if (!tag || typeof message !== 'string') return ws.close(1003, 'Text only')
    if (message.length > MAX_FRAME) return ws.close(CLOSE.tooLarge, 'Too large')

    if (tag.role === 'host') {
      if (message.startsWith('!wake ')) return this.wake(ws, message.slice(6))
      if (message.startsWith('!turn ')) return this.turn(ws, message.slice(6))
      const f = hostFrame(message)
      if (!f) return
      const waiting = this.http.get(f.conn)
      if (waiting) return waiting(f.text)
      const phone = this.ctx.getWebSockets(f.conn)[0]
      if (!phone) return ws.send(`${f.conn} -`)
      if (f.text === '!close') return phone.close(CLOSE.byHost, 'The computer closed this line')
      phone.send(f.text)
      return
    }

    if (message.startsWith('!')) return
    // Kept on the socket itself, so the count survives the room going to sleep between messages.
    const t = take(tag.bucket, Date.now())
    ws.serializeAttachment({ ...tag, bucket: t.bucket } satisfies Tag)
    if (!t.ok) return ws.close(CLOSE.tooFast, 'Too many messages')
    this.host()?.send(`${tag.conn} ${message}`)
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Answer the other side's close, so its socket ends at once instead of waiting for a timeout.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
    } catch {
      // Already closed.
    }
    await this.gone(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.gone(ws)
  }

  private async gone(ws: WebSocket): Promise<void> {
    const tag = ws.deserializeAttachment() as Tag | null
    if (!tag) return
    if (tag.role === 'phone') {
      this.host()?.send(`${tag.conn} -`)
      return
    }
    // The computer left. Was it replaced by a newer connection of its own?
    if (this.ctx.getWebSockets('host').some((h) => h !== ws && h.readyState === WebSocket.OPEN)) return
    for (const p of this.ctx.getWebSockets('phone')) p.send('!host 0')
    await this.ctx.storage.setAlarm(Date.now() + FORGET_AFTER_MS)
  }

  /** The computer has not come back for a long time: forget the room. */
  override async alarm(): Promise<void> {
    if (this.host()) return
    for (const p of this.ctx.getWebSockets('phone')) p.close(1001, 'The room is gone')
    await this.ctx.storage.deleteAll()
  }
}
