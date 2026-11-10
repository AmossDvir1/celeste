// The browser pane, in the real built app: it opens beside a chat, loads pages in a real tab, has tabs of its own per chat, goes back,
// shows errors, asks before a page uses the person's location, saves a download, steps aside for dialogs, hands the window's keys
// back, and opens links from the chat.   npm run verify:browser
// Claude is real (the real SDK and program) but what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-browser-'))
const downloads = mkdtempSync(join(tmpdir(), 'celeste-browser-dl-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
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
  if (url.startsWith('/download')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' })
    return res.end('the report')
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (url.startsWith('/second')) return res.end('<!doctype html><title>Second page</title><h1>Second page</h1>')
  // A page that opens a sign-in popup, which talks back to it through window.opener, and a link that opens a new tab.
  if (url.startsWith('/opener')) {
    return res.end(`<!doctype html><title>Opener page</title><button id="pop" onclick="window.open('/popup', 'signin', 'width=420,height=520')">Sign in</button>
<a id="blank" href="/second" target="_blank">Open in a new tab</a><p id="msg"></p>
<script>addEventListener('message', (e) => { document.getElementById('msg').textContent = e.data })</script>`)
  }
  if (url.startsWith('/popup')) return res.end(`<!doctype html><title>Sign-in popup</title><p>Signing in…</p><script>window.opener && window.opener.postMessage('signed in via ' + typeof window.opener, '*')</script>`)
  res.end(`<!doctype html><title>Test page</title><h1>Hello from the test page</h1>
<button id="b" onclick="document.getElementById('out').textContent='clicked '+(++window.n)">Press me</button>
<input id="i" aria-label="Name"><p id="out"></p><script>window.n = 0</script>`)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${site.address().port}`
// A port nothing listens on (not a low one: Chromium refuses those as unsafe, with a different message).
const closed = await new Promise((resolve) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(`http://127.0.0.1:${port}/`))
  })
})

const script = (r) => {
  if (r.last.kind === 'text' && r.last.text.includes('link please')) return [{ type: 'text', text: `Here you go: [the second page](${base}/second) and [the docs](https://example.com/docs)` }]
  return echo(r)
}

let stub
let app
try {
  stub = await startStub(script)
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
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
  const idle = () => page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached', timeout: 60_000 })
  const say = async (text, until_) => {
    await textbox.fill(text)
    await textbox.press('Enter')
    await page.getByText(until_, { exact: false }).first().waitFor({ timeout: 60_000 })
    await idle()
  }
  const pane = page.getByRole('region', { name: 'Browser' })
  const address = page.getByRole('textbox', { name: 'Address' })
  const tabs = () => pane.getByTestId('browser-tab')
  /** The page itself, which the app shows as a page of its own to Playwright. */
  const view = (prefix = base) => app.app.context().pages().find((p) => p.url().startsWith(prefix))
  const viewMain = (fn, arg) => app.app.evaluate(fn, arg)
  /** The panel stays open from chat to chat, so it is only opened when it is not. */
  const showPane = async () => {
    await page.waitForTimeout(400)
    if (!(await pane.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Browser (Ctrl+Shift+B)' }).click()
    await pane.waitFor({ timeout: 5000 })
  }

  console.log('\n# Opening the browser')
  await say('Hello there', 'Echo: Hello there')
  check('the Browser button is in the header', await page.getByRole('button', { name: 'Browser (Ctrl+Shift+B)' }).isVisible())
  await page.getByRole('button', { name: 'Browser (Ctrl+Shift+B)' }).click()
  await pane.waitFor({ timeout: 5000 })
  check('the panel opens with an empty address bar and a hint', (await address.inputValue()) === '' && (await pane.getByText('Open a site, or ask the assistant to.').isVisible()))
  check('the address bar is ready to type in', await address.evaluate((el) => el === document.activeElement))
  await page.keyboard.press('Control+Shift+B')
  await pane.waitFor({ state: 'detached', timeout: 5000 })
  check('Ctrl+Shift+B closes it', true)
  await page.keyboard.press('Control+Shift+B')
  await pane.waitFor({ timeout: 5000 })
  check('Ctrl+Shift+B opens it', true)

  console.log('\n# A page')
  await address.fill(base.replace('http://', ''))
  await address.press('Enter')
  await until('the page to load', () => view()?.url().startsWith(base))
  await view().waitForLoadState('domcontentloaded')
  check('a bare address opens a real page (http for this computer)', (await view().title()) === 'Test page')
  check('the tab is named after the page', await tabs().first().getByText('Test page').isVisible().catch(() => false))
  await view().click('#b')
  check('the page works: a click is answered', (await view().textContent('#out')) === 'clicked 1')
  const placed = await viewMain(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const v = win.contentView.children.find((c) => c.webContents && !c.webContents.isDestroyed() && c.webContents.getURL().startsWith('http'))
    return v ? v.getBounds() : null
  })
  const box = await page.getByTestId('browser-page').boundingBox()
  check('the page sits exactly where the panel leaves room for it', !!placed && !!box && Math.abs(placed.x - box.x) <= 1 && Math.abs(placed.y - box.y) <= 1 && Math.abs(placed.width - box.width) <= 1 && Math.abs(placed.height - box.height) <= 1, JSON.stringify({ placed, box }))

  console.log('\n# Going somewhere else, and back')
  await address.fill(`${base}/second`)
  await address.press('Enter')
  await until('the second page', async () => (await view(`${base}/second`)?.title()) === 'Second page')
  check('the address bar follows the page', (await address.inputValue()) === `${base}/second`)
  const back = page.getByRole('button', { name: /^Back/ })
  await until('Back to be enabled', () => back.isEnabled())
  await back.click()
  await until('the first page again', () => view()?.url() === `${base}/` || view()?.url() === base)
  check('Back goes to the page before', true)
  check('Forward is then possible', await page.getByRole('button', { name: /^Forward/ }).isEnabled())

  console.log('\n# More than one tab, and a tab per chat')
  await page.getByRole('button', { name: /^New tab/ }).click()
  await until('two tabs', async () => (await tabs().count()) === 2)
  check('a new tab opens next to the first', true)
  check('a new tab starts empty', (await address.inputValue()) === '')
  await address.fill(`${base}/second`)
  await address.press('Enter')
  await until('the tab to be named', async () => (await tabs().nth(1).innerText()).includes('Second page'))
  await tabs().first().click()
  await until('the first tab to come back', async () => (await address.inputValue()).startsWith(base) && !(await address.inputValue()).endsWith('/second'))
  check('picking a tab shows its page', true)
  await pane.getByRole('button', { name: /^Close Second page/ }).click()
  await until('one tab', async () => (await tabs().count()) === 1)
  check('closing a tab keeps the other', (await tabs().first().innerText()).includes('Test page'))

  await page.getByRole('button', { name: 'New chat' }).click()
  await say('Another chat', 'Echo: Another chat')
  await showPane()
  check('another chat has its own, empty browser', (await tabs().count()) === 0)
  await page.getByRole('button', { name: 'Hello there' }).first().click().catch(() => undefined)
  await page.getByText('Echo: Hello there').first().waitFor({ timeout: 10_000 })
  await showPane()
  check('the first chat still has its tab', (await tabs().count()) === 1)

  console.log('\n# A sign-in popup, and a link to a new tab')
  await address.fill(`${base}/opener`)
  await address.press('Enter')
  await until('the opener page', async () => (await view(`${base}/opener`)?.title()) === 'Opener page')
  const windowsBefore = app.app.windows().length
  const tabsBefore = await tabs().count()
  await view(`${base}/opener`).click('#pop')
  await view(`${base}/opener`).locator('#msg').filter({ hasText: 'signed in via object' }).waitFor({ timeout: 10_000 })
  check('a popup that talks back to the page that opened it works (window.opener is there)', true)
  check('it is a small window of its own, not a tab', app.app.windows().length === windowsBefore + 1 && (await tabs().count()) === tabsBefore)
  const popup = app.app.windows().find((w) => w.url().includes('/popup'))
  await popup?.close().catch(() => undefined)
  await until('the popup to close', () => app.app.windows().length === windowsBefore)
  check('and it closes', true)
  await view(`${base}/opener`).click('#blank')
  await until('a new tab', async () => (await tabs().count()) === tabsBefore + 1)
  await until('the new tab’s page', async () => (await view(`${base}/second`)?.title()) === 'Second page')
  check('a link that opens a new tab opens one, in the panel', true)
  await pane.getByRole('button', { name: /^Close Second page/ }).click()
  await until('back to one tab', async () => (await tabs().count()) === tabsBefore)
  await address.fill(base)
  await address.press('Enter')
  await until('the test page again', async () => (await view(`${base}/`)?.title().catch(() => '')) === 'Test page' || (await view(base)?.title().catch(() => '')) === 'Test page')

  console.log('\n# A page that cannot be opened')
  await address.fill(closed)
  await address.press('Enter')
  await pane.getByRole('alert').filter({ hasText: /Could not connect/ }).waitFor({ timeout: 20_000 })
  check('a page that will not open says so, with a way to try again', await pane.getByRole('button', { name: 'Try again' }).isVisible())
  await address.fill(base)
  await address.press('Enter')
  await pane.getByRole('alert').filter({ hasText: /Could not connect/ }).waitFor({ state: 'detached', timeout: 20_000 })
  check('the next address replaces the message', true)

  console.log('\n# A page asks for the location')
  await until('the test page', () => view()?.url().startsWith(base))
  const asked = view().evaluate(() => new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('allowed'), (e) => resolve(`blocked:${e.code}`))))
  await pane.getByRole('alert').filter({ hasText: /wants to know your location/ }).waitFor({ timeout: 10_000 })
  check('the page asks in the panel, and names the site', await pane.getByRole('alert').getByText('127.0.0.1').first().isVisible())
  await pane.getByRole('button', { name: 'Block' }).click()
  check('Block refuses it', /^blocked/.test(await asked))

  console.log('\n# A download')
  // Playwright, which drives the app here, takes over downloads at the browser level and interrupts them, so only the start is checked:
  // the page's file shows in the panel by name. That it is saved is checked by hand (docs/BROWSER_PLAN.md, section 11).
  await app.app.evaluate(({ session }, folder) => {
    session.fromPartition('persist:celeste-browser').on('will-download', (_e, item) => item.setSavePath(`${folder}/${item.getFilename()}`))
  }, downloads.replace(/\\/g, '/'))
  await view().evaluate(() => {
    location.href = '/download'
  })
  await pane.getByText('report.txt').first().waitFor({ timeout: 10_000 })
  check('a download shows in the panel by its name', true)

  console.log('\n# Stepping aside, and the keys')
  const hidden = () =>
    viewMain(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const v = win.contentView.children.find((c) => c.webContents && !c.webContents.isDestroyed() && c.webContents.getURL().startsWith('http'))
      return v ? !v.getVisible() : null
    })
  check('the page is showing', (await hidden()) === false)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog').waitFor({ timeout: 5000 })
  await until('the page to step aside', async () => (await hidden()) === true)
  check('a dialog takes the page off the screen', true)
  check('and its picture stays in its place', await page.getByTestId('browser-page').locator('img').isVisible())
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 })
  await until('the page to come back', async () => (await hidden()) === false)
  check('closing the dialog brings it back', true)
  check('and the picture is gone', (await page.getByTestId('browser-page').locator('img').count()) === 0)

  // A key typed in the page, as a person would: the window must hear Ctrl+K.
  await viewMain(({ webContents }, prefix) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(prefix))
    wc?.focus()
    wc?.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] })
    wc?.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] })
  }, base)
  await page.getByRole('dialog').waitFor({ timeout: 5000 }).then(
    () => check('a window key typed in the page (Ctrl+K) reaches the window', true),
    () => check('a window key typed in the page (Ctrl+K) reaches the window', false)
  )
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)

  console.log('\n# A link in the chat')
  await pane.getByRole('button', { name: 'Close browser' }).click()
  await pane.waitFor({ state: 'detached', timeout: 5000 })
  await say('Send me a link please', 'the second page')
  // A page on this computer always opens in Celeste's browser, without asking.
  await page.getByRole('link', { name: 'the second page' }).first().click()
  await pane.waitFor({ timeout: 5000 })
  await until('the link to open in a new tab', async () => (await tabs().count()) === 2)
  await until('the second page', async () => (await view(`${base}/second`)?.title()) === 'Second page')
  check('a link to a page on this computer opens in Celeste’s browser at once, in its own tab', (await page.getByRole('dialog', { name: 'Open this link where?' }).count()) === 0)
  // Any other site asks the first time.
  await page.getByRole('link', { name: 'the docs' }).first().click()
  const choice = page.getByRole('dialog', { name: 'Open this link where?' })
  await choice.waitFor({ timeout: 5000 })
  check('a link to another site asks where it opens', true)
  await choice.getByLabel('Remember my choice').check()
  await choice.getByRole('button', { name: 'Celeste’s browser' }).click()
  await until('the docs in a third tab', async () => (await tabs().count()) === 3)
  check('it opens in Celeste’s browser, in its own tab', (await address.inputValue()).startsWith('https://example.com/docs'))
  await page.getByRole('link', { name: 'the docs' }).first().click()
  await until('a fourth tab', async () => (await tabs().count()) === 4)
  check('with the choice remembered, it opens without asking', (await page.getByRole('dialog', { name: 'Open this link where?' }).count()) === 0)

  console.log('\n# Deleting a chat closes its tabs')
  const open = () => viewMain(({ webContents }, prefix) => webContents.getAllWebContents().filter((w) => w.getURL().startsWith(prefix)).length, base)
  check('the chat’s local pages are open', (await open()) >= 2)
  const more = page.locator('button[aria-label^="More actions for Hello there"]')
  await more.locator('..').hover()
  await more.click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await until('the pages to close with the chat', async () => (await open()) === 0)
  check('deleting the chat closes its tabs', true)
} catch (err) {
  console.error(err)
  failures.push(String(err?.message ?? err))
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  site.close()
  for (const dir of [profile, downloads]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 })
    } catch {
      // A leftover temporary folder is harmless.
    }
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join('; ')}` : '\nAll browser checks passed.')
process.exit(failures.length ? 1 : 0)
