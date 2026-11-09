// The phone app against the real built Celeste, with Claude's real program talking to a stand-in for Anthropic's API
// (no account, no quota) and Copilot kept to itself. The phone is the real phone app (phone/dist) in a phone-sized window.
// It turns on Settings → Phone, pairs (comparing the three pictures on both screens), follows a chat started on the computer,
// sends from the phone, starts a new chat from the phone, approves a command from the phone, and is cut off when removed.
//   npm run verify:phone
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { FakeAnthropic } from '../src/core/adapters/claude/fake-anthropic.ts'
import { launch, root, saveSettings } from './lib/app.mjs'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

const dist = resolve(root, 'phone', 'dist')
if (!existsSync(join(dist, 'index.html'))) {
  console.error('Build the phone app first: npm --prefix phone run build')
  process.exit(1)
}
// The phone app's files, served the way the WebView would load them.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const site = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path))
  if (!file.startsWith(dist) || !existsSync(file)) return void res.writeHead(404).end()
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const phoneUrl = `http://127.0.0.1:${site.address().port}/`

const api = new FakeAnthropic((r) => {
  if (r.last.kind === 'tool_result') return [{ type: 'text', text: `Finished: ${r.last.text.trim()}` }]
  // A command that changes something, so Claude Code asks first (it runs read-only ones like echo without asking).
  if (r.last.text.includes('ASK ME'))
    return [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour should the button be?', header: 'Colour', multiSelect: false, options: [{ label: 'Pink', description: 'The accent' }, { label: 'Blue', description: 'Calmer' }] }] } }]
  if (r.last.text.includes('RUN IT')) return [{ type: 'tool_use', name: 'Bash', input: { command: 'mkdir made-on-approval && echo approved-from-the-phone', description: 'Make a folder' } }]
  return [{ type: 'text', text: `Echo: ${r.last.text}` }]
})
await api.start()

const profile = mkdtempSync(join(tmpdir(), 'celeste-phone-'))
// Folders to remove once Celeste has closed (Windows will not delete a folder an assistant is still working in).
const leftovers = []
let app
try {
  app = await launch({ width: 1280, height: 860, theme: null, profile, copilotKnowsNoOne: true, env: { ANTHROPIC_BASE_URL: api.url } })
  const { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana', defaults: { approval: 'ask' } })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  const settingsNav = (name) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name })

  console.log('\n# Claude, with a chat started on the computer')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav('AI vendors').click()
  const card = page.getByRole('heading', { name: 'Claude Agent', exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
  await card.getByRole('button', { name: 'Paste an API key instead' }).click()
  await card.getByLabel(/API key/).fill('sk-ant-api03-a-key-for-the-test-1234')
  await card.getByRole('button', { name: 'Save key' }).click()
  await card.getByText(/Connected · API key ending 1234/).waitFor({ timeout: 60_000 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByRole('button', { name: /^Model:/ }).first().click()
  for (let i = 0; i < 60 && (await page.getByRole('menuitemradio', { name: /^Haiku/ }).count()) === 0; i++) await page.waitForTimeout(300)
  await page.getByRole('menuitemradio', { name: /^Haiku/ }).first().click()
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('Say the word pong')
  await box.press('Enter')
  await page.getByText('Echo: Say the word pong').waitFor({ timeout: 90_000 })
  check('a Claude chat runs on the computer', true)

  console.log('\n# Settings → Phone')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav('Phone').click()
  await page.getByRole('switch', { name: 'Let my phone connect' }).click()
  await page.getByAltText("QR code to scan with the phone's camera").waitFor({ timeout: 15_000 })
  const status = await page.evaluate(() => window.celeste.core.call('phone.status', []))
  check(`Celeste listens for phones (port ${status.port}) and shows a QR code for ${status.installUrl}`, status.running && !!status.port && !!status.installUrl, JSON.stringify(status))
  const hello = await (await fetch(`http://127.0.0.1:${status.port}/hello`)).json()
  check('it says who it is, with a public key', hello.protocol === 1 && typeof hello.key === 'string' && hello.key.length > 40, JSON.stringify(hello))
  const install = await (await fetch(`http://127.0.0.1:${status.port}/`)).text()
  check('the page the QR opens offers the app', install.includes('Celeste for') && (status.apk ? install.includes('/celeste.apk') : install.includes('not on this computer')))
  await page.keyboard.press('Escape')

  console.log('\n# Pairing from the phone app')
  await app.app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 360, height: 780, title: 'Phone', useContentSize: true, webPreferences: { partition: 'phone-check' } })
    void w.loadURL(url)
  }, phoneUrl)
  let phone
  for (let i = 0; i < 50 && !phone; i++) {
    phone = app.app.windows().find((w) => w.url().startsWith(phoneUrl))
    if (!phone) await page.waitForTimeout(200)
  }
  await phone.waitForLoadState('domcontentloaded')
  await phone.getByPlaceholder('192.168.1.5:41234').fill(`127.0.0.1:${status.port}`)
  await phone.getByRole('button', { name: 'Connect', exact: true }).click()
  const pictures = phone.locator('.emoji span')
  await pictures.first().waitFor({ timeout: 15_000 })
  const onPhone = await pictures.allInnerTexts()
  const dialog = page.getByRole('dialog', { name: /wants to connect/ })
  await dialog.waitFor({ timeout: 15_000 })
  const onComputer = (await dialog.locator('span.text-\\[40px\\]').allInnerTexts()).map((s) => s.trim())
  check(`both screens show the same three pictures (${onPhone.join(' ')})`, onPhone.length === 3 && onPhone.join() === onComputer.join(), `${onPhone} vs ${onComputer}`)
  await dialog.getByRole('button', { name: 'Allow', exact: true }).click()
  await phone.getByText('connected.').waitFor({ timeout: 15_000 })
  check('the phone says it is connected after Allow', true)
  await phone.getByRole('button', { name: 'Go to chats' }).click()
  await phone.getByRole('button', { name: /Say the word pong/ }).waitFor({ timeout: 15_000 })
  check('the phone lists the chat from the computer, greeting the person by name', (await phone.locator('.greet').innerText()).includes('Dana'))

  console.log('\n# Following and sending from the phone')
  await phone.getByRole('button', { name: /Say the word pong/ }).click()
  await phone.getByText('Echo: Say the word pong').waitFor({ timeout: 15_000 })
  check('the phone shows the conversation as the computer has it', true)
  await phone.getByPlaceholder('Message Celeste').fill('Hello from the phone')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByText('Echo: Hello from the phone').waitFor({ timeout: 90_000 })
  check('a message sent on the phone is answered, live on the phone', true)
  await page.getByText('Echo: Hello from the phone').waitFor({ timeout: 15_000 })
  check('… and the same answer is on the computer', true)

  console.log('\n# A question, answered in the message box')
  await phone.getByPlaceholder('Message Celeste').fill('ASK ME something')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByText('Which colour should the button be?').waitFor({ timeout: 90_000 })
  check('the question shows with its options and a place for an answer of your own', (await phone.getByPlaceholder('Something else').count()) === 1)
  const answerBox = phone.getByPlaceholder('Type your answer')
  await answerBox.waitFor({ timeout: 5_000 })
  check('while it waits, the message box answers the question instead of queuing a message', true)
  await answerBox.fill('Teal, please')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByText(/Finished: .*Teal, please/).waitFor({ timeout: 90_000 })
  check('the typed answer reached Celeste and the turn carried on', true)
  const inline = await phone.evaluate(() => !document.querySelector('.activity'))
  check('what Celeste is doing shows under the newest message, not at the bottom of the screen', inline)

  console.log('\n# A new chat from the phone, with an approval')
  await phone.getByRole('button', { name: 'Back' }).click()
  await phone.getByRole('button', { name: /New chat/ }).click()
  await phone.getByPlaceholder('Message Celeste').fill('RUN IT please')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 90_000 })
  check('the command waits for approval on the phone', (await phone.locator('.approval.pending').innerText()).includes('mkdir made-on-approval'))
  const boot = await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))
  const fromPhone = boot.sessions.find((s) => s.title.startsWith('RUN IT'))
  check('the new chat is on the computer, with Claude and the person’s approval setting', fromPhone?.vendor === 'claude' && fromPhone?.approval === 'ask', JSON.stringify(fromPhone))
  await phone.getByRole('button', { name: 'Approve' }).click()
  await phone.getByText(/Finished: approved-from-the-phone/).waitFor({ timeout: 90_000 })
  check('approved on the phone, the command ran on the computer and the answer came back', true)

  console.log('\n# A Develop session from the phone, in a project used on the computer')
  const project = mkdtempSync(join(tmpdir(), 'celeste-phone-project-'))
  await page.evaluate((cwd) => window.celeste.core.call('sessions.create', [{ vendor: 'claude', mode: 'develop', title: 'Earlier work', model: 'claude-haiku-4-5', effort: null, approval: 'ask', cwd }]), project)
  await phone.getByRole('button', { name: 'Back' }).click()
  await phone.getByRole('button', { name: /New chat/ }).click()
  await phone.getByRole('button', { name: 'Develop', exact: true }).click()
  const projectName = project.split(/[\\/]/).pop()
  await phone.getByRole('button', { name: new RegExp(projectName) }).waitFor({ timeout: 15_000 })
  check('the phone lists the project used for Develop on the computer', true)
  await phone.getByPlaceholder('Message Celeste').fill('Tidy the readme')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByText('Echo: Tidy the readme').waitFor({ timeout: 90_000 })
  const dev = (await page.evaluate(() => window.celeste.core.call('app.bootstrap', []))).sessions.find((s) => s.title.startsWith('Tidy the readme'))
  check('a Develop session started on the phone works in that project on the computer', dev?.mode === 'develop' && dev?.cwd === project, JSON.stringify(dev))
  leftovers.push(project)

  console.log('\n# What a phone may not do')
  const refused = await phone.evaluate(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', body: JSON.stringify({ phone: 'someone-else', box: 'AAAA' }) })
    return r.status
  }, status.port)
  check('a request that is not from a paired phone is refused', refused === 401, String(refused))

  console.log('\n# Removing the phone')
  const id = (await page.evaluate(() => window.celeste.core.call('phone.status', []))).phones[0]?.id
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settingsNav('Phone').click()
  await page.getByRole('button', { name: 'Remove' }).click()
  await phone.getByText(/removed on the computer/).waitFor({ timeout: 20_000 })
  check('removed on the computer, the phone is cut off at once and asks to connect again', !!id)
} catch (err) {
  console.log(`FAIL  ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  failures.push('crashed')
  const phone = app?.app.windows().find((w) => w.url().startsWith(phoneUrl))
  if (phone) console.log('The phone showed:\n' + (await phone.evaluate(() => document.body.innerText).catch(() => '?')).slice(0, 1500))
} finally {
  await app?.close().catch(() => undefined)
  await api.stop()
  site.close()
  rmSync(profile, { recursive: true, force: true })
  for (const f of leftovers) rmSync(f, { recursive: true, force: true })
}

console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed')
process.exit(failures.length ? 1 : 0)
