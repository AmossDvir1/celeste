// Claude in the real built app, with the real Claude Code program and the real SDK, against a stand-in for Anthropic's
// API on this computer (src/core/adapters/claude/fake-anthropic.ts): no account and no quota. It pastes an API key,
// sees Claude's own models, runs a conversation, restarts and picks it up, and force-quits in the middle of an answer.
//   npm run verify:claude
// Needs Claude Code's program beside the SDK (a normal `npm install` puts it there).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAnthropic } from '../src/core/adapters/claude/fake-anthropic.ts'
import { launch, saveSettings } from './lib/app.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-claude-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

const api = new FakeAnthropic((r) => {
  if (r.last.kind === 'text' && r.last.text.includes('HOLD')) return [{ type: 'hold' }]
  return [{ type: 'text', text: r.last.kind === 'text' ? `Echo: ${r.last.text}` : 'Finished' }]
})
await api.start()

let app
const open = () => launch({ width: 1440, height: 900, theme: null, profile, scripted: false, env: { ANTHROPIC_BASE_URL: api.url } })
const textbox = (page) => page.getByRole('textbox', { name: 'Message' })
const idle = (page) => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 90_000 })
const settingsNav = (page, name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })
const pageText = (page) => page.evaluate(() => document.body.innerText)
const mentions = (word) => JSON.stringify(api.main.at(-1)?.body.messages ?? []).includes(word)

try {
  console.log('\n# Connecting with an API key')
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('button', { name: /Analyze WFO logs/ }).first().waitFor({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav(page, 'AI vendors').click()
  const status = await page.evaluate(() => window.celeste.core.call('vendor.status', ['claude']))
  check(`Core starts Claude Code and finds nobody signed in (${status.state})`, status.state === 'signed-out', JSON.stringify(status))

  const card = page.getByRole('heading', { name: 'Claude Agent', exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
  await card.getByRole('button', { name: 'Paste an API key instead' }).click()
  await card.getByLabel(/API key/).fill('sk-ant-api03-a-key-for-the-test-1234')
  await card.getByRole('button', { name: 'Save key' }).click()
  await card.getByText(/Connected · API key ending 1234/).waitFor({ timeout: 60_000 })
  check('the card shows the key as connected, by its last four characters', true)
  await page.keyboard.press('Escape')

  console.log('\n# Claude\'s own models')
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  const items = page.getByRole('menuitemradio')
  for (let i = 0; i < 60 && (await page.getByRole('menuitemradio', { name: /^Haiku/ }).count()) === 0; i++) await page.waitForTimeout(300)
  const names = await items.allInnerTexts()
  check(`the model menu lists Claude's own models (${names.filter((n) => /Haiku|Sonnet|Opus|Default/.test(n)).length} of ${names.length})`, names.some((n) => /^Haiku/.test(n)) && names.some((n) => /^Sonnet/.test(n)))
  check('and no longer the scripted Claude names', (await page.getByRole('menuitemradio', { name: 'Claude Sonnet', exact: true }).count()) === 0)
  await page.getByRole('menuitemradio', { name: /^Haiku/ }).first().click()

  console.log('\n# A conversation')
  await textbox(page).fill('Say the word pong')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('the answer arrives and the turn ends', (await pageText(page)).includes('Echo: Say the word pong'))
  const boot = await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))
  const mine = boot.sessions.find((s) => s.title.startsWith('Say the word pong'))
  check('the session is a Claude session with the chosen model', mine?.vendor === 'claude' && /haiku/i.test(mine.model), JSON.stringify(mine))
  check('Claude Code was asked for the model the person chose', /haiku/i.test(api.main.at(-1)?.model ?? ''), api.main.at(-1)?.model)
  await page.waitForTimeout(800)
  await app.close()

  console.log('\n# After a restart')
  app = await open()
  page = app.page
  await page.getByRole('button', { name: /Say the word pong/ }).first().waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: /Say the word pong/ }).first().click()
  check('the whole conversation is back, from Celeste\'s own log', (await pageText(page)).includes('Echo: Say the word pong'))
  await textbox(page).fill('And again')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('Claude continues the same conversation: it was sent what was said before the restart', mentions('Say the word pong'))
  check('and nothing says the conversation had to be rebuilt', !/no longer had this conversation/i.test(await pageText(page)))

  console.log('\n# A force-quit in the middle of an answer')
  await page.getByRole('button', { name: 'New chat' }).click()
  // A new chat starts on the default model, which is Copilot's: pick Claude's again.
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  await page.getByRole('menuitemradio', { name: /^Haiku/ }).first().click()
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
  await textbox(page).fill('What was my codeword?')
  await textbox(page).press('Enter')
  await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 30_000 })
  await idle(page)
  check('Claude is given the earlier turn, from before the crash', mentions('plum'))
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
} finally {
  await app?.close().catch(() => undefined)
  await api.stop().catch(() => undefined)
  // The program Claude Code runs as may take a moment to let go of its folder on Windows.
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
console.log(failures.length ? `\n${failures.length} failed` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
