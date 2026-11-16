// SPIKE (16 November 2026), not a check: does Excalidraw run under the app's release Content Security Policy (copied into index.html), with
// nothing fetched from the network? Results are in docs/plans/CHAT_DISPLAY_PLAN.md, section 11b.
// Setup: npm install in this folder, then `npx vite build`, then `node run.mjs` (add `--offline` to also block every address but local ones).
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../../../package.json', import.meta.url))
const { _electron: electron } = require('playwright-core')
const here = dirname(fileURLToPath(import.meta.url))
const offline = process.argv.includes('--offline')

const app = await electron.launch({ args: [...(offline ? ['--host-resolver-rules=MAP * ~NOTFOUND'] : []), here + '/main.cjs'] })
const page = await app.firstWindow()
const consoleLines = []
const failed = []
page.on('requestfailed', (r) => failed.push(`${r.url().replace(/^.*\/dist\//, '').slice(0, 90)}: ${r.failure()?.errorText}`))
page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 220)}`))
page.on('pageerror', (e) => consoleLines.push(`pageerror: ${String(e.message).slice(0, 220)}`))
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 30000 })

const out = {}
const t0 = Date.now()
await page.evaluate(async () => {
  window.__c = await window.__load()
})
out.loadMs = Date.now() - t0

// 1. The agent's skeleton becomes full elements.
out.convert = await page.evaluate(() => {
  const els = window.__c.convert(window.__c.SKELETON)
  window.__els = els
  const arrows = els.filter((e) => e.type === 'arrow')
  return { count: els.length, types: els.map((e) => e.type), boundArrows: arrows.filter((a) => a.startBinding && a.endBinding).length }
})

// 2. The editor, in the page, under the policy.
await page.evaluate(() => window.__c.mount(document.getElementById('root'), window.__els))
await page.waitForSelector('.excalidraw canvas', { timeout: 30000 })
await page.waitForTimeout(2500)
out.editor = await page.evaluate(() => ({
  canvases: document.querySelectorAll('.excalidraw canvas').length,
  toolbar: !!document.querySelector('.App-toolbar'),
  fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family)
}))
await page.screenshot({ path: here + '/editor.png' })

// 3. Export: SVG and PNG and the scene's JSON, the three things the app sends back to the assistant.
out.exports = await page.evaluate(async () => {
  const svg = await window.__c.exportSvg(window.__els)
  const png = await window.__c.exportPng(window.__els)
  const json = window.__c.sceneJson(window.__els)
  return { svgBytes: svg.length, svgHasText: /Browser/.test(svg), svgHasFontFace: /@font-face/.test(svg), svgFontData: /src:\s*url\(["']?data:/.test(svg) || /url\(data:/.test(svg), png, jsonBytes: json.length }
}).catch((e) => ({ error: String(e.message).slice(0, 300) }))

// 4. A hostile scene, with and without the filter the app would apply first.
out.hostile = await page.evaluate(async () => {
  const all = window.__c.convert(window.__c.HOSTILE)
  const kept = window.__c.clean(all)
  return { before: all.map((e) => e.type), after: kept.map((e) => e.type), linksAfter: kept.filter((e) => e.link).length }
})
await page.evaluate(() => window.__c.mount(document.getElementById('root'), window.__c.convert(window.__c.HOSTILE)))
await page.waitForTimeout(2500)
out.hostileRaw = await page.evaluate(() => ({ iframes: document.querySelectorAll('iframe').length, pwned: window.__pwned ?? null }))
await page.evaluate(() => window.__c.mount(document.getElementById('root'), window.__c.clean(window.__c.convert(window.__c.HOSTILE))))
await page.waitForTimeout(1500)
out.hostileCleaned = await page.evaluate(() => ({ iframes: document.querySelectorAll('iframe').length, pwned: window.__pwned ?? null }))

// 5. Idle for a while, then what was blocked and what would have gone out.
await page.evaluate(() => window.__c.mount(document.getElementById('root'), window.__els))
await page.waitForTimeout(4000)
out.fontRequests = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /font|woff/i.test(e.name)).map((e) => e.name.replace(/^.*\/dist\//, '').slice(0, 90)))
out.failed = failed
out.violations = [...new Set(await page.evaluate(() => window.__violations))]
out.errors = await page.evaluate(() => window.__errors)
out.requestsOutsideTheApp = await app.evaluate(() => global.requests)
console.log(JSON.stringify(out, null, 2))
console.log('console:', consoleLines.slice(0, 12))
await app.close()
