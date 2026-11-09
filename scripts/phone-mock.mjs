// Serves the phone app mock (mockups/phone) so it can be opened on a real phone on the same Wi-Fi.
// Prints the link and a QR code: scan it with the phone's camera. `--local` listens on this computer only.
// Only the mock's folder is served, and only while this runs. Ctrl+C stops it.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mockups/phone')
const port = Number(process.env.PORT) || 5199
const local = process.argv.includes('--local')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
}

const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url ?? '/', 'http://mock').pathname)
  if (p.endsWith('/')) p += 'index.html'
  const file = path.resolve(root, '.' + p)
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('Not found')
  }
})

// Home networks first (192.168.x), then 10.x, then 172.16-31.x, which is often a virtual adapter.
const rank = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2)
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
  .map((a) => a.address)
  .sort((a, b) => rank(a) - rank(b))

server.listen(port, local ? '127.0.0.1' : '0.0.0.0', async () => {
  console.log(`\nCeleste phone mock\n  On this computer: http://localhost:${port}/`)
  if (local) return
  if (!lan.length) {
    console.log('  No Wi-Fi address found: is this computer on a network?')
    return
  }
  const url = `http://${lan[0]}:${port}/?bare`
  console.log(`  On your phone:    ${url}`)
  for (const other of lan.slice(1)) console.log(`  (or)              http://${other}:${port}/?bare`)
  console.log('\nScan with the phone camera (same Wi-Fi). If Windows asks, allow Node on Private networks.\n')
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }))
})
