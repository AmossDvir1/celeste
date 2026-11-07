// Phase 2 acceptance test: after closing and reopening, every session, draft and setting is intact,
// and a crash loses nothing that was recorded. Runs the real built app three times on one profile.
//   npm run verify:persistence
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launch } from './lib/app.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-persist-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

// A valid 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const open = () => launch({ width: 1440, height: 900, theme: null, profile })
const row = (page, name) => page.locator('div.group').filter({ has: page.getByRole('button', { name }) })
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const ready = (page) => page.getByRole('button', { name: /Analyze WFO logs/ }).first().waitFor({ timeout: 20_000 })

async function rowMenu(page, rowName, item) {
  const r = row(page, rowName)
  // The sample sessions are dated by the time of day, so shortly after midnight more of them fall under "Show more".
  if ((await r.count()) === 0) await page.getByRole('button', { name: 'Show more' }).first().click()
  await r.hover()
  await r.getByRole('button', { name: /More actions/ }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

let app
try {
  // ---- First run ------------------------------------------------------------------------------------
  console.log('\n# First run')
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  check('the setup wizard opens on a new profile', true)
  await page.getByLabel('What should we call you?').fill('Dana')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('radio', { name: 'Light' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await ready(page)
  check('the sample sessions are in the sidebar', await page.getByRole('button', { name: /Plan KB update/ }).count() > 0)

  await textbox(page).fill('Summarize the revenue spreadsheet please')
  await textbox(page).press('Enter')
  await page.getByText('go through the plan first', { exact: false }).waitFor({ timeout: 30_000 })
  check('a new conversation runs to the end', true)

  await rowMenu(page, /Summarize the revenue/, 'Rename')
  await page.getByLabel('Session name').fill('Revenue chat')
  await page.getByLabel('Session name').press('Enter')
  await page.getByRole('button', { name: /^Revenue chat/ }).waitFor()
  check('a session can be renamed', true)

  await page.getByRole('button', { name: /Approval:/ }).click()
  await page.getByRole('menuitemradio', { name: /Ask first/ }).click()
  check('the approval mode of a session can be changed', (await page.getByRole('button', { name: /Approval:/ }).innerText()).includes('Ask first'))

  await rowMenu(page, /Plan KB update/, 'Delete')
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('button', { name: /Plan KB update/ }).first().waitFor()
  check('Undo brings a deleted session back', true)

  await rowMenu(page, /Investigate build failure/, 'Delete')
  check('a deleted session leaves the sidebar at once', (await page.getByRole('button', { name: /Investigate build failure/ }).count()) === 0)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await page.getByRole('button', { name: 'Paste an API key instead' }).first().click()
  await page.getByLabel('OpenAI Codex API key').fill('sk-test-1234abcd')
  await page.getByRole('button', { name: 'Save key' }).click()
  await page.getByText('API key ending abcd').waitFor({ timeout: 10_000 })
  check('an API key is accepted and only its last four characters are shown', true)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'New chat' }).click()
  await textbox(page).fill('half a thought')
  await page.locator('input[type=file]').first().setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG })
  await page.getByLabel(/shot\.png/).first().waitFor()
  await page.waitForTimeout(900)
  check('a draft with a file is on screen', true)
  await app.close()

  // ---- Restart -------------------------------------------------------------------------------------
  console.log('\n# After a normal restart')
  app = await open()
  page = app.page
  await ready(page)
  check('the wizard does not come back', (await page.getByRole('dialog', { name: 'Set up Celeste' }).count()) === 0)
  check('the theme is kept', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light')
  check('the name is kept', (await page.getByRole('heading', { level: 1 }).first().innerText()).includes('Dana'))
  check('the renamed session is there', (await page.getByRole('button', { name: /^Revenue chat/ }).count()) > 0)
  check('the undone delete stayed undone', (await page.getByRole('button', { name: /Plan KB update/ }).count()) > 0)
  check('the deleted session is gone', (await page.getByRole('button', { name: /Investigate build failure/ }).count()) === 0)
  check('the unsent text is back', (await textbox(page).inputValue()) === 'half a thought')
  await page.getByLabel(/shot\.png/).first().waitFor({ timeout: 10_000 })
  const img = page.locator('img[src^="celeste-file://"]').first()
  await img.waitFor({ timeout: 10_000 })
  check('the unsent file is back and loads', (await img.evaluate((el) => el.complete && el.naturalWidth)) === 1)

  await page.getByRole('button', { name: /^Revenue chat/ }).click()
  await page.getByText('go through the plan first', { exact: false }).waitFor({ timeout: 10_000 })
  check('the whole conversation is back', (await page.getByText('Summarize the revenue spreadsheet please').count()) > 0)
  check('the session keeps its approval mode', (await page.getByRole('button', { name: /Approval:/ }).innerText()).includes('Ask first'))

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: /Search chats/ }).fill('spreadsheet')
  await page.getByRole('option', { name: /Revenue chat/ }).waitFor({ timeout: 10_000 })
  check('search finds words inside a conversation', true)
  await page.getByRole('combobox', { name: /Search chats/ }).fill('canary')
  await page.getByRole('option', { name: /Plan KB update/ }).waitFor({ timeout: 10_000 })
  check('search finds words in the assistant’s answers too', true)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  check('the connected vendor with its key is kept', (await page.getByText('API key ending abcd').count()) > 0)
  await page.keyboard.press('Escape')
  const secretsFile = join(profile, 'secrets.json')
  check('the key is stored, and not as readable text', existsSync(secretsFile) && !readFileSync(secretsFile, 'utf8').includes('1234abcd'))

  // Leave a turn running, then pull the plug.
  await page.evaluate(() => window.celeste.core.call('dev.forceScenario', ['stuck-thinking']))
  await textbox(page).fill('keep going')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 10_000 })
  check('a turn is running when the app is killed', true)
  await app.crash()

  // ---- After a crash -------------------------------------------------------------------------------
  console.log('\n# After a crash in the middle of a turn')
  app = await open()
  page = app.page
  await ready(page)
  await page.getByRole('button', { name: /^Revenue chat/ }).click()
  await page.getByText('Celeste was closed while this was running', { exact: false }).waitFor({ timeout: 10_000 })
  check('the session says it was cut off', true)
  check('what was said before the crash is kept', (await page.getByText('keep going').count()) > 0)
  check('the session is not stuck as running', (await page.getByRole('button', { name: 'Stop' }).count()) === 0)
  await app.close()

  // ---- The file itself -----------------------------------------------------------------------------
  console.log('\n# The database')
  const db = new DatabaseSync(join(profile, 'celeste.db'), { readOnly: true })
  check('the database passes SQLite’s integrity check', db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok')
  const revenue = db.prepare("SELECT id, last_seq FROM sessions WHERE title = 'Revenue chat'").get()
  const events = db.prepare('SELECT count(*) AS n, max(seq) AS top FROM events WHERE session_id = ?').get(revenue.id)
  check('every event has a number, with no gaps', events.n === events.top && events.top === revenue.last_seq, JSON.stringify(events))
  check('deleted sessions are gone from the file', db.prepare("SELECT count(*) AS n FROM sessions WHERE title = 'Investigate build failure'").get().n === 0)
  db.close()
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  // After a failure the app may still be open, and Windows will not delete files it holds.
  await app?.close().catch(() => undefined)
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    console.warn(`Could not remove ${profile}`)
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
