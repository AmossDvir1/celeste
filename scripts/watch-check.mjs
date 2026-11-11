// The computer's screen as live video (src/main/desktop/watch.ts), for real: Electron captures this computer's screen in a
// hidden window and answers a "phone" (a second Chromium window, which decodes what it is sent) over WebRTC on this computer.
// Checks that video really arrives and moves, that it goes black while a never-listed window is shown, and that it stops.
//   npm run verify:watch
// It needs a desktop session: it captures the main screen, and puts a small moving window at its top left for a few seconds.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'celeste-watch-check-'))
const require = createRequire(import.meta.url)

// 1. The module under test, bundled the way the app bundles it (Electron and Node left outside).
const bundle = join(work, 'watch.bundle.mjs')
const built = spawnSync(process.execPath, [join(root, 'node_modules', 'rolldown', 'bin', 'cli.mjs'), join(root, 'src', 'main', 'desktop', 'watch.ts'), '--format', 'esm', '--platform', 'node', '--external', 'electron', '--file', bundle], { encoding: 'utf8' })
if (built.status !== 0) {
  console.error(built.stdout + built.stderr)
  process.exit(1)
}

// 2. An Electron main program that plays both parts.
writeFileSync(join(work, 'phone.html'), '<!doctype html><meta charset="utf-8"><title>phone stand-in</title><body></body>')
writeFileSync(
  join(work, 'main.mjs'),
  `
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { WatchService } from ${JSON.stringify('file:///' + bundle.replace(/\\/g, '/'))}

const log = (k, v) => console.log('RESULT ' + k + ' ' + JSON.stringify(v))
// Not awaited at the top level: Electron waits for this file to finish loading before it says it is ready.
app.whenReady().then(async () => {
const gate = { blockedNow: false, ready: () => null, blocked: () => gate.blockedNow }
const svc = new WatchService(gate)
// Something moving on the screen, or the video of a still screen would send almost nothing (which is right, but proves little).
const mover = new BrowserWindow({ x: 40, y: 40, width: 360, height: 240, frame: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { sandbox: true } })
await mover.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#123"><div id=b style="width:90px;height:90px;background:#fc3;position:absolute"></div><script>let t=0;setInterval(()=>{t+=0.08;b.style.left=(130+110*Math.sin(t))+"px";b.style.top=(70+60*Math.cos(t*1.3))+"px";document.body.style.background="hsl("+(t*40%360)+",60%,30%)"},8)</script>'))
// The phone: a window of its own beside it, on the screen and not throttled (a hidden or off-screen one decodes nothing).
const phone = new BrowserWindow({ x: 420, y: 40, width: 320, height: 200, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
await phone.loadFile(join(${JSON.stringify(work)}, 'phone.html'))
const run = (code) => phone.webContents.executeJavaScript(code, true)

// The phone's offer: it only wants to receive video.
const offer = await run(\`(async () => {
  const pc = new RTCPeerConnection({ iceServers: [] })
  window.pc = pc
  pc.addTransceiver('video', { direction: 'recvonly' })
  const v = document.createElement('video')
  v.muted = true; v.autoplay = true; v.playsInline = true
  document.body.append(v)
  window.v = v
  pc.ontrack = (e) => { v.srcObject = e.streams[0] || new MediaStream([e.track]); v.play().catch(() => {}) }
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 3000) })
  return pc.localDescription.sdp
})()\`)
const answer = await svc.start('phone-1', offer, [])
log('answerIsSdp', answer.startsWith('v=0') && answer.includes('m=video'))
await run('pc.setRemoteDescription({ type: "answer", sdp: ' + JSON.stringify(answer) + ' })')

// Frames, counted and sampled for 4 seconds.
const sample = (ms) => run(\`new Promise((resolve) => {
  const v = window.v
  let frames = 0
  const c = document.createElement('canvas'); c.width = 64; c.height = 36
  const x = c.getContext('2d', { willReadFrequently: true })
  let max = 0
  const tick = () => { frames++; x.drawImage(v, 0, 0, 64, 36); const d = x.getImageData(0, 0, 64, 36).data; for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]); v.requestVideoFrameCallback(tick) }
  v.requestVideoFrameCallback(tick)
  setTimeout(() => resolve({ frames, max, w: v.videoWidth, h: v.videoHeight, state: pc.connectionState }), \${ms})
})\`)
const live = await sample(6000)
log('live', live)

// A never-listed window comes up: the video goes black within a moment, and comes back when it is gone.
gate.blockedNow = true
await new Promise((r) => setTimeout(r, 1200))
const black = await sample(1500)
log('blocked', black)
gate.blockedNow = false
await new Promise((r) => setTimeout(r, 1200))
const back = await sample(1500)
log('unblocked', back)

svc.stop('phone-1')
mover.destroy()
phone.destroy()
log('stopped', svc.count === 0)
app.exit(0)
}).catch((e) => { console.log('FAILED ' + (e && e.stack || e)); app.exit(1) })
`
)

const electronPath = require('electron')
const child = spawn(electronPath, [join(work, 'main.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))
const timer = setTimeout(() => child.kill(), 60_000)
await new Promise((r) => child.on('exit', r))
clearTimeout(timer)

const r = Object.fromEntries([...out.matchAll(/^RESULT (\S+) (.*)$/gm)].map((m) => [m[1], JSON.parse(m[2])]))
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}
check('the computer answers a phone’s offer with video', r.answerIsSdp === true)
check('video arrives and is decoded', r.live?.frames > 20 && r.live?.w > 200 && r.live?.h > 100, r.live ? `${(r.live.frames / 6).toFixed(1)} fps, ${r.live.w}x${r.live.h}, ${r.live.state}` : 'no result')
check('it shows the screen (not black)', r.live?.max > 8, r.live ? `brightest pixel ${r.live.max}` : '')
check('it goes black while a never-listed window is on the screen', r.blocked?.max <= 2, r.blocked ? `brightest pixel ${r.blocked.max}` : '')
check('and comes back when it is gone', r.unblocked?.max > 8, r.unblocked ? `brightest pixel ${r.unblocked.max}` : '')
check('it stops', r.stopped === true)
if (failed) console.error('\n' + out)
process.exit(failed ? 1 : 0)
