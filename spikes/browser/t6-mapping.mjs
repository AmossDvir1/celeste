import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright-core')
const electronPath = require('electron')
const child = spawn(electronPath, [import.meta.dirname, '--bridge', '--hidden'], { stdio: ['pipe', 'pipe', 'pipe'] })
let endpoint = '', port = 0
child.stdout.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) { if (l.startsWith('BRIDGE ')) endpoint = l.slice(7); else if (l.startsWith('READY ')) port = +l.slice(6) } })
child.stdin.on('error', () => {})
const until = async (f) => { const t = Date.now(); while (!f()) { if (Date.now() - t > 20000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)) } }
const out = {}
try {
  await until(() => endpoint && port)
  const browser = await chromium.connectOverCDP(endpoint)
  const ctx = browser.contexts()[0]
  const pagesBefore = ctx.pages().length
  const page = ctx.pages()[0]
  const cdp = await ctx.newCDPSession(page)
  const info = await cdp.send('Target.getTargetInfo')
  out.targetId = info.targetInfo.targetId
  out.pagesBefore = pagesBefore
  await new Promise((r) => setTimeout(r, 500))
  out.pagesAfter = ctx.pages().length
  await cdp.detach().catch((e) => (out.detachError = e.message))
  await new Promise((r) => setTimeout(r, 500))
  out.pagesAfterDetach = ctx.pages().length
  out.stillWorks = await page.title()
  await browser.close().catch(() => {})
} catch (e) { out.fatal = String(e.stack || e).split('\n').slice(0, 4).join(' | ') }
try { child.stdin.write('quit') } catch {}
await new Promise((r) => { child.on('exit', r); setTimeout(r, 4000) })
console.log(JSON.stringify(out, null, 2))
