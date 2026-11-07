// Captures the key screens of the built app in both themes: npm run shots
// Output: scripts/.output/shots/<theme>-<screen>.png
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { launch, root, saveSettings } from './lib/app.mjs'

const out = resolve(root, 'scripts/.output/shots')
mkdirSync(out, { recursive: true })

const W = 1440
const H = 900

const settings = (theme, wizardDone = true) => ({
  theme,
  userName: 'Alex',
  wizardDone,
  sidebarCollapsed: false,
  defaults: { model: 'copilot-auto', approval: 'auto', projectsFolder: 'D:\\Projects' }
})

/** A small gradient PNG for the attachment preview, made without any image library. */
function gradientPng(w, h) {
  const crc = (buf) => {
    let c = ~0
    for (const b of buf) {
      c ^= b
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round(31 + t * 214)
      raw[o + 1] = Math.round(48 + t * 24)
      raw[o + 2] = Math.round(110 + t * 17)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

for (const theme of ['dark', 'light']) {
  const { page, close } = await launch({ width: W, height: H, theme })
  const snap = async (name) => {
    await page.waitForTimeout(450)
    await page.screenshot({ path: resolve(out, `${theme}-${name}.png`) })
    console.log(`${theme}-${name}`)
  }
  const reload = async (wizardDone = true) => {
    await saveSettings(page, settings(theme, wizardDone))
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
  }
  const tab = (label) => page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: label }).click()

  await reload(false)
  await snap('wizard-welcome')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForTimeout(300)
  await snap('wizard-connect')

  await reload(true)
  await snap('chat-home')

  await page.getByRole('button', { name: /Analyze WFO logs/ }).first().click()
  await snap('chat-conversation')

  await page.getByRole('button', { name: 'New chat' }).click()
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'dashboard-mockup.png', mimeType: 'image/png', buffer: gradientPng(640, 360) },
    { name: 'Q3-report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample') }
  ])
  await page.waitForTimeout(400)
  await page.getByLabel(/dashboard-mockup\.png/).first().hover()
  await page.waitForTimeout(500)
  await snap('attachments-hover')
  await page.mouse.move(700, 120)

  await tab('Develop')
  await snap('develop-home')
  await page.getByRole('button', { name: /Fix flaky checkout test/ }).first().click()
  await page.getByRole('button', { name: 'Changes' }).click()
  await snap('develop-diffs')

  await tab('Workflows')
  await page.waitForTimeout(500)
  await page.locator('.react-flow__node').filter({ hasText: 'Find old KBs' }).click()
  await snap('workflows')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await snap('settings-vendors')

  await close()
}
console.log(`\nSaved to ${out}`)
