// SPIKE (15 November 2026), not a check: what Celeste itself does today when Claude starts a background command and the turn ends.
// Result: the command runs and the turn ends, but the CLI's own follow-up turn is dropped (translate.ts ignores messages while ended). Run: node scripts/spikes/background-app.mjs [folder for screenshots]
// What Celeste itself does today when Claude starts a background command and the turn ends.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from '../lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from '../lib/stub.mjs'

const out = process.argv[2] ?? tmpdir()
const marker = join(tmpdir(), 'celeste-bg-marker.txt').replace(/\\/g, '/')
const stub = await startStub((r) => {
  const last = r.last
  if (last.kind === 'text' && last.text.includes('START')) return [{ type: 'tool_use', name: 'Bash', input: { command: `node -e "setTimeout(()=>{require('fs').writeFileSync('${marker}','x');console.log('finished')},6000)"`, run_in_background: true, description: 'wait six seconds' } }]
  if (last.kind === 'tool_result') return [{ type: 'text', text: 'Started it in the background.' }]
  return [{ type: 'text', text: `AFTERWARDS: the model was woken with: ${JSON.stringify(last).slice(0, 300)}` }]
})
const a = await launch({ width: 1440, height: 900, theme: null, profile: mkdtempSync(join(tmpdir(), 'celeste-bg-')), env: stub.env })
const { page } = a
const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'
await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20000 })
await saveSettings(page, { wizardDone: true, userName: 'Dana' })
await page.reload()
await page.getByRole('heading', { level: 1 }).first().waitFor()
await page.getByRole('button', { name: 'Settings', exact: true }).click()
await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
await pasteClaudeKey(page); await page.keyboard.press('Escape'); await claudeReady(page)

const box = page.getByRole('textbox', { name: 'Message' })
await box.fill('please START the long thing')
await box.press('Enter')
await page.getByText('Started it in the background.').first().waitFor({ timeout: 60000 })
console.log(at(), 'turn ended; status button Stop present?', await page.getByRole('button', { name: 'Stop' }).count())
await page.screenshot({ path: `${out}/bg-1.png` })
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1500))
  const stop = await page.getByRole('button', { name: 'Stop' }).count()
  const woke = await page.getByText('AFTERWARDS', { exact: false }).count()
  console.log(at(), 'Stop buttons:', stop, '| woken answer on screen:', woke)
  if (woke) break
}
await page.screenshot({ path: `${out}/bg-2.png` })
const text = await page.evaluate(() => document.body.innerText)
console.log('--- page text (tail) ---\n' + text.slice(-700))
await a.close(); await stub.stop?.()
