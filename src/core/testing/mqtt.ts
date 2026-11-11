// A stand-in for a public MQTT broker, for tests: just enough of MQTT 3.1.1 over WebSocket (CONNECT, SUBSCRIBE, PUBLISH,
// PINGREQ) for src/shared/signal.ts. It keeps every message it carried, so a test can see what a broker would see.

import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

export interface StandInBroker {
  /** Like ws://127.0.0.1:41234/mqtt */
  url: string
  /** Every publish, as the broker saw it: the topic and the payload text. */
  seen: { topic: string; payload: string }[]
  /** Cuts every connection, as when a broker restarts. */
  dropAll(): void
  stop(): Promise<void>
}

export async function startBroker(): Promise<StandInBroker> {
  const http: Server = createServer()
  const wss = new WebSocketServer({ server: http, handleProtocols: () => 'mqtt' })
  const subs = new Map<WebSocket, Set<string>>()
  const seen: StandInBroker['seen'] = []
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
  wss.on('connection', (ws) => {
    subs.set(ws, new Set())
    let buf = Buffer.alloc(0)
    ws.on('message', (data) => {
      buf = Buffer.concat([buf, data as Buffer])
      for (;;) {
        if (buf.length < 2) return
        let len = 0
        let mult = 1
        let i = 1
        for (;;) {
          if (i >= buf.length) return
          const d = buf[i++] as number
          len += (d & 127) * mult
          if (!(d & 128)) break
          mult *= 128
        }
        if (buf.length < i + len) return
        const type = (buf[0] as number) >> 4
        const body = buf.subarray(i, i + len)
        buf = buf.subarray(i + len)
        if (type === 1) ws.send(Buffer.from([0x20, 2, 0, 0]))
        else if (type === 8) {
          const tl = body.readUInt16BE(2)
          subs.get(ws)?.add(body.subarray(4, 4 + tl).toString('utf8'))
          ws.send(Buffer.from([0x90, 3, body[0] as number, body[1] as number, 0]))
        } else if (type === 12) ws.send(Buffer.from([0xd0, 0]))
        else if (type === 3) {
          const tl = body.readUInt16BE(0)
          const topic = body.subarray(2, 2 + tl).toString('utf8')
          seen.push({ topic, payload: body.subarray(2 + tl).toString('utf8') })
          const out = Buffer.concat([Buffer.from([0x30, ...varint(body.length)]), body])
          for (const [peer, topics] of subs) if (topics.has(topic) && peer.readyState === peer.OPEN) peer.send(out)
        }
      }
    })
    ws.on('close', () => subs.delete(ws))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return {
    url: `ws://127.0.0.1:${port}/mqtt`,
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
