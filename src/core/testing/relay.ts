// A stand-in for Celeste's relay (relay/src/worker.ts), for tests: the same rules (relay/src/rules.ts) on a plain Node
// WebSocket server, so the computer's and the phone's sides are tested without Cloudflare's runtime. The real Worker is
// checked against the same scenario by `npm run verify:relay`.

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { CLOSE, HOST_PROTOCOL, MAX_FRAME, MAX_PHONES, PHONE_PROTOCOL, ROOM_RE, hostFrame, newConn, role, same, sha256Hex, take, type Bucket } from '../../../relay/src/rules'

interface Room {
  owner: string
  host: WebSocket | null
  phones: Map<string, { ws: WebSocket; bucket?: Bucket }>
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

export async function startRelay(): Promise<StandInRelay> {
  const rooms = new Map<string, Room>()
  const seen: string[] = []
  const http: Server = createServer((_req, res) => void res.writeHead(426).end())
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
        if (!room) rooms.set(name, (room = { owner: hash, host: null, phones: new Map() }))
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
            seen.push(text)
            const f = hostFrame(text)
            if (!f) return
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
