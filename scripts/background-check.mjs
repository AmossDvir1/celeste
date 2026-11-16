// A command Claude starts in the background, in the real built app: the turn ends, a card follows the command, and when it ends the
// answer Claude Code gives on its own (it wakes the model itself) appears in the chat. Before this was fixed that answer was thrown away.
// npm run verify:background       (no account, no cost)
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-background-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

const marker = join(profile, 'finished.txt').replace(/\\/g, '/')
const stopMarker = join(profile, 'not-stopped.txt').replace(/\\/g, '/')
let stub
let started
try {
  stub = await startStub((r) => {
    const last = r.last
    if (last.kind === 'text' && last.text.includes('START')) {
      return [{ type: 'tool_use', name: 'Bash', input: { command: `node -e "setTimeout(()=>{require('fs').writeFileSync('${marker}','x');console.log('finished')},5000)"`, run_in_background: true, description: 'Wait five seconds' } }]
    }
    if (last.kind === 'text' && last.text.includes('LONG')) {
      return [{ type: 'tool_use', name: 'Bash', input: { command: `node -e "setTimeout(()=>{require('fs').writeFileSync('${stopMarker}','x')},12000)"`, run_in_background: true, description: 'Wait twelve seconds' } }]
    }
    if (last.kind === 'tool_result') return [{ type: 'text', text: 'Started it in the background.' }]
    // Anything else is Claude Code waking the model itself, with the news that the command ended.
    return [{ type: 'text', text: 'AFTERWARDS: the model was told the command ended.' }]
  })
  started = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  const { page } = started
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)

  console.log('\n# Starting it')
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('please START the long thing')
  await box.press('Enter')
  await page.getByText('Started it in the background.').first().waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 30_000 })
  check('the turn ends while the command is still going', true)
  check('a card says it is running in the background', (await page.getByText('Running in the background: Wait five seconds').count()) === 1)

  console.log('\n# When it ends')
  await page.getByText('AFTERWARDS', { exact: false }).first().waitFor({ timeout: 45_000 })
  check('the answer Claude gives on its own is shown in the chat', true)
  check('the card follows the command to its end', (await page.getByText('Running in the background: Wait five seconds').count()) === 0 && (await page.getByText(/completed/i).count()) > 0)
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 30_000 })
  check('the chat is idle again afterwards', (await page.getByRole('button', { name: 'Stop', exact: true }).count()) === 0)

  console.log('\n# Its output')
  await page.getByRole('button', { name: 'Show output' }).first().click()
  const shown = page.getByLabel('Output')
  await shown.waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => /finished/.test(document.querySelector('[aria-label="Output"]')?.textContent ?? ''), undefined, { timeout: 15_000 })
  check('Show output shows what the command wrote', /finished/.test((await shown.innerText()) ?? ''))
  await page.getByRole('button', { name: 'Hide output' }).first().click()
  check('and Hide output closes it', (await page.getByLabel('Output').count()) === 0)

  console.log('\n# The chat still works')
  await box.fill('another START please')
  await box.press('Enter')
  await page.getByText('Started it in the background.').nth(1).waitFor({ timeout: 60_000 })
  check('a second command in the same chat gets its own card', (await page.getByText(/Running in the background|completed/i).count()) >= 2)

  console.log('\n# Stopping one command')
  // The second command above has to be over first, so that the long one's card is the only one that can be stopped.
  await page.getByText('Running in the background: Wait five seconds').first().waitFor({ state: 'detached', timeout: 45_000 })
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 45_000 })
  await box.fill('a LONG one please')
  await box.press('Enter')
  await page.getByText('Wait twelve seconds', { exact: false }).first().waitFor({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 30_000 })
  check('a command that is still running already offers its output', (await page.locator('[title*="not-stopped"]').getByRole('button', { name: 'Show output' }).count()) === 1)
  await page.getByRole('button', { name: 'Stop this command' }).click()
  await page.getByRole('button', { name: 'Stop this command' }).waitFor({ state: 'detached', timeout: 30_000 })
  const cards = await page.locator('[title*="not-stopped"]').allInnerTexts()
  check('the card\'s Stop ends the command and the card says how it ended', cards.length === 1 && !/Running in the background/.test(cards[0]) && /Stopped: Wait twelve seconds/.test(cards[0]), cards.join(' | '))
  check('the command really was stopped: it did not run on to the end', await (async () => {
    await new Promise((r) => setTimeout(r, 14_000))
    return !existsSync(stopMarker)
  })())
  const stops = await page.getByRole('button', { name: /stop/i }).evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label') ?? ''}|${e.textContent}`))
  check('and the chat is idle again', (await page.getByRole('button', { name: 'Stop', exact: true }).count()) === 0, JSON.stringify(stops))
} catch (err) {
  console.error(err)
  failures.push('the script failed')
} finally {
  await started?.close().catch(() => undefined)
  await stub?.stop?.().catch(() => undefined)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* the program may still hold the folder */
  }
}

if (failures.length) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nAll passed')
