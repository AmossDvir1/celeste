import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

/** Test stand-ins for npm: a tar archive written by hand, and a registry that serves one package. Never imported by the app. */

export function tar(entries: { name: string; data?: string | Buffer; type?: string; link?: string }[], opts: { pax?: Record<string, string> } = {}): Buffer {
  const blocks: Buffer[] = []
  const header = (name: string, size: number, type: string, link = ''): Buffer => {
    const h = Buffer.alloc(512)
    h.write(name.slice(0, 100), 0, 'utf8')
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write(type, 156)
    h.write(link, 157)
    h.write('ustar\0', 257)
    h.write('00', 263)
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    return h
  }
  const body = (data: Buffer) => [data, Buffer.alloc((512 - (data.length % 512)) % 512)]
  for (const e of entries) {
    if (opts.pax?.[e.name]) {
      const record = ` path=${opts.pax[e.name]}\n`
      const line = `${String(record.length + String(record.length + 3).length)}${record}`
      const data = Buffer.from(line)
      blocks.push(header('PaxHeader', data.length, 'x'), ...body(data))
    }
    const data = Buffer.from(e.data ?? '')
    const type = e.type ?? '0'
    blocks.push(header(e.name, type === '0' ? data.length : 0, type, e.link), ...(type === '0' ? body(data) : []))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

export const sha512 = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`

export interface RegistryOverrides {
  integrity?: string
  tarballUrl?: (base: string) => string
  status?: number
  /** Sends a little of the file and then waits, so a download can be cancelled part-way. */
  slow?: boolean
}

/** A pretend npm registry that serves `tarball` as every package whose URL begins with `prefix` (an encoded package name). */
export async function fakeRegistry(prefix: string[], tarball: Buffer, over: RegistryOverrides = {}): Promise<{ url: string; hits: { meta: number; tarball: number }; close: () => Promise<void> }> {
  const hits = { meta: 0, tarball: 0 }
  const server: Server = createServer((req, res) => {
    if (prefix.some((p) => req.url?.startsWith(p))) {
      hits.meta++
      if (over.status) {
        res.writeHead(over.status).end('nope')
        return
      }
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ dist: { tarball: over.tarballUrl ? over.tarballUrl(base) : `${base}/runtime.tgz`, integrity: over.integrity ?? sha512(tarball) } }))
    } else if (req.url === '/runtime.tgz') {
      hits.tarball++
      res.writeHead(200, { 'content-length': String(tarball.length) })
      if (over.slow) {
        res.write(tarball.subarray(0, 100))
        return
      }
      res.end(tarball)
    } else res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())))
  }
}

export { gzipSync }
