// Phase 2 acceptance test: after closing and reopening, every session, draft and setting is intact,
// and a crash loses nothing that was recorded. Runs the real built app three times on one profile, with Claude talking to
// a stand-in for Anthropic's API (scripts/lib/stub.mjs), so it needs no account.
//   npm run verify:persistence
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PNG as Png } from 'pngjs'
import { launch } from './lib/app.mjs'
import { KEY, claudeReady, pasteClaudeKey, say, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-persist-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

/** How many pixels of a picture differ clearly from its top-left pixel, the background: a measure of how much text is showing. */
function inkPixels(picture) {
  const { data } = Png.sync.read(picture)
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) > 60) count++
  }
  return count
}

// A valid 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const stub = await startStub()
// Copilot gets a data folder of its own, so a message sent without a model named never reaches a Copilot signed in on this computer.
const open = () => launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, copilotKnowsNoOne: true })
const row = (page, name) => page.locator('div.group').filter({ has: page.getByRole('button', { name }) })
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const sidebar = (page, name) => page.getByRole('button', { name })
const sidebarWidth = async (page) => Math.round((await page.locator('aside[aria-label="Sessions"]').boundingBox()).width)
const ready = async (page) => {
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await claudeReady(page)
}

async function rowMenu(page, rowName, item) {
  const r = row(page, rowName)
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
  await pasteClaudeKey(page)
  check('a key pasted in the wizard connects Claude, and only its last four characters are shown', true)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await ready(page)
  check('a new profile has no sessions in the sidebar', (await page.locator('aside[aria-label="Sessions"] div.group').count()) === 0)

  await say(page, 'Summarize the revenue spreadsheet please')
  check('a new conversation runs to the end', true)
  await page.getByRole('button', { name: 'New chat' }).click()
  await say(page, 'Plan the KB update')
  await page.getByRole('button', { name: 'New chat' }).click()
  await say(page, 'Investigate the build failure')

  await rowMenu(page, /Summarize the revenue/, 'Rename')
  await page.getByLabel('Session name').fill('Revenue chat')
  await page.getByLabel('Session name').press('Enter')
  await page.getByRole('button', { name: /^Revenue chat/ }).waitFor()
  check('a session can be renamed', true)

  // After its first message a chat is named by a small model of its vendor (here the stand-in answers), and the setting turns that off.
  stub.naming = (m) => (/NAME-ME/.test(m) ? 'Named by the stand-in' : 'This reply is far too long to be a title, so the app ignores it and keeps the first words.')
  await page.getByRole('button', { name: 'New chat' }).click()
  await say(page, 'NAME-ME summarize the quarterly numbers')
  await page.getByRole('button', { name: /^Named by the stand-in/ }).waitFor({ timeout: 30_000 })
  check('the first message names the chat: a short title replaces the first words in the list', (await sidebar(page, /NAME-ME summarize/).count()) === 0)
  // There is no switch for it any more: a chat is always named, and a title that is too long is not used.
  await page.getByRole('button', { name: 'New chat' }).click()
  await say(page, 'A plain message that the stand-in names far too long')
  await page.waitForTimeout(1500)
  check('a title that is too long is ignored: the first words stay', (await sidebar(page, /A plain message that/).count()) === 1)

  // The session list can be dragged wider and narrower, but only between two limits, and the width is kept.
  const handle = page.getByRole('separator', { name: 'Resize the sidebar' })
  const drag = async (dx) => {
    const box = await handle.boundingBox()
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx / 2, y)
    await page.mouse.move(x + dx, y)
    await page.mouse.up()
  }
  check('the session list starts at its usual width', (await sidebarWidth(page)) === 232)
  await drag(400)
  check('dragged wider it stops at the limit, one and a half times the usual width', (await sidebarWidth(page)) === 348, String(await sidebarWidth(page)))
  await drag(-800)
  // The limits are SIDEBAR_WIDTH in src/shared/defaults.ts (192, 232, 348); an arrow key moves 16 pixels.
  check('dragged narrower it stops at its limit too', (await sidebarWidth(page)) === 192, String(await sidebarWidth(page)))
  await handle.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  check('the arrow keys change it too, a step at a time', (await sidebarWidth(page)) === 272, String(await sidebarWidth(page)))
  check('a long session title is cut short with an ellipsis, not run into the menu button', await page.locator('aside[aria-label="Sessions"] button span.truncate').first().evaluate((el) => getComputedStyle(el).textOverflow === 'ellipsis'))

  await page.getByRole('button', { name: /^Revenue chat/ }).click()
  await page.getByRole('button', { name: /Approval:/ }).click()
  await page.getByRole('menuitemradio', { name: /Ask first/ }).click()
  check('the approval mode of a session can be changed', (await page.getByRole('button', { name: /Approval:/ }).innerText()).includes('Ask first'))

  // Deleting asks first. Cancel, Escape and the backdrop keep the session; only Delete removes it.
  const asking = page.getByRole('dialog', { name: /^Delete “/ })
  await rowMenu(page, /Plan the KB update/, 'Delete')
  await asking.waitFor()
  check('deleting a session asks first, and says what it will do', /removes the chat from this computer/.test(await asking.innerText()))
  check('with focus on Cancel, so Enter by habit does not delete', await asking.getByRole('button', { name: 'Cancel' }).evaluate((el) => el === document.activeElement))
  await asking.getByRole('button', { name: 'Cancel' }).click()
  await asking.waitFor({ state: 'detached' })
  check('Cancel keeps it', (await sidebar(page, /Plan the KB update/).count()) > 0)
  await rowMenu(page, /Plan the KB update/, 'Delete')
  await asking.waitFor()
  await page.keyboard.press('Escape')
  await asking.waitFor({ state: 'detached' })
  check('Escape keeps it too', (await sidebar(page, /Plan the KB update/).count()) > 0)
  await rowMenu(page, /Plan the KB update/, 'Delete')
  await asking.getByRole('button', { name: 'Delete', exact: true }).click()
  check('Delete removes it at once', (await sidebar(page, /Plan the KB update/).count()) === 0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await sidebar(page, /Plan the KB update/).first().waitFor()
  check('Undo brings a deleted session back', true)

  await rowMenu(page, /Investigate the build failure/, 'Delete')
  await asking.getByRole('button', { name: 'Delete', exact: true }).click()
  check('a deleted session leaves the sidebar at once', (await sidebar(page, /Investigate the build failure/).count()) === 0)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  check('Settings shows the connected vendor', (await page.getByText(/Connected · API key ending 1234/).count()) > 0)
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
  check('the width of the session list is kept', (await sidebarWidth(page)) === 272, String(await sidebarWidth(page)))
  check('the theme is kept', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light')
  check('the name is kept', (await page.getByRole('heading', { level: 1 }).first().innerText()).includes('Dana'))
  check('the renamed session is there', (await sidebar(page, /^Revenue chat/).count()) > 0)
  check('the undone delete stayed undone', (await sidebar(page, /Plan the KB update/).count()) > 0)
  check('the deleted session is gone', (await sidebar(page, /Investigate the build failure/).count()) === 0)
  check('the unsent text is back', (await textbox(page).inputValue()) === 'half a thought')
  await page.getByLabel(/shot\.png/).first().waitFor({ timeout: 10_000 })
  const img = page.locator('img[src^="celeste-file://"]').first()
  await img.waitFor({ timeout: 10_000 })
  check('the unsent file is back and loads', (await img.evaluate((el) => el.complete && el.naturalWidth)) === 1)

  await sidebar(page, /^Revenue chat/).click()
  await page.getByText('canary hosts go first', { exact: false }).first().waitFor({ timeout: 10_000 })
  check('the whole conversation is back', (await page.getByText('Summarize the revenue spreadsheet please').count()) > 0)
  check('the session keeps its approval mode', (await page.getByRole('button', { name: /Approval:/ }).innerText()).includes('Ask first'))

  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: /Search chats/ }).fill('spreadsheet')
  await page.getByRole('option', { name: /Revenue chat/ }).waitFor({ timeout: 10_000 })
  check('search finds words inside a conversation', true)
  await page.getByRole('combobox', { name: /Search chats/ }).fill('canary')
  await page.getByRole('option', { name: /Plan the KB update/ }).waitFor({ timeout: 10_000 })
  check('search finds words in the assistant’s answers too', true)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  check('the connected vendor with its key is kept', (await page.getByText(/Connected · API key ending 1234/).count()) > 0)
  await page.keyboard.press('Escape')
  const secretsFile = join(profile, 'secrets.json')
  check('the key is stored, and not as readable text', existsSync(secretsFile) && !readFileSync(secretsFile, 'utf8').includes(KEY.slice(-12)))

  // Leave a turn running, then pull the plug.
  await sidebar(page, /^Revenue chat/).click()
  await textbox(page).fill('HOLD keep going')
  await textbox(page).press('Enter')
  await page.getByText('Working on it').first().waitFor({ timeout: 60_000 })
  check('a turn is running when the app is killed', (await page.getByRole('button', { name: 'Stop' }).count()) === 1)
  // The working label shimmers whatever the system says about animations (Windows reports "reduce motion" when they are off), at the
  // speed it was made for, and no letter of it is ever left without colour while the light moves across.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const label = page.locator('.shimmer').first()
  const style = await label.evaluate((el) => {
    const s = getComputedStyle(el)
    return { name: s.animationName, duration: s.animationDuration, layers: (s.backgroundImage.match(/linear-gradient/g) ?? []).length }
  })
  check('the working label shimmers even when the system asks for less motion', style.name === 'shimmer-sweep', JSON.stringify(style))
  check('at its own speed, not slowed down', style.duration === '2.2s', style.duration)
  check('with a plain layer of colour under the moving light', style.layers === 2, JSON.stringify(style))
  // Looked at over a whole sweep: the amount of text that can be seen must not change, which is how a label that loses
  // letters (and jumps when the sweep starts over) would show.
  const seen = []
  for (let i = 0; i < 14; i++) {
    seen.push(inkPixels(await label.screenshot()))
    await page.waitForTimeout(190)
  }
  const least = Math.min(...seen)
  const most = Math.max(...seen)
  check('the whole label stays visible all through the sweep', least > 0 && least / most > 0.88, `${least} to ${most} pixels of text`)
  await app.crash()

  // ---- After a crash -------------------------------------------------------------------------------
  console.log('\n# After a crash in the middle of a turn')
  app = await open()
  page = app.page
  await ready(page)
  await sidebar(page, /^Revenue chat/).click()
  await page.getByText('Celeste was closed while this was running', { exact: false }).waitFor({ timeout: 10_000 })
  check('the session says it was cut off', true)
  check('what was said before the crash is kept', (await page.getByText('HOLD keep going').count()) > 0)
  check('the session is not stuck as running', (await page.getByRole('button', { name: 'Stop' }).count()) === 0)
  await app.close()

  // ---- The file itself -----------------------------------------------------------------------------
  console.log('\n# The database')
  const db = new DatabaseSync(join(profile, 'celeste.db'), { readOnly: true })
  check('the database passes SQLite’s integrity check', db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok')
  const revenue = db.prepare("SELECT id, last_seq FROM sessions WHERE title = 'Revenue chat'").get()
  const events = db.prepare('SELECT count(*) AS n, max(seq) AS top FROM events WHERE session_id = ?').get(revenue.id)
  check('every event has a number, with no gaps', events.n === events.top && events.top === revenue.last_seq, JSON.stringify(events))
  check('deleted sessions are gone from the file', db.prepare("SELECT count(*) AS n FROM sessions WHERE title LIKE 'Investigate the build%'").get().n === 0)
  db.close()
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  // After a failure the app may still be open, and Windows will not delete files it holds.
  await app?.close().catch(() => undefined)
  await stub.stop().catch(() => undefined)
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
