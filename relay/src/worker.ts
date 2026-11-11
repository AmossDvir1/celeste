// Celeste's relay: lets the Celeste app on a phone reach Celeste on a computer when they are not on the same Wi-Fi.
// A Cloudflare Worker with one Durable Object per computer (a "room"). See rules.ts for what passes through, and
// ../README.md for running it. It keeps nothing but, per room, a hash of the computer's secret.
//
// The room uses WebSocket hibernation: while nobody sends anything it is not running, and costs nothing.

import { DurableObject } from 'cloudflare:workers'
import { CLOSE, FORGET_AFTER_MS, HOST_PROTOCOL, MAX_FRAME, MAX_PHONES, PHONE_PROTOCOL, ROOM_RE, hostFrame, newConn, role, same, sha256Hex, take, type Bucket } from './rules'

interface Env {
  ROOMS: DurableObjectNamespace<Room>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/') return new Response('Celeste relay. It passes sealed messages between a phone and its computer, and reads none of them.\n')
    const m = /^\/v1\/([^/]+)$/.exec(url.pathname)
    if (!m || !ROOM_RE.test(m[1] as string)) return new Response('Not found', { status: 404 })
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

  override async fetch(request: Request): Promise<Response> {
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
      const f = hostFrame(message)
      if (!f) return
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
