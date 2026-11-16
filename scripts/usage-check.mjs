// How much of each vendor's allowance is used, in the real built app (docs/QUEUE_AND_USAGE_PLAN.md, Part 2): the strip above Settings, its
// popover, its colours and words, a reading that is old, one that could not be made, a vendor with nothing to show, and the keyboard.
// What each vendor reports is a file the check writes (CELESTE_USAGE_FILE) in place of Copilot's runtime and Claude's `/usage`, so every
// state can be drawn with no account.   npm run verify:usage     (no account, no cost)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-usage-'))
const file = join(profile, 'usage.json')
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const HOUR = 3_600_000
const win = (key, label, percentUsed, extra = {}) => ({ key, label, percentUsed, resetsAt: Date.now() + 3 * HOUR + 12 * 60_000, ...extra })
const write = (data) => writeFileSync(file, JSON.stringify(data))
const core = (page, method, ...params) => page.evaluate(([m, p]) => window.celeste.core.call(m, p), [method, params])

write({
  copilot: { plan: 'copilot_pro', windows: [win('premium_interactions', 'Premium requests', 42, { text: '126 of 300 used' })], note: 'Requests beyond the allowance are allowed, at pay-per-request rates.' },
  claude: { plan: 'max', windows: [win('five_hour', '5-hour session', 85), win('seven_day', '7-day', 30)] }
})

let stub
let app
try {
  stub = await startStub()
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: { ...stub.env, CELESTE_USAGE_FILE: file } })
  const { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)
  // Copilot is connected after Claude, so the chat's first choice stays Claude.
  await core(page, 'vendors.set', 'copilot', { account: 'octo', method: 'browser' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })

  const strip = page.getByRole('group', { name: 'Usage' })
  const row = (name) => strip.getByRole('button', { name: new RegExp(`^${name} usage`) })

  console.log('\n# The strip')
  await strip.waitFor({ timeout: 30_000 })
  check('there is one row for each connected vendor that has something to show', (await strip.getByRole('button').count()) === 2)
  check('each row has the vendor, a bar and the number', /Copilot/.test(await row('Copilot').innerText()) && /42%/.test(await row('Copilot').innerText()) && /85%/.test(await row('Claude').innerText()))
  const meter = row('Copilot').getByRole('meter')
  check('the bar is a meter with a value in words', (await meter.getAttribute('aria-valuenow')) === '42' && /42% used/.test((await meter.getAttribute('aria-valuetext')) ?? ''))
  check('a row says in its name what it shows, so colour is not the only signal', /Claude usage: 5-hour session, 85% used, getting low/.test((await row('Claude').getAttribute('aria-label')) ?? ''))
  const fill = (r) => r.getByRole('meter').locator('div').first()
  check('calm while there is room, amber from 80%', /bg-accent/.test((await fill(row('Copilot')).getAttribute('class')) ?? '') && /bg-warning/.test((await fill(row('Claude')).getAttribute('class')) ?? ''))
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'usage-strip.png') })

  console.log('\n# The details')
  await row('Copilot').click()
  const pop = page.getByRole('dialog', { name: 'GitHub Copilot usage' })
  await pop.waitFor({ timeout: 5000 })
  const text = await pop.innerText()
  check('the popover names the plan and the meter, with amounts and when it comes back', /GitHub Copilot/.test(text) && /copilot_pro/.test(text) && /Premium requests/.test(text) && /126 of 300 used/.test(text) && /Resets in 3 h 1[12] min/.test(text), text)
  check('and says when overage is allowed', /pay-per-request/.test(text))
  check('and when it was read', /Updated (just now|\d+ min ago)/.test(text))
  await page.screenshot({ path: join(import.meta.dirname, '.output', 'usage-popover.png') })
  await page.keyboard.press('Escape')
  check('Escape closes it', (await page.getByRole('dialog', { name: 'GitHub Copilot usage' }).count()) === 0)
  await row('Claude').focus()
  await page.keyboard.press('Enter')
  const claudePop = page.getByRole('dialog', { name: 'Claude Agent usage' })
  await claudePop.waitFor({ timeout: 5000 })
  const claudeText = await claudePop.innerText()
  check('the keyboard opens it, and every window the vendor gave is there with its own meter', /5-hour session/.test(claudeText) && /7-day/.test(claudeText) && (await claudePop.getByRole('meter').count()) === 2)
  await page.keyboard.press('Escape')

  console.log('\n# At the limit, and a refresh')
  write({
    copilot: { plan: 'copilot_pro', windows: [win('premium_interactions', 'Premium requests', 97, { text: '291 of 300 used' })] },
    claude: { plan: 'max', windows: [win('five_hour', '5-hour session', 85)] }
  })
  await row('Copilot').click()
  await page.getByRole('button', { name: 'Refresh the usage of GitHub Copilot' }).click()
  await page.getByText('291 of 300 used').waitFor({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  check('Refresh in the popover reads it again', /97%/.test(await row('Copilot').innerText()))
  check('from 95% the bar is red and the name says it is at the limit', /bg-danger/.test((await fill(row('Copilot')).getAttribute('class')) ?? '') && /at the limit/.test((await row('Copilot').getAttribute('aria-label')) ?? ''))

  console.log('\n# No limit, a vendor with nothing to show, and one that cannot be read')
  write({ copilot: { windows: [{ key: 'premium_interactions', label: 'Premium requests', percentUsed: null, resetsAt: null, unlimited: true, text: 'Unlimited' }] }, claude: null })
  await row('Copilot').click()
  await page.getByRole('button', { name: 'Refresh the usage of GitHub Copilot' }).click()
  await page.getByText('Nothing to run out of').waitFor({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  check('an unlimited allowance says so, with no bar', /Unlimited/.test(await row('Copilot').innerText()) && (await row('Copilot').getByRole('meter').count()) === 0)
  // Claude was not asked just now (only Copilot's Refresh was pressed). The window gaining focus asks every vendor.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await strip.getByRole('button', { name: /^Claude usage/ }).waitFor({ state: 'detached', timeout: 15_000 })
  check('the window gaining focus reads every vendor again, and one with nothing to show (an API key has no plan limits) has no row', (await strip.getByRole('button').count()) === 1)

  write({ copilot: { windows: [win('premium_interactions', 'Premium requests', 50)] }, fail: ['copilot'] })
  await row('Copilot').click()
  await page.getByRole('button', { name: 'Refresh the usage of GitHub Copilot' }).click()
  await page.getByText(/Could not update/).waitFor({ timeout: 15_000 })
  check('a reading that cannot be made keeps the last one and says it could not update', /Unlimited|—/.test(await row('Copilot').innerText()) && /not up to date/.test((await row('Copilot').getAttribute('aria-label')) ?? ''))
  await page.keyboard.press('Escape')

  console.log('\n# An old reading')
  write({ copilot: { windows: [win('premium_interactions', 'Premium requests', 60)], at: Date.now() - 40 * 60_000 } })
  await row('Copilot').click()
  await page.getByRole('button', { name: 'Refresh the usage of GitHub Copilot' }).click()
  await page.getByText(/Updated 4\d min ago/).waitFor({ timeout: 15_000 })
  check('a reading older than fifteen minutes is marked as not up to date', /not up to date/.test((await row('Copilot').getAttribute('aria-label')) ?? '') && /60%/.test(await row('Copilot').innerText()))
  await page.keyboard.press('Escape')

  console.log('\n# After a restart')
  write({ copilot: { windows: [win('premium_interactions', 'Premium requests', 61)] } })
  await app.close()
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: { ...stub.env, CELESTE_USAGE_FILE: file } })
  const p2 = app.page
  await p2.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 })
  await p2.getByRole('group', { name: 'Usage' }).getByRole('button', { name: /^Copilot usage/ }).waitFor({ timeout: 30_000 })
  check('the strip is there again with the vendor’s reading', /6\d%/.test(await p2.getByRole('group', { name: 'Usage' }).getByRole('button', { name: /^Copilot usage/ }).innerText()))
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'usage-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(profile, { recursive: true, force: true })
      break
    } catch {
      if (i === 19) console.warn(`Could not remove ${profile}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
