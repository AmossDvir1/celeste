import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const electronPath = require('electron')

const dir = import.meta.dirname
const child = spawn(electronPath, [dir, '--bridge'], { stdio: ['pipe', 'pipe', 'pipe'] })
let endpoint = ''
let port = 0
const logs = []
child.stdout.on('data', (d) => {
  for (const line of String(d).split(/\r?\n/)) {
    if (line.startsWith('BRIDGE ')) endpoint = line.slice(7)
    else if (line.startsWith('READY ')) port = Number(line.slice(6))
    else if (line.trim()) logs.push(line)
  }
})
child.stderr.on('data', (d) => logs.push('ERR ' + String(d).trim().slice(0, 300)))
const until = async (f, ms = 20000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)) } }

const r = {}
const step = async (name, fn) => {
  try { r[name] = await fn() } catch (e) { r[name] = 'FAILED: ' + String(e.message || e).split('\n')[0] }
}
try {
  await until(() => endpoint && port)
  const browser = await chromium.connectOverCDP(endpoint)
  const ctx = browser.contexts()[0]
  await step('pagesSeen', async () => ctx.pages().map((p) => p.url()))
  const page = ctx.pages()[0]
  const consoles = []
  page.on('console', (m) => consoles.push(m.text()))
  await step('title', () => page.title())
  await step('click', async () => { await page.click('#b'); return await page.textContent('#out') })
  await step('fill', async () => { await page.fill('#i', 'Dana'); return await page.inputValue('#i') })
  await step('screenshot', async () => (await page.screenshot()).length)
  await step('frames', async () => page.frames().map((f) => f.url()))
  await step('crossSiteIframeClick', async () => {
    const f = page.frames().find((x) => x.url().includes('/frame'))
    await f.click('#fb')
    return await f.textContent('#fo')
  })
  await step('console', async () => { await page.waitForTimeout(300); return consoles })
  await step('snapshotForAI', async () => await page.ariaSnapshot({ mode: 'ai', boxes: true }))
  await step('clickByRef', async () => {
    const text = await page.ariaSnapshot({ mode: 'ai' })
    const m = text.match(/button "Press me" \[ref=(e\d+)\]/)
    if (!m) return 'no ref found in: ' + text.slice(0, 300)
    await page.getByRef(m[1]).click()
    return await page.textContent('#out')
  })
  await step('newTabViaApi', async () => {
    const p2 = await ctx.newPage()
    await p2.goto(`http://127.0.0.1:${port}/second`)
    return { title: await p2.title(), pages: ctx.pages().length }
  })
  await step('targetBlankLink', async () => {
    const [p3] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), page.click('#blank')])
    await p3.waitForLoadState()
    return { url: p3.url(), pages: ctx.pages().length }
  })
  await step('closeTab', async () => {
    const before = ctx.pages().map((p) => p.url())
    const extra = ctx.pages().find((p) => !p.url().includes('127.0.0.1:' + port + '/') || p.url().endsWith('/second') || p.url() === 'about:blank')
    await Promise.race([extra.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('close hung')), 8000))])
    return { before, after: ctx.pages().map((p) => p.url()) }
  })
  await step('browserVersion', async () => browser.version())
  await step('windowNotExposed', async () => ctx.pages().every((p) => !p.url().startsWith('file:')))
  await step('uaNoElectron', async () => { const ua = await page.evaluate(() => navigator.userAgent); return { ua, hasElectron: /Electron/.test(ua) } })
  await step('webdriver', async () => page.evaluate(() => navigator.webdriver))
  await browser.close().catch(() => undefined)
} catch (e) {
  r.fatal = String(e.stack || e)
}
let exited = child.exitCode !== null ? `already exited with ${child.exitCode}` : ''
child.on('exit', (c) => { exited = exited || `exited with ${c}` })
child.stdin.on('error', () => undefined)
try { child.stdin.write('quit') } catch {}
await new Promise((res) => { child.on('exit', res); setTimeout(res, 6000) })
r.appState = exited || 'still running after quit'
console.log(JSON.stringify(r, null, 2))
console.log('--- app log ---\n' + logs.slice(0, 25).join('\n'))
