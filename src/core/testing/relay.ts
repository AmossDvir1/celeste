// A stand-in for Celeste's relay (relay/src/worker.ts), for tests: the same rules (relay/src/rules.ts) on a plain Node
// WebSocket server, so the computer's and the phone's sides are tested without Cloudflare's runtime. The real Worker is
// checked against the same scenario by `npm run verify:relay`.

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { sendWake, type FcmEnv } from '../../../relay/src/fcm'
import { CLOSE, HOST_PROTOCOL, HTTP_RPC_WAIT_MS, MAX_FRAME, MAX_PHONES, MAX_WAKE_BOX, PHONE_PROTOCOL, ROOM_RE, TOKEN_RE, WAKE_TTL, hostFrame, newConn, role, same, sha256Hex, take, type Bucket } from '../../../relay/src/rules'

interface Room {
  owner: string
  host: WebSocket | null
  phones: Map<string, { ws: WebSocket; bucket?: Bucket }>
  /** Requests that came over HTTP, waiting for the computer's answer. */
  http: Map<string, (text: string) => void>
}

export interface StandInRelay {
  /** Like ws://127.0.0.1:41234 */
  url: string
  /** Every frame that passed, as the relay saw it: for checking it could read none of it. */
  seen: string[]
  /** Cuts every connection, as when the relay restarts. Rooms stay known. */
  dropAll(): void
  stop(): Promise<void>
}

export async function startRelay(env: FcmEnv = {}): Promise<StandInRelay> {
  const rooms = new Map<string, Room>()
  const seen: string[] = []
  const http: Server = createServer((req, res) => {
    const m = /^\/v1\/([^/?]+)\/rpc$/.exec(req.url ?? '')
    if (!m || req.method !== 'POST') return void res.writeHead(426).end()
    const reply = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    const room = rooms.get(m[1] as string)
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!room?.host) return reply(503, { error: 'The computer is not connected.' })
      let body: { phone?: unknown; box?: unknown }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        return reply(400, { error: 'Bad request' })
      }
      if (typeof body.phone !== 'string' || typeof body.box !== 'string') return reply(400, { error: 'Bad request' })
      const conn = newConn()
      const timer = setTimeout(() => (room.http.delete(conn), reply(504, { error: 'The computer did not answer.' })), HTTP_RPC_WAIT_MS)
      room.http.set(conn, (text) => {
        clearTimeout(timer)
        room.http.delete(conn)
        const f = JSON.parse(text) as { status?: number; box?: string; error?: string }
        f.box ? reply(f.status ?? 200, { box: f.box }) : reply(f.status ?? 400, { error: f.error ?? 'Refused' })
      })
      room.host.send(`${conn} ${JSON.stringify({ t: 'rpc', id: 1, phone: body.phone, box: body.box })}`)
    })
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME * 2, handleProtocols: (protocols) => ([...protocols][0] === HOST_PROTOCOL ? HOST_PROTOCOL : PHONE_PROTOCOL) })

  http.on('upgrade', (req, socket, head) => {
    const refuse = (status: number) => {
      socket.write(`HTTP/1.1 ${status} Refused\r\nconnection: close\r\n\r\n`)
      socket.destroy()
    }
    void (async () => {
      const m = /^\/v1\/([^/?]+)$/.exec(req.url ?? '')
      const who = role(req.headers['sec-websocket-protocol'])
      if (!m || !ROOM_RE.test(m[1] as string)) return refuse(404)
      if (!who) return refuse(400)
      const name = m[1] as string
      let room = rooms.get(name)
      if (who.role === 'host') {
        const hash = await sha256Hex(who.secret)
        if (room && !same(room.owner, hash)) return refuse(403)
        if (!room) rooms.set(name, (room = { owner: hash, host: null, phones: new Map(), http: new Map() }))
        const r = room
        wss.handleUpgrade(req, socket, head, (ws) => {
          r.host?.close(CLOSE.replaced)
          r.host = ws
          for (const p of r.phones.values()) p.ws.send('!host 1')
          ws.on('message', (data, binary) => {
            const text = data.toString()
            if (binary) return ws.close(1003)
            if (text === 'ping') return ws.send('pong')
            if (text.length > MAX_FRAME) return ws.close(CLOSE.tooLarge)
            if (text.startsWith('!wake ')) {
              const w = JSON.parse(text.slice(6)) as { id?: string; token?: unknown; box?: unknown; ttl?: unknown }
              const answer = (v: Record<string, unknown>) => ws.send(`!wake ${JSON.stringify({ id: w.id, ...v })}`)
              if (typeof w.token !== 'string' || !TOKEN_RE.test(w.token) || typeof w.box !== 'string' || w.box.length > MAX_WAKE_BOX) return answer({ ok: false, code: 'INVALID' })
              const ttl = Math.max(WAKE_TTL.min, Math.min(WAKE_TTL.max, typeof w.ttl === 'number' ? Math.floor(w.ttl) : 300))
              void sendWake(env, w.token, w.box, ttl).then(answer)
              return
            }
            seen.push(text)
            const f = hostFrame(text)
            if (!f) return
            const waiting = r.http.get(f.conn)
            if (waiting) return waiting(f.text)
            const phone = r.phones.get(f.conn)
            if (!phone) return ws.send(`${f.conn} -`)
            if (f.text === '!close') return phone.ws.close(CLOSE.byHost)
            phone.ws.send(f.text)
          })
          ws.on('close', () => {
            if (r.host !== ws) return
            r.host = null
            for (const p of r.phones.values()) p.ws.send('!host 0')
          })
        })
        return
      }
      if (!room) return refuse(404)
      if (room.phones.size >= MAX_PHONES) return refuse(429)
      const r = room
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = newConn()
        const me: { ws: WebSocket; bucket?: Bucket } = { ws }
        r.phones.set(conn, me)
        ws.send(r.host ? '!host 1' : '!host 0')
        ws.on('message', (data, binary) => {
          const text = data.toString()
          if (binary) return ws.close(1003)
          if (text === 'ping') return ws.send('pong')
          if (text.length > MAX_FRAME) return ws.close(CLOSE.tooLarge)
          if (text.startsWith('!')) return
          const t = take(me.bucket, Date.now())
          me.bucket = t.bucket
          if (!t.ok) return ws.close(CLOSE.tooFast)
          seen.push(text)
          r.host?.send(`${conn} ${text}`)
        })
        ws.on('close', () => {
          r.phones.delete(conn)
          r.host?.send(`${conn} -`)
        })
      })
    })()
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}`,
    seen,
    dropAll: () => wss.clients.forEach((c) => c.terminate()),
    stop: () =>
      new Promise<void>((resolve) => {
        wss.clients.forEach((c) => c.terminate())
        http.close(() => resolve())
        http.closeAllConnections()
      })
  }
}
