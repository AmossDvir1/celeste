// Copilot's sign-in screens, in the real built app, with a Copilot that knows no one: it has a data folder of its own,
// so the sign-in on this computer is never touched, and the browser is not really opened. No account and no quota
// are needed.   npm run verify:copilot  (runs this after the check that uses the real account)
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-copilot-stranger-'))
const shots = join(import.meta.dirname, '.output', 'shots')
mkdirSync(shots, { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })

let app
try {
  console.log('\n# Signing in (with a Copilot that knows no one)')
  app = await launch({ width: 1440, height: 900, theme: null, profile, scripted: false, copilotKnowsNoOne: true })
  const { page } = app
  // The browser is never really opened: the app's attempts to open an address are written down instead.
  await app.app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => void globalThis.__opened.push(url)
  })
  const opened = () => app.app.evaluate(() => globalThis.__opened)

  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true })
  await page.reload()
  await page.getByRole('button', { name: /Analyze WFO logs/ }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  check('Core says nobody is signed in', (await page.evaluate(() => window.celeste.core.call('vendor.status', ['copilot']))).state === 'signed-out')
  const card = page.getByRole('heading', { name: 'GitHub Copilot' }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
  check('nothing is pretended to be connected', (await card.getByText(/^Connected/).count()) === 0)

  await card.getByRole('button', { name: 'Connect', exact: true }).click()
  await card.getByText('Finish signing in in your browser…').waitFor({ timeout: 60_000 })
  check('the card asks the person to finish in the browser', true)
  await page.waitForTimeout(300)
  check("GitHub's sign-in page was opened", (await opened())[0]?.startsWith('https://github.com/login/oauth/authorize?') === true, JSON.stringify(await opened()))
  check('the card offers to open it again and to use a code', (await card.getByRole('button', { name: 'Open the sign-in page again' }).count()) === 1 && (await card.getByRole('button', { name: 'Use a code instead' }).count()) === 1)
  await page.screenshot({ path: join(shots, 'copilot-signin-browser.png') })

  await card.getByRole('button', { name: 'Use a code instead' }).click()
  const code = card.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  await code.waitFor({ timeout: 60_000 })
  check('a code to type is shown, with a button for the page to type it on', (await card.getByRole('button', { name: 'Open GitHub' }).count()) === 1)
  check('the page for the code was opened', (await opened()).includes('https://github.com/login/device'), JSON.stringify(await opened()))
  await page.screenshot({ path: join(shots, 'copilot-signin-code.png') })

  await card.getByRole('button', { name: 'Cancel' }).click()
  await card.getByRole('button', { name: 'Connect', exact: true }).waitFor({ timeout: 10_000 })
  check('Cancel goes back to Connect, with no code left on screen', (await code.count()) === 0)
  check('nothing but GitHub was opened', (await opened()).every((u) => new URL(u).hostname === 'github.com'))
  check('and Core still says nobody is signed in', (await page.evaluate(() => window.celeste.core.call('vendor.status', ['copilot']))).state === 'signed-out')
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  await app?.close().catch(() => undefined)
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    console.warn(`Could not remove ${profile}`)
  }
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
