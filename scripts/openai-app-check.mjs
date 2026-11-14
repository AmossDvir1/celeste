// OpenAI in the real built app, with the real Codex program, against a stand-in for OpenAI's API on this computer
// (src/core/adapters/openai/fake-openai.ts): no account and no quota. It pastes an API key, sees Codex's own models, runs a
// conversation, restarts and picks it up, disconnects, and force-quits in the middle of an answer.
//   npm run verify:openai-app
// Needs Codex downloaded once: `npm run verify:openai` does it, into scripts/.output/codex (or set CELESTE_CODEX_PROGRAM).
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeChatgptAuth } from '../src/core/adapters/openai/fake-chatgpt-auth.ts'
import { FakeOpenAi } from '../src/core/adapters/openai/fake-openai.ts'
import { launch, root, saveSettings } from './lib/app.mjs'
import { openKeyField } from './lib/stub.mjs'

/** The Codex program `npm run verify:openai` downloaded, found by its place inside the package. */
function downloadedCodex() {
  const runtimes = join(root, 'scripts', '.output', 'codex', 'runtimes')
  if (!existsSync(runtimes)) return undefined
  for (const dir of readdirSync(runtimes)) {
    const vendor = join(runtimes, dir, 'vendor')
    if (!existsSync(vendor)) continue
    for (const target of readdirSync(vendor)) {
      const file = join(vendor, target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
      if (existsSync(file)) return file
    }
  }
  return undefined
}

const program = process.env.CELESTE_CODEX_PROGRAM ?? downloadedCodex()
if (!program) {
  console.log('Codex is not downloaded yet. Run `npm run verify:openai` first (it downloads it once), or set CELESTE_CODEX_PROGRAM.')
  process.exit(0)
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-openai-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const KEY = 'sk-openai-key-for-the-test-1234'

const api = new FakeOpenAi((r) => {
  if (r.last.kind === 'text' && r.last.text.includes('HOLD')) return [{ type: 'hold' }]
  return [{ type: 'text', text: r.last.kind === 'text' ? `Echo: ${r.last.text}` : 'Finished' }]
})
await api.start()
const signin = new FakeChatgptAuth()
await signin.start()

let app
const open = () => launch({ width: 1440, height: 900, theme: null, profile, env: { CELESTE_CODEX_PROGRAM: program, CELESTE_OPENAI_BASE_URL: api.url, CELESTE_OPENAI_ISSUER: signin.url } })
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 90_000 })
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })
const pageText = (page) => page.evaluate(() => document.body.innerText)
const sentBefore = (word) => JSON.stringify(api.requests.at(-1)?.body.input ?? []).includes(word)
const card = (page) => page.getByRole('heading', { name: 'OpenAI Codex', exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
const pickModel = async (page) => {
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  // Codex's own list arrives a moment after the program starts.
  for (let i = 0; i < 100 && (await page.getByRole('menuitemradio', { name: /^GPT/ }).count()) === 0; i++) await page.waitForTimeout(300)
  await page.getByRole('menuitemradio', { name: /^GPT/ }).first().click()
}

try {
  console.log('\n# Connecting with an API key')
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  const status = await page.evaluate(() => window.celeste.core.call('vendor.status', ['openai']))
  check(`Core finds nobody signed in to OpenAI (${status.state})`, status.state === 'signed-out', JSON.stringify(status))
  check('the card offers "Continue with ChatGPT" and no "Coming soon"', (await card(page).getByRole('button', { name: 'Continue with ChatGPT' }).count()) === 1 && (await card(page).getByText('Coming soon').count()) === 0)

  api.rejectKeys = true
  await openKeyField(card(page))
  await card(page).getByLabel(/API key/).fill(KEY)
  await card(page).getByRole('button', { name: 'Save key' }).click()
  await card(page).getByRole('alert').waitFor({ timeout: 60_000 })
  check('a key OpenAI refuses is not kept, and the card says so', /did not accept/.test(await card(page).getByRole('alert').innerText()) && (await page.evaluate(() => window.celeste.secrets.has('vendor.openai.key'))) === false)
  api.rejectKeys = false
  await card(page).getByLabel(/API key/).fill(KEY)
  await card(page).getByRole('button', { name: 'Save key' }).click()
  await card(page).getByText(/Connected · API key ending 1234/).waitFor({ timeout: 60_000 })
  check('the card shows the key as connected, by its last four characters', true)
  await page.keyboard.press('Escape')

  console.log('\n# Codex\'s own models')
  await page.getByRole('button', { name: 'New chat' }).click()
  await pickModel(page)
  const label = await page.getByRole('button', { name: /^Model:/ }).first().getAttribute('aria-label')
  check(`the model menu lists Codex's own models, and one is chosen (${label})`, /^Model: GPT/.test(label ?? '') || /OpenAI/.test(label ?? ''), label ?? '')

  console.log('\n# A conversation')
  await textbox(page).fill('Say the word pong')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('the answer arrives and the turn ends', (await pageText(page)).includes('Echo: Say the word pong'))
  const boot = await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))
  const mine = boot.sessions.find((s) => s.title.startsWith('Say the word pong'))
  check('the session is an OpenAI session with the chosen model', mine?.vendor === 'openai' && /gpt/i.test(mine.model), JSON.stringify(mine))
  check('OpenAI received the key as the bearer token, and the person\'s message', api.requests.at(-1)?.authorization === `Bearer ${KEY}` && sentBefore('Say the word pong'))
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
  check('Codex continues the same conversation: it was sent what was said before the restart', sentBefore('Say the word pong'))
  check('and nothing says the conversation had to be rebuilt', !/no longer had this conversation/i.test(await pageText(page)))

  console.log('\n# Disconnecting')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await card(page).getByRole('button', { name: 'Disconnect' }).click()
  await card(page).getByRole('button', { name: 'Continue with ChatGPT' }).waitFor({ timeout: 15_000 })
  check('the card goes back to offering the sign-in', true)
  check('and the pasted key is gone from the secret store', (await page.evaluate(() => window.celeste.secrets.has('vendor.openai.key'))) === false)
  const after = await page.evaluate(() => window.celeste.core.call('vendor.status', ['openai']))
  check('Core agrees nobody is signed in', after.state === 'signed-out', JSON.stringify(after))
  await page.keyboard.press('Escape')

  console.log('\n# Continue with ChatGPT')
  // The sign-in page would open in the person's own browser. Here the address is caught instead, and the test plays the browser.
  await app.app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => void globalThis.__opened.push(url)
  })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await card(page).getByRole('button', { name: 'Continue with ChatGPT' }).click()
  await card(page).getByText(/Finish signing in in your browser/).waitFor({ timeout: 30_000 })
  let opened
  for (let i = 0; i < 60 && !opened; i++) {
    opened = (await app.app.evaluate(() => globalThis.__opened)).find((u) => u.startsWith(`${signin.url}/api/accounts/authorize`))
    if (!opened) await page.waitForTimeout(250)
  }
  check('the browser is sent to OpenAI’s sign-in page with Celeste’s loopback address', Boolean(opened) && /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fauth%2Fcallback/.test(opened ?? ''), opened)
  const answered = await fetch(signin.visit(opened))
  check('the loopback listener answers the browser', answered.status === 200)
  await card(page).getByText(/Connected · ChatGPT · dana@example\.com/).waitFor({ timeout: 30_000 })
  check('the card shows the ChatGPT account', true)
  check('the sign-in is kept in the secret store, and the window cannot read it back', (await page.evaluate(() => window.celeste.secrets.has('vendor.openai.tokens'))) === true && (await page.evaluate(() => window.celeste.secrets.hint('vendor.openai.tokens'))) !== null)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  for (let i = 0; i < 100 && (await page.getByRole('menuitemradio', { name: /^Fake model/ }).count()) === 0; i++) await page.waitForTimeout(300)
  check('the model list is the one OpenAI says the plan may use', (await page.getByRole('menuitemradio', { name: /^Fake model/ }).count()) === 1)
  await page.getByRole('menuitemradio', { name: /^Fake model/ }).first().click()
  await textbox(page).fill('Hello on the plan')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('a conversation runs on the plan, with the access token as the bearer', (await pageText(page)).includes('Echo: Hello on the plan') && api.requests.at(-1)?.authorization === 'Bearer access-1', api.requests.at(-1)?.authorization)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  await card(page).getByRole('button', { name: 'Disconnect' }).click()
  await card(page).getByRole('button', { name: 'Continue with ChatGPT' }).waitFor({ timeout: 15_000 })
  for (let i = 0; i < 40 && signin.revoked.length === 0; i++) await page.waitForTimeout(250)
  check('signing out asks OpenAI to cancel the sign-in', signin.revoked[0]?.get('token') === 'refresh-0' && signin.revoked[0]?.get('client_id') === 'oaiapp_test_client', JSON.stringify([...(signin.revoked[0]?.entries() ?? [])]))
  for (let i = 0; i < 40 && (await page.evaluate(() => window.celeste.secrets.has('vendor.openai.tokens'))); i++) await page.waitForTimeout(250)
  check('and the sign-in is gone from the secret store', (await page.evaluate(() => window.celeste.secrets.has('vendor.openai.tokens'))) === false)
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
  await signin.stop()
}

if (failures.length) {
  console.log(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nAll checks passed.')
process.exit(0)
