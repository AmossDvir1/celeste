// Captures the key screens of the built app in both themes: npm run shots
// Output: scripts/.output/shots/<theme>-<screen>.png
// It is the real app. Claude is real too (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API
// on this computer (scripts/lib/stub.mjs), so the conversations below are written for the pictures and cost nothing.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const stub = await startStub((r) => {
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
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await pasteClaudeKey(page)
  await page.waitForTimeout(300)
  await snap('wizard-connect')
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await claudeReady(page)
  await snap('chat-home')

  await send('Analyze the WFO logs from last night', 'What stands out')
  await snap('chat-conversation')

  await page.getByRole('button', { name: 'New chat' }).click()
  await page.locator('input[type=file]').first().setInputFiles([{ name: 'dashboard-mockup.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') }])
  await page.waitForTimeout(400)
  await snap('attachments')

  await tab('Develop')
  // The folder picker is the system's own dialog, so it is answered here.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  await page.getByRole('menuitem', { name: /Choose another folder/ }).click()
  await page.getByRole('button', { name: /^Branch: main/ }).waitFor({ timeout: 10_000 }).catch(() => undefined)
  await snap('develop-home')
  await send('Fix the flaky checkout test', 'racing the pricing service')
  await page.getByRole('button', { name: 'Changes' }).click()
  await snap('develop-diffs')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await snap('settings-vendors')

  await close()
}
await stub.stop().catch(() => undefined)
rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
console.log(`\nSaved to ${out}`)
