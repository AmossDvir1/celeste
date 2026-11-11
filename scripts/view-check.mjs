// A phone's screen on the computer (docs/PHONE_PLAN.md 7.3), for real, on the computer's side: the built Celeste with a stand-in
// phone that pairs and offers to show its screen. The "screen" is a moving picture made by a second Chromium window, so this checks
// the whole path the phone's video takes here: the sealed call, Core, the window answering as a WebRTC peer, the panel playing
// real decoded video, and Stop reaching the phone. (What Android does on the phone itself cannot be checked here.)
//   npm run verify:view
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, root, saveSettings } from './lib/app.mjs'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

// The phone's side of the protocol, bundled from the project's own code.
const work = mkdtempSync(join(tmpdir(), 'celeste-view-'))
const bundle = join(work, 'phone-client.mjs')
const built = spawnSync(process.execPath, [join(root, 'node_modules', 'rolldown', 'bin', 'cli.mjs'), join(root, 'src', 'shared', 'phone-client.ts'), '--format', 'esm', '--platform', 'node', '--file', bundle], { encoding: 'utf8' })
if (built.status !== 0) {
  console.error(built.stdout + built.stderr)
  process.exit(1)
}
const { PhoneLink, pair } = await import('file:///' + bundle.replace(/\\/g, '/'))

let app
try {
  app = await launch({ width: 1280, height: 860, theme: null, profile: mkdtempSync(join(tmpdir(), 'celeste-view-profile-')), copilotKnowsNoOne: true })
  const { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })

  console.log('\n# A phone is paired')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Phone' }).click()
  await page.getByRole('switch', { name: 'Let my phone connect' }).click()
  await page.getByAltText("QR code to scan with the phone's camera").waitFor({ timeout: 15_000 })
  const status = await page.evaluate(() => window.celeste.core.call('phone.status', []))
  const pairing = pair(`http://127.0.0.1:${status.port}`, 'Test phone', () => undefined)
  const dialog = page.getByRole('dialog', { name: /wants to connect/ })
  await dialog.waitFor({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Allow', exact: true }).click()
  const paired = await pairing
  const link = new PhoneLink(paired, { rtc: null })
  const pushes = []
  const stopListening = link.listen((p) => pushes.push(p), () => undefined)
  await page.keyboard.press('Escape')
  check('a stand-in phone is paired', !!paired.phoneId)

  console.log('\n# The phone offers to show its screen')
  // The phone's "screen": a moving picture, sent by a second Chromium window as video.
  await app.app.evaluate(({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: false, width: 400, height: 700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, partition: 'view-check-phone' } })
    void w.loadURL('data:text/html,<title>the phone</title>')
  })
  let sender
  for (let i = 0; i < 50 && !sender; i++) {
    sender = app.app.windows().find((w) => w.url().startsWith('data:text/html'))
    if (!sender) await page.waitForTimeout(200)
  }
  await sender.waitForLoadState('domcontentloaded')
  const offer = await sender.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 360
    c.height = 640
    const x = c.getContext('2d')
    let t = 0
    setInterval(() => {
      t += 0.1
      x.fillStyle = `hsl(${(t * 30) % 360},60%,40%)`
      x.fillRect(0, 0, c.width, c.height)
      x.fillStyle = '#fff'
      x.fillRect(150 + 120 * Math.sin(t), 300 + 200 * Math.cos(t * 1.3), 60, 60)
    }, 16)
    const stream = c.captureStream(30)
    const pc = new RTCPeerConnection({ iceServers: [] })
    window.pc = pc
    stream.getTracks().forEach((tr) => pc.addTrack(tr, stream))
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise((r) => {
      if (pc.iceGatheringState === 'complete') return r()
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r()
      setTimeout(r, 3000)
    })
    return pc.localDescription.sdp
  })
  const answer = await link.call('phone.view', { sdp: offer })
  check('the computer answers the offer', typeof answer.sdp === 'string' && answer.sdp.startsWith('v=0') && answer.sdp.includes('m=video'))
  await sender.evaluate((sdp) => window.pc.setRemoteDescription({ type: 'answer', sdp }), answer.sdp)

  console.log('\n# The panel on the computer')
  const panel = page.locator('video').first()
  await panel.waitFor({ timeout: 15_000 })
  await page.getByText('Test phone').first().waitFor({ timeout: 5000 })
  const played = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const v = document.querySelector('video')
        let frames = 0
        const tick = () => {
          frames++
          v.requestVideoFrameCallback(tick)
        }
        v.requestVideoFrameCallback(tick)
        setTimeout(() => resolve({ frames, w: v.videoWidth, h: v.videoHeight }), 4000)
      })
  )
  check(`the phone’s picture plays in a panel with the phone’s name (${(played.frames / 4).toFixed(1)} fps, ${played.w}x${played.h})`, played.frames > 20 && played.w > 100 && played.h > 100)
  check('the panel says it is watching only, and has Stop', (await page.getByRole('button', { name: /Stop showing Test phone/ }).count()) === 1)

  console.log('\n# Stop on the computer reaches the phone')
  await page.getByRole('button', { name: /Stop showing Test phone/ }).click()
  for (let i = 0; i < 40 && !pushes.some((p) => p.type === 'phoneViewStop'); i++) await page.waitForTimeout(100)
  check('the phone is told to stop sharing', pushes.some((p) => p.type === 'phoneViewStop'))
  check('the panel is gone', (await page.locator('video').count()) === 0)
  stopListening()
} catch (err) {
  failures.push(String(err?.stack ?? err))
  console.error(err)
} finally {
  await app?.close()
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed')
process.exit(failures.length ? 1 : 0)
