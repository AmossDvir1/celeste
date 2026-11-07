// Phase 4 acceptance test, in the real built app, with the real GitHub Copilot of whoever is signed in on this
// computer: connect, see the account's real models, run a conversation, restart, and pick the conversation up
// where it was.   npm run verify:copilot
// It spends a few of that account's premium requests (two turns on a small model). It needs Copilot to be signed in
// already (run `copilot login` first); it never signs anyone in or out. Set CELESTE_LIVE_MODEL to use another model.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'

const MODEL = process.env.CELESTE_LIVE_MODEL ?? 'Haiku'
const profile = mkdtempSync(join(tmpdir(), 'celeste-copilot-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

let app
const open = () => launch({ width: 1440, height: 900, theme: null, profile, scripted: false })
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 120_000 })
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })
const pageText = (page) => page.evaluate(() => document.body.innerText)

try {
  console.log('\n# Connecting')
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('button', { name: /Analyze WFO logs/ }).first().waitFor({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  const status = await page.evaluate(() => window.celeste.core.call('vendor.status', ['copilot']))
  check(`Core finds Copilot signed in on this computer (${status.state})`, status.state === 'signed-in', 'run `copilot login` first')
  if (status.state !== 'signed-in') throw new Error('Copilot is not signed in on this computer')

  const card = page.getByRole('heading', { name: 'GitHub Copilot' }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
  await card.getByRole('button', { name: 'Connect', exact: true }).click()
  await card.getByText(/Connected · \S+/).waitFor({ timeout: 60_000 })
  const shown = await card.getByText(/Connected · \S+/).innerText()
  check(`the card shows the real account, not a made-up one (${shown})`, shown.includes(status.account) && !shown.includes('alex on GitHub'))
  await page.keyboard.press('Escape')

  console.log('\n# The real models')
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  const items = page.getByRole('menuitemradio')
  // The list comes from Copilot a moment after connecting, and the open menu fills in when it arrives.
  for (let i = 0; i < 50 && (await items.count()) <= 5; i++) await page.waitForTimeout(300)
  const count = await items.count()
  check(`the model menu lists Copilot's own models (${count})`, count > 5)
  check('it no longer lists the scripted Copilot names', (await page.getByRole('menuitemradio', { name: 'Copilot Auto', exact: true }).count()) === 0 && (await page.getByRole('menuitemradio', { name: 'Auto', exact: true }).count()) === 1)
  const cheap = page.getByRole('menuitemradio', { name: new RegExp(MODEL) }).first()
  check(`the model for this check is offered (${MODEL})`, (await cheap.count()) > 0)
  await cheap.click()

  console.log('\n# A conversation')
  await textbox(page).fill('Reply with exactly the one word: pong')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('the answer arrives and the turn ends', /pong/i.test(await pageText(page)))
  check('no error is shown', !/could not|not signed in|failed/i.test(await pageText(page).then((t) => t.split('\n').filter((l) => /^(Copilot|GitHub Copilot) /.test(l)).join(' '))))
  const list = await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))
  const mine = list.sessions.find((s) => s.title.startsWith('Reply with exactly'))
  check('the session is a Copilot session with the chosen model', mine?.vendor === 'copilot' && new RegExp(MODEL, 'i').test(mine.model), JSON.stringify(mine))
  await page.waitForTimeout(800)
  await app.close()

  console.log('\n# After a restart')
  app = await open()
  page = app.page
  await page.getByRole('button', { name: /Reply with exactly/ }).first().waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: /Reply with exactly/ }).first().click()
  check('the whole conversation is back, from Celeste\'s own log', /pong/i.test(await pageText(page)))
  await textbox(page).fill('Which word did I ask you to reply with? Answer with just that word.')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  const after = (await pageText(page)).split('Which word did I ask you')[1] ?? ''
  check('Copilot remembers what it was asked before the restart', /pong/i.test(after), after.slice(0, 200))
  check('and nothing says the conversation had to be rebuilt', !/no longer had this conversation/i.test(await pageText(page)))

  console.log('\n# A force-quit in the middle of an answer')
  await page.getByRole('button', { name: 'New chat' }).click()
  await textbox(page).fill('My codeword is plum. Now count from 1 to 60, one number per line, slowly, with a short remark after each.')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  // Wait until the answer has really started, so the crash cuts it in the middle.
  await page.waitForFunction(() => /\n?\s*1\b[\s\S]{0,80}\b2\b/.test(document.body.innerText) || /plum/i.test(document.body.innerText.split('count from 1 to 60')[1] ?? ''), undefined, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  check('the answer was still running when the app was killed', (await page.getByRole('button', { name: 'Stop' }).count()) === 1)
  await app.crash()

  app = await open()
  page = app.page
  await page.getByRole('button', { name: /My codeword is plum/ }).first().waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: /My codeword is plum/ }).first().click()
  await page.getByText('Celeste was closed while this was running', { exact: false }).waitFor({ timeout: 15_000 })
  check('the cut-off answer is marked, and the session is not stuck on working', (await page.getByRole('button', { name: 'Stop' }).count()) === 0)
  check('what had been written is still there', /count from 1 to 60/.test(await pageText(page)))
  await textbox(page).fill('What was my codeword? Answer with just that word.')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  const answer = (await pageText(page)).split('What was my codeword?')[1] ?? ''
  check('Copilot still knows the codeword it was given before the crash', /plum/i.test(answer), answer.slice(0, 200))
  check('without rebuilding the conversation', !/no longer had this conversation/i.test(await pageText(page)))
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
