// Captures the key screens of the built app in both themes: npm run shots
// Output: scripts/.output/shots/<theme>-<screen>.png
// It is the real app. Claude is real too (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API
// on this computer (scripts/lib/stub.mjs), so the conversations below are written for the pictures and cost nothing.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { launch, root } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const out = resolve(root, 'scripts/.output/shots')
mkdirSync(out, { recursive: true })

const W = 1440
const H = 900

const ANSWER = `## What stands out

Three things in the last 24 hours, in order of impact:

| # | Signal | Count | When |
|---|---|---|---|
| 1 | \`KbInstallTimeout\` on the install step | 212 | 02:10 – 03:40 |
| 2 | \`ServiceNotReady\` after reboot | 87 | right after each timeout |
| 3 | Slow \`ListInstalledKbs\` (> 8 s) | 41 | all day, worse after 14:00 |

**The timeouts and the "not ready" errors are one problem.** Every \`ServiceNotReady\` follows a \`KbInstallTimeout\` within about 90 seconds, which is the reboot the installer triggers.

\`\`\`text
02:14:09 ERROR KbInstallTimeout host=wfo-vm-17 kb=KB5041585 waited=120s
02:15:31 ERROR ServiceNotReady host=wfo-vm-17 state=Starting
\`\`\`

### Suggested next steps

1. Raise the wait for the service to 240 s on hosts with the slow disk profile.
2. Add a \`Wait for service\` step with a health probe instead of a fixed delay.
3. Look at why \`ListInstalledKbs\` slows down after 14:00.
`

const FIX_OLD = '    await sleep(50)\n    expect(total.cents).toBe(4_250)'
const FIX_NEW = '    await waitFor(() => expect(pricing.pending()).toBe(false))\n    expect(total.cents).toBe(4_250)'

// The demo project's folder shows in the pictures, so it has a plain name. CELESTE_SHOTS_ROOT picks where it is made.
const scratch = mkdtempSync(join(process.env['CELESTE_SHOTS_ROOT'] ?? tmpdir(), 'celeste-shots-'))
const project = join(scratch, 'shop-web')
mkdirSync(project)
const spec = `it('applies the discount after tax', async () => {\n  const total = checkout(cart)\n${FIX_OLD}\n})\n`
writeFileSync(join(project, 'checkout.spec.ts'), spec)
for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'add', '.'], ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-q', '-m', 'Add the checkout spec']]) {
  execFileSync('git', ['-C', project, ...args])
}

// A small web page for the assistant to open in the browser picture.
const PRICING = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Acme pricing</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #f6f7fb; color: #1b2133 }
  header { display: flex; justify-content: space-between; align-items: center; padding: 18px 36px; background: #fff; border-bottom: 1px solid #e3e6ef }
  header b { font-size: 18px; letter-spacing: -.01em } header span { color: #6b7490; font-size: 14px }
  main { max-width: 760px; margin: 0 auto; padding: 44px 24px }
  h1 { font-size: 30px; letter-spacing: -.02em; margin: 0 0 6px } p.lead { color: #6b7490; margin: 0 0 30px }
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px }
  .plan { background: #fff; border: 1px solid #e3e6ef; border-radius: 14px; padding: 22px }
  .plan.pick { border-color: #f5487f; box-shadow: 0 6px 24px #f5487f22 }
  .plan h2 { font-size: 16px; margin: 0 0 4px } .price { font-size: 30px; font-weight: 650; letter-spacing: -.02em } .price small { font-size: 13px; color: #6b7490; font-weight: 400 }
  ul { padding-left: 18px; color: #4a5372; margin: 14px 0 0 }
</style>
<header><b>Acme</b><span>Pricing · Docs · Sign in</span></header>
<main><h1>Simple, honest pricing</h1><p class="lead">Every plan includes unlimited projects. Pay yearly and save two months.</p>
<div class="plans">
  <div class="plan"><h2>Solo</h2><div class="price">$0 <small>forever</small></div><ul><li>1 user</li><li>Community support</li></ul></div>
  <div class="plan pick"><h2>Team</h2><div class="price">$12 <small>per user / month</small></div><ul><li>Unlimited users</li><li>Shared workspaces</li><li>Email support</li></ul></div>
  <div class="plan"><h2>Business</h2><div class="price">$29 <small>per user / month</small></div><ul><li>Single sign-on</li><li>Audit log</li><li>Priority support</li></ul></div>
</div></main></html>`
const pricing = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(PRICING)
})
await new Promise((r) => pricing.listen(0, '127.0.0.1', r))
const pricingUrl = `http://127.0.0.1:${pricing.address().port}/pricing`

const stub = await startStub((r) => {
  if (r.last.kind === 'tool_result' && /Opened tab/.test(r.last.text)) return [{ type: 'text', text: 'The **Team** plan is $12 per user a month, and the **Business** plan is $29. There is also a free Solo plan for one person. Paying yearly saves two months.' }]
  if (r.last.kind === 'text' && /pricing page/i.test(r.last.text)) return [{ type: 'tool_use', name: 'mcp__celeste-devices__browser_navigate', input: { url: pricingUrl } }]
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: r.last.isError ? `That did not work: ${r.last.text}` : 'The flaky test was racing the pricing service. I replaced the fixed `sleep(50)` with a wait on the real condition, so it no longer depends on timing.' }]
  if (/logs/i.test(r.last.text)) return [{ type: 'text', text: ANSWER }]
  if (/flaky/i.test(r.last.text)) return [{ type: 'tool_use', name: 'Edit', input: { file_path: join(project, 'checkout.spec.ts'), old_string: FIX_OLD, new_string: FIX_NEW } }]
  return [{ type: 'text', text: 'Happy to help. What would you like to start with?' }]
})

for (const theme of ['dark', 'light']) {
  // The fix is applied for real, so the file is put back for each theme.
  writeFileSync(join(project, 'checkout.spec.ts'), spec)
  const { app, page, close } = await launch({ width: W, height: H, theme, env: stub.env })
  const snap = async (name) => {
    await page.waitForTimeout(450)
    await page.screenshot({ path: resolve(out, `${theme}-${name}.png`) })
    console.log(`${theme}-${name}`)
  }
  const tab = (label) => page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: label }).click()
  const send = async (text, until) => {
    await page.getByRole('textbox', { name: 'Message' }).fill(text)
    await page.getByRole('textbox', { name: 'Message' }).press('Enter')
    await page.getByText(until, { exact: false }).first().waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
  }

  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await page.getByLabel('What should we call you?').fill('Alex')
  await snap('wizard-welcome')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light' }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await pasteClaudeKey(page)
  await page.waitForTimeout(300)
  await snap('wizard-connect')
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await claudeReady(page)
  await snap('chat-home')

  await send('Analyze the WFO logs from last night', 'What stands out')
  await snap('chat-conversation')

  // The assistant opens a page in the browser beside the chat. The page is a native layer that a window screenshot does not hold,
  // so its own picture is laid over the window's, where the page sits.
  await page.getByRole('button', { name: 'New chat' }).click()
  await send('Look at the pricing page for me', 'Team plan')
  await page.getByRole('region', { name: 'Browser' }).waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  const window_ = PNG.sync.read(await page.screenshot())
  const grabbed = await app.evaluate(async ({ BrowserWindow, webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))
    const v = wc && BrowserWindow.getAllWindows()[0]?.contentView.children.find((c) => c.webContents === wc)
    if (!wc || !v) return null
    return { bounds: v.getBounds(), png: (await wc.capturePage()).toPNG().toString('base64') }
  })
  if (grabbed) {
    const shot = PNG.sync.read(Buffer.from(grabbed.png, 'base64'))
    PNG.bitblt(shot, window_, 0, 0, Math.min(shot.width, grabbed.bounds.width), Math.min(shot.height, grabbed.bounds.height), grabbed.bounds.x, grabbed.bounds.y)
  }
  writeFileSync(resolve(out, `${theme}-browser.png`), PNG.sync.write(window_))
  console.log(`${theme}-browser${grabbed ? '' : ' (without the page)'}`)
  await page.getByRole('button', { name: 'Close browser' }).click()

  await page.getByRole('button', { name: 'New chat' }).click()
  await page.locator('input[type=file]').first().setInputFiles([{ name: 'dashboard-mockup.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }])
  await page.waitForTimeout(400)
  await snap('attachments')

  await tab('Develop')
  // The folder picker is the system's own dialog, so it is answered here.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  // With no recent projects the button opens the folder window straight away: there is no menu to go through.
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  await page.getByRole('button', { name: /^Branch: main/ }).waitFor({ timeout: 10_000 }).catch(() => undefined)
  await snap('develop-home')
  await send('Fix the flaky checkout test', 'racing the pricing service')
  await page.getByRole('button', { name: 'Changes' }).click()
  // The panel reads the folder first: the picture is taken once the files are listed.
  await page.getByText('Looking at the folder').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  await snap('develop-diffs')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await snap('settings-vendors')

  await close()
}
await stub.stop().catch(() => undefined)
pricing.close()
rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
console.log(`\nSaved to ${out}`)
