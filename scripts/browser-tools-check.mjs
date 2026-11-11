// The assistant's use of the browser, in the real built app: Claude opens a page, reads it, clicks, types, fills, takes a picture, reads the
// console and the network, opens and closes tabs, and can use only its own chat's tabs; the browser comes up beside the chat by itself;
// it works with the panel closed; the switch in Settings turns it off; and another program (Playwright, from here) can connect to the
// browser only while it is allowed, and sees only the browser's tabs.   npm run verify:browser-tools
// Claude is real (the real SDK and program) but what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, startStub } from './lib/stub.mjs'

const { chromium } = createRequire(import.meta.url)('playwright-core')
const profile = mkdtempSync(join(tmpdir(), 'celeste-browser-tools-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${String(detail).slice(0, 700)})`}`)
  if (!ok) failures.push(label)
}
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

// A small web site on this computer.
const site = createServer((req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/api')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"answer":42}')
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (url.startsWith('/second')) return res.end('<!doctype html><title>Second page</title><h1>Second page</h1>')
  res.end(`<!doctype html><title>Test page</title><h1>Hello from the test page</h1>
<button id="b" onclick="document.getElementById('out').textContent='clicked '+(++window.n)">Press me</button>
<input id="i" aria-label="Name"><p id="out"></p>
<script>window.n = 0; console.log('page loaded'); fetch('/api')</script>`)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${site.address().port}`

// What the stand-in assistant does, round by round. A round starts with a message of the form "Round <name>".
const tool = (name, input) => ({ type: 'tool_use', name: `mcp__celeste-devices__${name}`, input })
const refOf = (text, label) => new RegExp(`${label}[^\\n]*\\[ref=(\\w+)\\]`).exec(text)?.[1]
// A deck (shown by the viewer) and a page (shown by Chromium itself), both outside any chat's folder.
const deck = resolve(fileURLToPath(new URL('./fixtures/deck.pptx', import.meta.url)))
const note = join(profile, 'a note.html')
writeFileSync(note, '<!doctype html><title>A note</title><h1>A note for Dana</h1>')
const results = []
const mem = { tabIds: [], firstTab: '' }
let round = ''
let step = 0
const rounds = {
  browse: (s, text) => {
    if (s === 1) return [tool('browser_navigate', { url: `${base}/` })]
    if (s === 2) return [tool('browser_read_page', {})]
    if (s === 3) return [tool('browser_click', { ref: refOf(text, 'button "Press me"') })]
    if (s === 4) return [tool('browser_type', { ref: refOf(results.find((r) => r.round === 'browse' && r.step === 2).text, 'textbox "Name"'), text: 'Dana' })]
    if (s === 5) return [tool('browser_fill', { ref: refOf(results.find((r) => r.round === 'browse' && r.step === 2).text, 'textbox "Name"'), value: 'Dana Lee' })]
    if (s === 6) return [tool('browser_screenshot', {})]
    if (s === 7) return [tool('browser_console', {})]
    if (s === 8) return [tool('browser_network', {})]
    if (s === 9) return [tool('browser_eval', { expression: 'document.title' })]
    if (s === 10) return [tool('browser_get_text', {})]
    if (s === 11) return [tool('browser_find', { query: 'press' })]
    if (s === 12) return [tool('browser_new_tab', { url: `${base}/second` })]
    if (s === 13) return [tool('browser_tabs', {})]
    if (s === 14) {
      mem.tabIds = [...text.matchAll(/tab-[\w-]+/g)].map((m) => m[0])
      return [tool('browser_select_tab', { tab: mem.tabIds[0] })]
    }
    if (s === 15) return [tool('browser_close_tab', { tab: mem.tabIds[1] })]
    if (s === 16) return [tool('browser_scroll', { dy: 300 })]
    if (s === 17) return [tool('browser_navigate', { url: 'weather in paris' })]
    return [{ type: 'text', text: 'Round browse is over.' }]
  },
  other: (s) => {
    if (s === 1) return [tool('browser_read_page', {})]
    if (s === 2) return [tool('browser_read_page', { tab: mem.firstTab })]
    if (s === 3) return [tool('browser_screenshot', { tab: mem.firstTab })]
    if (s === 4) return [tool('browser_navigate', { url: `${base}/second` })]
    return [{ type: 'text', text: 'Round other is over.' }]
  },
  closed: (s) => {
    if (s === 1) return [tool('browser_screenshot', {})]
    if (s === 2) return [tool('browser_read_page', {})]
    if (s === 3) return [tool('browser_click', { ref: refOf(results.find((r) => r.round === 'browse' && r.step === 2).text, 'button "Press me"') })]
    return [{ type: 'text', text: 'Round closed is over.' }]
  },
  openfile: (s) => {
    if (s === 1) return [tool('browser_open_file', { path: deck })]
    if (s === 2) return [tool('browser_open_file', { path: note })]
    if (s === 3) return [tool('browser_tabs', {})]
    if (s === 4) return [tool('browser_open_file', { path: join(profile, 'not-there.pdf') })]
    return [{ type: 'text', text: 'Round openfile is over.' }]
  },
  off: (s) => (s === 1 ? [tool('browser_tabs', {})] : [{ type: 'text', text: 'Round off is over.' }])
}
// Rounds on a site that is not this computer (the check points *.test at the local server): open it, read it, click (twice, or once).
const siteRound = (name, host, clicks) => (s) => {
  if (s === 1) return [tool('browser_navigate', { url: `http://${host}:${site.address().port}/` })]
  if (s === 2) return [tool('browser_read_page', {})]
  if (s < 3 + clicks) return [tool('browser_click', { ref: refOf(got(name, 2).text, 'button "Press me"') })]
  return [{ type: 'text', text: `Round ${name} is over.` }]
}
Object.assign(rounds, {
  siteonce: siteRound('siteonce', 'once.test', 2)
})
const script = (r) => {
  if (r.last.kind === 'tool_result') {
    // `step` is the number of the tool that was just called: this is its result. The next one is called with it.
    results.push({ round, step, text: r.last.text, isError: r.last.isError, bytes: r.resultImageBytes })
    step++
    return rounds[round]?.(step, r.last.text) ?? [{ type: 'text', text: 'Unknown round.' }]
  }
  const m = /Round (\w+)/.exec(r.last.text)
  if (m && rounds[m[1]]) {
    round = m[1]
    step = 1
    return rounds[round](1, '')
  }
  return echo(r)
}
const got = (name, n) => results.find((r) => r.round === name && r.step === n)

process.on('beforeExit', (code) => console.log(`(the check ran out of things to wait for, code ${code})`))
let stub
let app
try {
  stub = await startStub(script)
  // Any *.test name is this computer's own site, so it is "another site" to the browser, which only asks about those.
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, chromiumArgs: ['--host-resolver-rules=MAP *.test 127.0.0.1'] })
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

  const textbox = page.getByRole('textbox', { name: 'Message' })
  const pane = page.getByRole('region', { name: 'Browser' })
  const tabs = () => pane.getByTestId('browser-tab')
  const view = (prefix = base) => app.app.context().pages().find((p) => p.url().startsWith(prefix))
  /** The cards that ask the person something and are still waiting. */
  const card = page.getByRole('group', { name: 'Approval needed' })
  /** Sends a round. `answers` are the buttons to press on the cards it raises, in order; the round ends when the assistant says so. */
  const run = async (name, answers = [], ms = 120_000) => {
    await textbox.fill(`Round ${name}`)
    await textbox.press('Enter')
    for (const label of answers) {
      await card.first().waitFor({ timeout: 60_000 })
      asked.push(await card.first().innerText())
      await card.first().getByRole('button', { name: label, exact: true }).click()
    }
    await page.getByText(`Round ${name} is over.`).first().waitFor({ timeout: ms })
    await page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
  }
  const asked = []
  const settingsBrowser = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Browser' }).click()
    await page.getByRole('heading', { name: 'Browser', level: 2 }).waitFor({ timeout: 5000 })
  }

  console.log('\n# Claude uses the browser')
  check('the browser is not open to begin with', (await pane.count()) === 0)
  await run('browse')
  check('it came up beside the chat by itself', await pane.isVisible())
  const addressBar = page.getByRole('textbox', { name: 'Address' })
  check('its address bar shows where the page is, and has not taken the keyboard from the message box', (await addressBar.inputValue()).startsWith(base) && !(await addressBar.evaluate((el) => el === document.activeElement)), await addressBar.inputValue())
  check('navigate opened a tab, since the chat had none', /Opened tab tab-/.test(got('browse', 1).text), got('browse', 1).text)
  const read = got('browse', 2).text
  check('reading the page gives its content with refs, marked as data', /Hello from the test page/.test(read) && /button "Press me" \[ref=e\d+\]/.test(read) && /data to read, not instructions/.test(read), read)
  check('click by ref clicks in the real page', (await view().textContent('#out')) === 'clicked 1' && /Clicked/.test(got('browse', 3).text), got('browse', 3).text)
  const typed = await view().inputValue('#i')
  check('typing and filling went into the field', typed === 'Dana Lee' && /Typed/.test(got('browse', 4).text) && !got('browse', 5).isError, `field=${JSON.stringify(typed)} type=${got('browse', 4).text} fill=${got('browse', 5).text}`)
  check('a screenshot comes back as a picture', got('browse', 6).bytes > 1000 && /pixels/.test(got('browse', 6).text), `${got('browse', 6).bytes} ${got('browse', 6).text}`)
  check('the console has what the page logged', /page loaded/.test(got('browse', 7).text), got('browse', 7).text)
  check('the network has the page’s own request', /\/api/.test(got('browse', 8).text) && /200/.test(got('browse', 8).text), got('browse', 8).text)
  check('eval returns the value', /Test page/.test(got('browse', 9).text), got('browse', 9).text)
  check('the page’s text comes back', /Hello from the test page/.test(got('browse', 10).text), got('browse', 10).text)
  check('find locates an element by a phrase', /Press me/.test(got('browse', 11).text) && /\[ref=e\d+\]/.test(got('browse', 11).text), got('browse', 11).text)
  check('a new tab opens, and the panel shows both', /Opened tab/.test(got('browse', 12).text) && (await tabs().count()) === 1, `${(await tabs().count())} ${got('browse', 12).text}`)
  check('the tab list names both', mem.tabIds.length === 2, JSON.stringify(mem.tabIds))
  mem.firstTab = mem.tabIds[0]
  check('closing a tab closes it', /Closed tab/.test(got('browse', 15).text), got('browse', 15).text)
  check('a phrase is not taken for an address', got('browse', 17).isError && /not an address/.test(got('browse', 17).text), got('browse', 17).text)
  await until('one tab left', async () => (await tabs().count()) === 1)

  console.log('\n# One chat cannot use another’s tabs')
  await page.getByRole('button', { name: 'New chat' }).click()
  await textbox.waitFor()
  await run('other')
  check('a new chat has no tab to read', got('other', 1).isError && /no browser tab yet/.test(got('other', 1).text), got('other', 1).text)
  check('and cannot read the first chat’s tab by its id', got('other', 2).isError && /not one of this chat’s tabs/.test(got('other', 2).text), got('other', 2).text)
  check('or take a picture of it', got('other', 3).isError && /not one of this chat’s tabs/.test(got('other', 3).text), got('other', 3).text)
  check('it can open its own', /Opened tab/.test(got('other', 4).text), got('other', 4).text)

  console.log('\n# With the panel closed')
  await page.getByRole('button', { name: 'Hello there' }).first().click().catch(() => undefined)
  await page.getByRole('navigation', { name: 'Sessions' }).getByRole('button').first().waitFor().catch(() => undefined)
  // Back in the first chat (the oldest session), with the panel closed.
  const sessions = page.locator('button[aria-label^="More actions for"]')
  const first = sessions.last()
  await first.locator('..').getByRole('button').first().click()
  if (await pane.isVisible().catch(() => false)) await pane.getByRole('button', { name: 'Close browser' }).click()
  await pane.waitFor({ state: 'detached', timeout: 5000 })
  await run('closed')
  check('a picture of a page that is not on screen is still a picture', got('closed', 1).bytes > 1000, `${got('closed', 1).bytes} ${got('closed', 1).text}`)
  check('reading it works', /Hello from the test page/.test(got('closed', 2).text), got('closed', 2).text)
  check('and so does clicking in it', /Clicked/.test(got('closed', 3).text) && (await view().textContent('#out')) === 'clicked 2', got('closed', 3).text)

  console.log('\n# The switch')
  await saveSettings(page, { browserTools: false })
  await run('off')
  check('with the switch off, a tool says so and does nothing', got('off', 1).isError && /switched off/.test(got('off', 1).text), got('off', 1).text)
  await saveSettings(page, { browserTools: true })

  console.log('\n# Showing a file to the person')
  await page.getByRole('button', { name: 'New chat' }).click()
  await textbox.waitFor()
  const askedBefore = asked.length
  await run('openfile')
  check('a file outside the chat’s folder opens where the chat asks nothing before it acts', !got('openfile', 1).isError && /viewer/.test(got('openfile', 1).text), got('openfile', 1).text)
  check('the person sees it as a tab named for the file', (await tabs().filter({ hasText: 'deck.pptx' }).count()) === 1, await tabs().allInnerTexts())
  check('a page Chromium shows itself opens as an ordinary tab', !got('openfile', 2).isError && /normal browser tab/.test(got('openfile', 2).text), got('openfile', 2).text)
  check('the assistant is told about the page’s tab and not the viewer’s', /A note/.test(got('openfile', 3).text) && !/deck/.test(got('openfile', 3).text), got('openfile', 3).text)
  check('a file that is not there is said so', got('openfile', 4).isError && /no longer there/.test(got('openfile', 4).text), got('openfile', 4).text)
  check('and none of it asked anything', asked.length === askedBefore)

  console.log('\n# A site is not asked about (unless the chat is set to Ask: the unit tests cover that)')
  const fresh = async () => {
    await page.getByRole('button', { name: 'New chat' }).click()
    await textbox.waitFor()
  }
  const pageOn = (host) => view(`http://${host}:`)
  await fresh()
  await run('siteonce')
  check('acting on a site that is not this computer does not ask, and the clicks went through', asked.length === askedBefore && /Clicked/.test(got('siteonce', 3).text) && /Clicked/.test(got('siteonce', 4).text) && (await pageOn('once.test').textContent('#out')) === 'clicked 2', `${asked.length} ${got('siteonce', 3).text} | ${got('siteonce', 4).text}`)
  await settingsBrowser()
  check('Settings no longer has a switch for asking about sites, and lists no sites when none were allowed', (await page.getByRole('switch', { name: 'Ask before it uses a new site' }).count()) === 0 && (await page.getByText('Sites it may always use').count()) === 0)
  await saveSettings(page, { browserAllowedSites: ['always.test'] })
  await page.keyboard.press('Escape')
  await settingsBrowser()
  check('a site that was allowed for good is listed, with a way to take it back', await page.getByText('always.test', { exact: true }).isVisible())
  await page.getByRole('button', { name: 'Stop always allowing always.test' }).click()
  check('and it can be taken off the list, which then goes away', (await page.getByText('Sites it may always use').count()) === 0)
  await page.keyboard.press('Escape')

  console.log('\n# Settings, Browser')
  await settingsBrowser()
  const addressBox = page.getByRole('textbox', { name: 'Address for other programs' })
  check('other programs are off to begin with, with no address shown', (await addressBox.count()) === 0)
  await page.getByRole('switch', { name: 'Let other programs control Celeste’s browser' }).click()
  await addressBox.waitFor({ timeout: 5000 })
  check('switching them on shows the address, and that no program is connected', /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{32}$/.test(await addressBox.inputValue()) && (await page.getByText('No program is connected.').isVisible()))
  const shownAddress = await addressBox.inputValue()
  const viaSettings = await chromium.connectOverCDP(shownAddress)
  await page.getByText('1 program is connected.').waitFor({ timeout: 8000 })
  check('a program that connects is counted', true)
  await viaSettings.close().catch(() => undefined)
  await page.getByText('No program is connected.').waitFor({ timeout: 8000 })
  check('and no longer counted when it leaves', true)
  await page.getByRole('switch', { name: 'Let other programs control Celeste’s browser' }).click()
  await addressBox.waitFor({ state: 'detached', timeout: 5000 })
  check('switching them off hides the address', true)
  const cookies = page.getByRole('switch', { name: 'Keep cookies' })
  check('cookies are not kept to begin with', (await cookies.getAttribute('aria-checked')) === 'false')
  await cookies.click()
  await page.waitForTimeout(400)
  check('the Keep cookies switch can be turned on', (await cookies.getAttribute('aria-checked')) === 'true')
  await cookies.click()
  await page.getByRole('switch', { name: 'Let the assistant use the browser' }).click()
  await page.waitForTimeout(300)
  check('the switch for the assistant’s use is saved', (await page.getByRole('switch', { name: 'Let the assistant use the browser' }).getAttribute('aria-checked')) === 'false')
  await page.getByRole('switch', { name: 'Let the assistant use the browser' }).click()
  await page.keyboard.press('Escape')

  console.log('\n# Another program')
  // With the panel closed: a page made now has never been shown, and must still have a size to be drawn and photographed.
  if (await pane.isVisible().catch(() => false)) await pane.getByRole('button', { name: 'Close browser' }).click()
  await pane.waitFor({ state: 'detached', timeout: 5000 })
  const closedPort = await page.evaluate(() => window.celeste.browser.call('external', { on: false }))
  check('other programs are not let in to begin with', closedPort.endpoint === null)
  const open = await page.evaluate(() => window.celeste.browser.call('external', { on: true }))
  check('switching them on gives an address', /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{32}$/.test(open.endpoint ?? ''), open.endpoint)
  const outside = await chromium.connectOverCDP(open.endpoint)
  const outsidePages = outside.contexts()[0].pages()
  check('it sees the browser’s tabs and not Celeste’s own window', outsidePages.length >= 2 && outsidePages.every((p) => /^(https?|file):/.test(p.url())) && !outsidePages.some((p) => /deck\.pptx|celeste-view/.test(p.url())), outsidePages.map((p) => p.url()).join(' '))
  const mine = outsidePages.find((p) => p.url() === `${base}/` || p.url() === base)
  check('and can use one: Playwright reads the page', !!mine && (await mine.title()) === 'Test page')
  await mine.click('#b')
  check('and click in it', (await view().textContent('#out')) === 'clicked 3')
  const within = (promise, what, ms = 15_000) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish in ${ms / 1000}s`)), ms))])
  const opened = await within(outside.contexts()[0].newPage(), 'newPage')
  await within(opened.goto(`${base}/second`), 'goto')
  check('and open a tab of its own', (await opened.title()) === 'Second page')
  const picture = await within(opened.screenshot(), 'screenshot').catch((e) => e)
  check('and take a picture of a page that was never on screen', Buffer.isBuffer(picture) && picture.length > 1000, String(picture?.message ?? picture?.length))
  await within(opened.close(), 'close')
  check('and close it', true)
  const gone = new Promise((resolve) => outside.once('disconnected', resolve))
  const after = await page.evaluate(() => window.celeste.browser.call('external', { on: false }))
  await Promise.race([gone, new Promise((_, rej) => setTimeout(() => rej(new Error('still connected')), 8000))]).then(
    () => check('switching them off turns them out at once', after.endpoint === null),
    () => check('switching them off turns them out at once', false)
  )
  await chromium.connectOverCDP(open.endpoint).then(
    () => check('and the address no longer works', false),
    () => check('and the address no longer works', true)
  )
} catch (err) {
  console.error(err)
  failures.push(String(err?.message ?? err))
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  site.close()
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 })
  } catch {
    // A leftover temporary folder is harmless.
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll browser tool checks passed.')
process.exit(failures.length ? 1 : 0)
