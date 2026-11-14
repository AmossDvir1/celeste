// Gemini in the real built app, with the real Gemini CLI, against a stand-in for Google's API on this computer
// (src/core/adapters/gemini/fake-gemini.ts): no account, no key, no quota. It follows "Get a free key", pastes a key, sees Gemini's
// own models, runs a conversation, restarts and picks it up, disconnects, and force-quits in the middle of an answer.
//   npm run verify:gemini-app
// Needs the Gemini CLI downloaded once: `npm run verify:gemini` does it, into scripts/.output/gemini (or set CELESTE_GEMINI_PROGRAM).
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeGemini } from '../src/core/adapters/gemini/fake-gemini.ts'
import { launch, root, saveSettings } from './lib/app.mjs'
import { openKeyField } from './lib/stub.mjs'

/** The Gemini CLI that `npm run verify:gemini` downloaded, found by its place inside the package. */
function downloadedGemini() {
  const runtimes = join(root, 'scripts', '.output', 'gemini', 'runtimes')
  if (!existsSync(runtimes)) return undefined
  for (const dir of readdirSync(runtimes)) {
    const file = join(runtimes, dir, 'bundle', 'gemini.js')
    if (existsSync(file)) return file
  }
  return undefined
}

const program = process.env.CELESTE_GEMINI_PROGRAM ?? downloadedGemini()
if (!program) {
  console.log('The Gemini CLI is not downloaded yet. Run `npm run verify:gemini` first (it downloads it once), or set CELESTE_GEMINI_PROGRAM.')
  process.exit(0)
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-gemini-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const KEY = 'AIza-gemini-key-for-the-test-1234'

const api = new FakeGemini((r) => {
  if (r.last.kind === 'text' && r.last.text.includes('HOLD')) return [{ type: 'hold' }]
  return [{ type: 'text', text: r.last.kind === 'text' ? `Echo: ${r.last.text}` : 'Finished' }]
})
await api.start()

let app
const open = () => launch({ width: 1440, height: 900, theme: null, profile, env: { CELESTE_GEMINI_PROGRAM: program, CELESTE_GEMINI_BASE_URL: api.url } })
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 90_000 })
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })
const pageText = (page) => page.evaluate(() => document.body.innerText)
const sentBefore = (word) => JSON.stringify(api.requests.at(-1)?.body.contents ?? []).includes(word)
const card = (page) => page.getByRole('heading', { name: 'Google Gemini', exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
const pickModel = async (page) => {
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  // A named model: Auto makes the program ask the model about the task first, which a stand-in cannot answer.
  for (let i = 0; i < 100 && (await page.getByRole('menuitemradio', { name: /^Gemini 3 Flash/ }).count()) === 0; i++) await page.waitForTimeout(300)
  await page.getByRole('menuitemradio', { name: /^Gemini 3 Flash/ }).first().click()
}

try {
  console.log('\n# Getting a key and connecting')
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  // The page where the key is made would open in the person's own browser. Here the address is caught instead.
  await app.app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => void globalThis.__opened.push(url)
  })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  const status = await page.evaluate(() => window.celeste.core.call('vendor.status', ['gemini']))
  check(`Core finds nobody connected to Gemini (${status.state})`, status.state === 'signed-out' || status.state === 'runtime-missing', JSON.stringify(status))
  check('the card offers "Get a free key" and no "Coming soon"', (await card(page).getByRole('button', { name: 'Get a free key' }).count()) === 1 && (await card(page).getByText('Coming soon').count()) === 0)

  await card(page).getByRole('button', { name: 'Get a free key' }).click()
  await card(page).getByLabel(/API key/).waitFor({ timeout: 15_000 })
  const opened = await app.app.evaluate(() => globalThis.__opened)
  check('the main button opens Google AI Studio’s key page and the field for the key together', opened.some((u) => u.startsWith('https://aistudio.google.com/apikey')), JSON.stringify(opened))

  api.rejectKeys = true
  await card(page).getByLabel(/API key/).fill(KEY)
  await card(page).getByRole('button', { name: 'Save key' }).click()
  await card(page).getByRole('alert').waitFor({ timeout: 90_000 })
  check('a key Google refuses is not kept, and the card says so', /did not accept/.test(await card(page).getByRole('alert').innerText()) && (await page.evaluate(() => window.celeste.secrets.has('vendor.gemini.key'))) === false)
  api.rejectKeys = false
  await card(page).getByLabel(/API key/).fill(KEY)
  await card(page).getByRole('button', { name: 'Save key' }).click()
  await card(page).getByText(/Connected · API key ending 1234/).waitFor({ timeout: 60_000 })
  check('the card shows the key as connected, by its last four characters', true)
  await page.keyboard.press('Escape')

  console.log('\n# Gemini\'s own models')
  await page.getByRole('button', { name: 'New chat' }).click()
  await pickModel(page)
  const label = await page.getByRole('button', { name: /^Model:/ }).first().getAttribute('aria-label')
  check(`the model menu lists Gemini's own models, and one is chosen (${label})`, /Gemini 3 Flash/.test(label ?? ''), label ?? '')

  console.log('\n# A conversation')
  await textbox(page).fill('Say the word pong')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('the answer arrives and the turn ends', (await pageText(page)).includes('Echo: Say the word pong'))
  const boot = await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))
  const mine = boot.sessions.find((s) => s.title.startsWith('Say the word pong'))
  check('the session is a Gemini session with the chosen model', mine?.vendor === 'gemini' && /gemini-3-flash/i.test(mine.model), JSON.stringify(mine))
  check('Google received the key, and the person\'s message', api.requests.at(-1)?.key === KEY && sentBefore('Say the word pong'))
  await page.waitForTimeout(800)
  await app.close()

  console.log('\n# After a restart')
  app = await open()
  page = app.page
  await page.getByRole('button', { name: /Say the word pong/ }).first().waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: /Say the word pong/ }).first().click()
  await page.getByText('Echo: Say the word pong', { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => undefined)
  check('the whole conversation is back, from Celeste\'s own log', (await pageText(page)).includes('Echo: Say the word pong'))
  await textbox(page).fill('And again')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('Gemini continues the same conversation: it was sent what was said before the restart', sentBefore('Say the word pong'))
  check('and nothing says the conversation had to be rebuilt', !/no longer had this conversation/i.test(await pageText(page)))
  check('and the old turns were not shown a second time', (await pageText(page)).split('Echo: Say the word pong').length === 2)

  console.log('\n# Disconnecting')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await card(page).getByRole('button', { name: 'Disconnect' }).click()
  await card(page).getByRole('button', { name: 'Get a free key' }).waitFor({ timeout: 15_000 })
  check('the card goes back to offering a key', true)
  check('and the pasted key is gone from the secret store', (await page.evaluate(() => window.celeste.secrets.has('vendor.gemini.key'))) === false)
  const after = await page.evaluate(() => window.celeste.core.call('vendor.status', ['gemini']))
  check('Core agrees nobody is connected', after.state === 'signed-out', JSON.stringify(after))
  await page.keyboard.press('Escape')

  console.log('\n# A force-quit in the middle of an answer')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await openKeyField(card(page))
  await card(page).getByLabel(/API key/).fill(KEY)
  await card(page).getByRole('button', { name: 'Save key' }).click()
  await card(page).getByText(/Connected · API key ending 1234/).waitFor({ timeout: 60_000 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'New chat' }).click()
  await pickModel(page)
  await textbox(page).fill('HOLD this answer, my codeword is plum')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await page.getByText('Working on it').first().waitFor({ timeout: 60_000 })
  check('the answer was still running when the app was killed', (await page.getByRole('button', { name: 'Stop' }).count()) === 1)
  await app.crash()

  app = await open()
  page = app.page
  await page.getByRole('button', { name: /HOLD this answer/ }).first().waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: /HOLD this answer/ }).first().click()
  await page.getByText('Celeste was closed while this was running', { exact: false }).waitFor({ timeout: 15_000 })
  check('the cut-off answer is marked, and the session is not stuck on working', (await page.getByRole('button', { name: 'Stop' }).count()) === 0)
} finally {
  await app?.close().catch(() => undefined)
  await api.stop()
}

if (failures.length) {
  console.log(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nAll checks passed.')
process.exit(0)
