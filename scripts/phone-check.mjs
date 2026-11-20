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
import { openKeyField } from './lib/stub.mjs'

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
  if (r.last.text.includes('BG SHORT')) return [{ type: 'tool_use', name: 'Bash', input: { command: 'node -e "setTimeout(()=>console.log(\'bg-output-line\'),4000)"', run_in_background: true, description: 'Wait four seconds' } }]
  if (r.last.text.includes('BG LONG')) return [{ type: 'tool_use', name: 'Bash', input: { command: 'node -e "setTimeout(()=>{},60000)"', run_in_background: true, description: 'Wait a minute' } }]
  if (r.last.text.includes('RUN IT')) return [{ type: 'tool_use', name: 'Bash', input: { command: 'mkdir made-on-approval && echo approved-from-the-phone', description: 'Make a folder' } }]
  // A diagram, a chart, steps and a drawing: the phone draws them too (phone/src/Pictures.tsx), and never shows their source.
  if (r.last.text.includes('DRAW FOR PHONE')) {
    const fence = (lang, body) => '```' + lang + '\n' + body + '\n```'
    const chart = { type: 'bar', labels: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Sales', data: [3, 5, 8] }], summary: 'Sales grew.' }
    const steps = { title: 'Set it up', steps: [{ title: 'Open the folder', text: 'Go to the project.', copy: 'cd project' }, { title: 'Read the guide', link: { label: 'The guide', url: 'https://example.com/guide' } }] }
    const drawing = { summary: 'A sketch of the page.', shapes: [{ id: 'SKETCHSRC', text: 'Header' }, { id: 'body', text: 'Body', kind: 'ellipse' }], arrows: [{ from: 'SKETCHSRC', to: 'body', text: 'then' }] }
    return [{ type: 'text', text: ['Here you go.', fence('mermaid', '%% summary: Sign-in goes from the form to the server.\nflowchart TD\n  FORMSRC[Form] --> SERVERSRC[Server]'), fence('chart', JSON.stringify(chart)), fence('steps', JSON.stringify(steps)), fence('excalidraw', JSON.stringify(drawing)), fence('ts', 'const plain = 1'), 'Done drawing.'].join('\n\n') }]
  }
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
  await openKeyField(card)
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

  console.log('\n# A sketch, drawn on the phone')
  // The page's picture is kept as it is made, so the check can look at what is sent.
  await phone.evaluate(() => {
    const real = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
      return real.call(this, (b) => ((window.__sketch = b), cb(b)), type, quality)
    }
  })
  // The "+" in the message box, as on the computer: one button, and a sheet with what can be added.
  const plus = phone.getByRole('button', { name: 'Add to the message' })
  const sheet = phone.getByRole('menu', { name: 'Add to the message' })
  await plus.click()
  await sheet.waitFor({ timeout: 10_000 })
  check('the + opens a small menu with the three things that can be added', (await sheet.getByRole('menuitem', { name: 'Attach files' }).count()) === 1 && (await sheet.getByRole('menuitem', { name: 'Take a photo' }).count()) === 1 && (await sheet.getByRole('menuitem', { name: 'Draw a sketch' }).count()) === 1)
  const menuBox = await sheet.boundingBox()
  const plusBox = await plus.boundingBox()
  check('it opens just above the button, not as a drawer over the screen', !!menuBox && !!plusBox && menuBox.y + menuBox.height <= plusBox.y + 1 && menuBox.width < 300 && Math.abs(menuBox.x - plusBox.x) < 40, JSON.stringify({ menuBox, plusBox }))
  await phone.screenshot({ path: join(root, 'scripts', '.output', 'phone-menu.png') })
  await phone.keyboard.press('Escape')
  await sheet.waitFor({ state: 'detached', timeout: 10_000 })
  check('Escape closes it and adds nothing', (await phone.locator('.achip').count()) === 0)
  check('the message box has the one + for them, not a button for each', (await phone.locator('.composer .attachbtn').count()) === 1 && (await phone.getByRole('button', { name: /Take a photo|Draw a sketch/ }).count()) === 0)
  // Attach files opens the system's chooser from the row that was pressed.
  await plus.click()
  await sheet.waitFor({ timeout: 10_000 })
  const chooser = phone.waitForEvent('filechooser', { timeout: 10_000 })
  await sheet.getByRole('menuitem', { name: 'Attach files' }).click()
  await (await chooser).setFiles({ name: 'notes-from-the-phone.txt', mimeType: 'text/plain', buffer: Buffer.from('a file from the phone') })
  const picked = phone.locator('.achip', { hasText: 'notes-from-the-phone.txt' })
  await picked.waitFor({ timeout: 15_000 })
  await phone.locator('.achip.busy').waitFor({ state: 'detached', timeout: 30_000 })
  check('Attach files from the sheet puts the file on the message, sent to the computer', (await picked.count()) === 1)
  await picked.getByRole('button', { name: /^Remove/ }).click()
  await picked.waitFor({ state: 'detached', timeout: 10_000 })
  await plus.click()
  await sheet.getByRole('menuitem', { name: 'Draw a sketch' }).click()
  const pad = phone.getByRole('dialog', { name: 'Sketch' })
  await pad.waitFor({ timeout: 10_000 })
  check('the sketch pad opens over the chat, and Add to message waits for a first line', await pad.getByRole('button', { name: 'Add to message' }).isDisabled())
  const canvas = pad.locator('canvas')
  const area = await canvas.boundingBox()
  const stroke = async (from, to) => {
    await phone.mouse.move(area.x + from[0], area.y + from[1])
    await phone.mouse.down()
    await phone.mouse.move(area.x + to[0], area.y + to[1], { steps: 14 })
    await phone.mouse.up()
  }
  await stroke([30, 60], [area.width - 30, 300])
  check('a line makes Add to message ready', await pad.getByRole('button', { name: 'Add to message' }).isEnabled())
  await pad.getByRole('radio', { name: 'Red' }).click()
  await pad.getByRole('radio', { name: 'Thick pen' }).click()
  await stroke([30, 340], [area.width - 30, 340])
  await pad.getByRole('radio', { name: 'Green' }).click()
  await stroke([30, 420], [area.width - 30, 440])
  await pad.getByRole('button', { name: 'Undo' }).click()
  await phone.screenshot({ path: join(root, 'scripts', '.output', 'phone-sketch.png') })
  await pad.getByRole('button', { name: 'Add to message' }).click()
  await pad.waitFor({ state: 'detached', timeout: 10_000 })
  const chip = phone.locator('.achip', { hasText: 'sketch.png' })
  await chip.waitFor({ timeout: 10_000 })
  await phone.locator('.achip.busy').waitFor({ state: 'detached', timeout: 30_000 })
  check('the pad closes and the sketch is a picture on the message, sent to the computer', (await chip.count()) === 1)
  const made = await phone.evaluate(async () => {
    const blob = window.__sketch
    const bitmap = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bitmap.width
    c.height = bitmap.height
    const ctx = c.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    const near = (r, g, b, want) => Math.abs(r - want[0]) < 40 && Math.abs(g - want[1]) < 40 && Math.abs(b - want[2]) < 40
    const count = { black: 0, red: 0, green: 0, white: 0 }
    for (let i = 0; i < data.length; i += 4) {
      if (near(data[i], data[i + 1], data[i + 2], [27, 27, 31])) count.black++
      else if (near(data[i], data[i + 1], data[i + 2], [217, 54, 54])) count.red++
      else if (near(data[i], data[i + 1], data[i + 2], [31, 157, 85])) count.green++
      else if (near(data[i], data[i + 1], data[i + 2], [255, 255, 255])) count.white++
    }
    return { type: blob.type, width: bitmap.width, height: bitmap.height, ...count }
  })
  check('it is a PNG with its longer side at 1024 pixels, in the shape of the page', made.type === 'image/png' && Math.max(made.width, made.height) === 1024 && Math.abs(made.width / made.height - area.width / area.height) < 0.02, JSON.stringify(made))
  check('it has the black line and the red one, a white page, and not the green line that was undone', made.black > 500 && made.red > 500 && made.green === 0 && made.white > made.width * made.height * 0.8, JSON.stringify(made))
  await phone.getByPlaceholder('Message Celeste').fill('Here is my sketch')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  // With a picture attached the model's last words are the picture's marker, so the request itself is looked at, not the echo.
  const sketchRequest = () => api.main.find((r) => JSON.stringify(r.body.messages).includes('Here is my sketch'))
  for (let i = 0; i < 300 && !sketchRequest(); i++) await page.waitForTimeout(200)
  const sent = sketchRequest()
  const lastUser = sent ? [...sent.body.messages].reverse().find((m) => m.role === 'user') : undefined
  const images = Array.isArray(lastUser?.content) ? lastUser.content.filter((b) => b.type === 'image') : []
  check('the assistant is sent the picture with the message, as a PNG', images.length === 1 && images[0].source?.media_type === 'image/png', JSON.stringify(images.map((b) => b.source?.media_type)))
  check('and the message on the phone names it, with the chip gone', (await phone.getByText('sketch.png').count()) >= 1 && (await phone.locator('.achip').count()) === 0)
  // The turn must have ended before the next section talks to the same chat.
  await page.waitForTimeout(1500)
  await phone.getByRole('button', { name: /^Stop/ }).waitFor({ state: 'detached', timeout: 90_000 })
  await plus.click()
  await sheet.getByRole('menuitem', { name: 'Draw a sketch' }).click()
  await pad.waitFor({ timeout: 10_000 })
  await stroke([40, 80], [200, 200])
  await pad.getByRole('button', { name: 'Close the sketch' }).click()
  await pad.waitFor({ state: 'detached', timeout: 10_000 })
  check('closing the pad adds nothing to the message', (await phone.locator('.achip').count()) === 0)

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
  // While it works the box says what a message now does, on one line even on a narrow screen.
  const working = await phone.getByPlaceholder('Message to send next').boundingBox().catch(() => null)
  await phone.screenshot({ path: join(root, 'scripts', '.output', 'phone-working.png') })
  check('the message box says in a few words what a message does while it works, on one line', working !== null && working.height < 60, JSON.stringify(working))
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

  console.log('\n# A command that goes on in the background')
  await phone.getByPlaceholder('Message Celeste').fill('BG SHORT please')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 90_000 })
  await phone.getByRole('button', { name: 'Approve' }).click()
  await phone.getByText('Running in the background: Wait four seconds').waitFor({ timeout: 90_000 })
  check('the phone shows a command that goes on after the turn, with a Stop and a way to see its output', (await phone.getByRole('button', { name: 'Stop this command' }).count()) === 1 && (await phone.getByRole('button', { name: 'Show output' }).count()) === 1)
  await phone.getByRole('button', { name: 'Show output' }).click()
  await phone.getByLabel('Output').waitFor({ timeout: 10_000 })
  await phone.waitForFunction(() => /bg-output-line/.test(document.querySelector('[aria-label="Output"]')?.textContent ?? ''), undefined, { timeout: 30_000 })
  check('Show output reads what the command wrote, on the computer, through the phone link', true)
  await phone.getByRole('button', { name: 'Stop this command' }).waitFor({ state: 'detached', timeout: 30_000 })
  check('when the command ends the phone says how, and the Stop goes', true)
  await phone.getByText(/Echo:/).last().waitFor({ timeout: 60_000 })
  check('and what Claude says on its own about it comes to the phone too', true)

  await phone.getByPlaceholder('Message Celeste').fill('BG LONG please')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByRole('button', { name: 'Approve' }).waitFor({ timeout: 90_000 })
  await phone.getByRole('button', { name: 'Approve' }).click()
  await phone.getByText('Running in the background: Wait a minute').waitFor({ timeout: 90_000 })
  await phone.getByRole('button', { name: 'Stop this command' }).click()
  await phone.getByText('Stopped: Wait a minute').waitFor({ timeout: 30_000 })
  check('Stop on the phone ends that one command', true)

  console.log('\n# A diagram, a chart, steps and a drawing, drawn on the phone')
  await phone.getByPlaceholder('Message Celeste').fill('DRAW FOR PHONE')
  await phone.getByRole('button', { name: 'Send', exact: true }).click()
  await phone.getByText('Done drawing.').waitFor({ timeout: 90_000 })
  const answer = phone.locator('.m-ai').last()
  const arts = answer.locator('.pic-art')
  // The drawing is ready at once; the diagram's library is loaded when it is first needed, so both are waited for.
  for (let i = 0; i < 240 && (await arts.count()) < 2; i++) await page.waitForTimeout(250)
  check('a diagram is drawn on the phone, with its own labels', (await arts.nth(0).innerText()).includes('Form') && (await arts.nth(0).innerText()).includes('Server'), await arts.nth(0).innerText())
  check('with what it says in words under it', (await answer.getByText('Sign-in goes from the form to the server.').count()) === 1)
  const inked = () => answer.locator('canvas').evaluate((c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0))
  for (let i = 0; i < 40 && !(await inked()); i++) await page.waitForTimeout(250)
  check('a chart is drawn on a canvas, with its words under it', (await inked()) && (await answer.getByText('Sales grew.').count()) === 1)
  await answer.getByText('Show the numbers').click()
  check('and its numbers can be opened', (await answer.locator('.pic-table').innerText()).includes('Feb') && (await answer.locator('.pic-table').innerText()).includes('5'))
  const steps = answer.getByRole('region', { name: 'Set it up' })
  check('steps are a list with a title and a count', (await steps.getByText('0 of 2 done').count()) === 1 && (await steps.getByText('Open the folder').count()) === 1)
  check('with a line to copy and a link', (await steps.getByText('cd project').count()) === 1 && (await steps.getByRole('link', { name: /The guide/ }).getAttribute('href')) === 'https://example.com/guide')
  await steps.getByRole('checkbox', { name: /Step 1/ }).click()
  check('a step can be ticked, and the tick is kept on the phone', (await steps.getByText('1 of 2 done').count()) === 1 && (await phone.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('celeste.steps.')))))
  const drawn = await arts.nth(1).locator('div > svg').innerHTML()
  check('a drawing is drawn from its shapes and its arrow', ['Header', 'Body', 'then'].every((w) => drawn.includes(w)) && !drawn.includes('SKETCHSRC'))
  check('with its words under it', (await answer.getByText('A sketch of the page.').count()) === 1)
  await arts.nth(1).click()
  const viewer = phone.getByRole('dialog', { name: 'A sketch of the page.' })
  await viewer.waitFor({ timeout: 10_000 })
  const widthOf = () => viewer.locator('.pv-art').evaluate((e) => e.style.width)
  const before = await widthOf()
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  check('a tap opens a picture large, and Zoom in makes it larger', before === '100%' && (await widthOf()) === '150%', `${before} then ${await widthOf()}`)
  // Real touch: two fingers pinch the picture, one finger moves it, a double tap zooms (sent as touch events through the browser's own protocol).
  const cdp = await phone.context().newCDPSession(phone)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 }).catch(() => undefined)
  const scroller = viewer.locator('.pv-body')
  await viewer.getByRole('button', { name: 'Zoom out' }).click()
  const viewArea = await scroller.boundingBox()
  // The fingers are put on the picture itself (a short drawing leaves room below it), at its middle.
  const artBox = await viewer.locator('.pv-art').boundingBox()
  const mid = { x: viewArea.x + viewArea.width / 2, y: artBox.y + artBox.height / 2 }
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id: id + 1 })) })
  const zoomNow = async () => parseFloat(await widthOf())
  const under = () => viewer.locator('.pv-art').evaluate((a, c) => { const r = a.getBoundingClientRect(); return { x: (c.x - r.left) / r.width, y: (c.y - r.top) / r.height } }, mid)
  const here = await under()
  await touch('touchStart', [[mid.x - 30, mid.y], [mid.x + 30, mid.y]])
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[mid.x - 30 - i * 10, mid.y], [mid.x + 30 + i * 10, mid.y]])
  await touch('touchEnd', [])
  const pinched = await zoomNow()
  const after = await under()
  check('two fingers pinching apart zoom the picture in proportion (60 to 220 pixels is about 3.7 times), not the whole app', pinched > 330 && pinched < 400, `${pinched}%`)
  check('and the part of the picture between the fingers stays between them, while it scrolls to keep it there', Math.abs(after.x - here.x) < 0.04 && (await scroller.evaluate((e) => e.scrollWidth > e.clientWidth + 2)), `${JSON.stringify(here)} then ${JSON.stringify(after)}`)
  const left = await scroller.evaluate((e) => e.scrollLeft)
  await touch('touchStart', [[mid.x + 90, mid.y]])
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[mid.x + 90 - i * 12, mid.y]])
  await touch('touchEnd', [])
  check('one finger dragging moves the zoomed picture along', (await scroller.evaluate((e) => e.scrollLeft)) > left + 60, `${left} then ${await scroller.evaluate((e) => e.scrollLeft)}`)
  await touch('touchStart', [[mid.x - 110, mid.y], [mid.x + 110, mid.y]])
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[mid.x - 110 + i * 10, mid.y], [mid.x + 110 - i * 10, mid.y]])
  await touch('touchEnd', [])
  check('pinching together zooms out, and never past the screen’s own width', (await zoomNow()) >= 100 && (await zoomNow()) < 200, `${await zoomNow()}%`)
  while ((await zoomNow()) > 100.5) await viewer.getByRole('button', { name: 'Zoom out' }).click()
  const tap = async () => {
    await touch('touchStart', [[mid.x, mid.y]])
    await touch('touchEnd', [])
  }
  await tap()
  await phone.waitForTimeout(80)
  await tap()
  check('a double tap zooms in on the place, and another zooms back out', (await zoomNow()) > 220 && (await zoomNow()) < 280, `${await zoomNow()}%`)
  await phone.waitForTimeout(400)
  await tap()
  await phone.waitForTimeout(80)
  await tap()
  check('and back to the screen’s width', (await zoomNow()) === 100, `${await zoomNow()}%`)
  await phone.keyboard.down('Control')
  await phone.mouse.move(mid.x, mid.y)
  await phone.mouse.wheel(0, -100)
  await phone.keyboard.up('Control')
  await phone.waitForTimeout(150)
  check('Ctrl and the wheel (a trackpad’s pinch) zoom too', (await zoomNow()) > 150, `${await zoomNow()}%`)
  while ((await zoomNow()) > 100.5) await viewer.getByRole('button', { name: 'Zoom out' }).click()
  await phone.screenshot({ path: join(root, 'scripts', '.output', 'phone-viewer.png') })
  await viewer.getByRole('button', { name: 'Close the picture' }).click()
  await viewer.waitFor({ state: 'detached', timeout: 10_000 })
  await answer.screenshot({ path: join(root, 'scripts', '.output', 'phone-pictures.png') })
  // The colours come from the theme: in the light one the lines of a drawing are the light theme's ink.
  await phone.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  for (let i = 0; i < 20 && !(await arts.nth(1).locator('div > svg').innerHTML()).includes('#111b4c'); i++) await page.waitForTimeout(150)
  check('the pictures are drawn again in the other theme’s colours', (await arts.nth(1).locator('div > svg').innerHTML()).includes('#111b4c'))
  await phone.screenshot({ path: join(root, 'scripts', '.output', 'phone-pictures-light.png') })
  await phone.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  const shown = await answer.innerText()
  check('never the source of any of them', !/FORMSRC|SERVERSRC|SKETCHSRC|flowchart|mermaid|excalidraw|"shapes"|"steps"/.test(shown), shown)
  check('while an ordinary code block is still code', /const plain = 1/.test(shown))

  console.log('\n# Schedules on the phone')
  const call = (method, ...params) => page.evaluate(([m, p]) => window.celeste.core.call(m, p), [method, params])
  const until = async (fn, what) => {
    for (let i = 0; i < 60; i++) {
      if (await fn()) return true
      await page.waitForTimeout(250)
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  const wf = await call('workflows.save', {
    name: 'Phone schedule',
    description: '',
    definition: {
      nodes: [
        { id: 'start', type: 'start', name: 'Start', inputs: [] },
        { id: 'write', type: 'tool', name: 'Write', tool: { kind: 'file', op: 'write', path: 'p.md', content: 'hi' } },
        { id: 'end', type: 'end', name: 'End' }
      ],
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }]
    }
  })
  const sched = await call('schedules.save', { workflowId: wf.id, spec: { kind: 'daily', time: '07:30' }, inputs: {}, approved: true })
  await phone.getByRole('button', { name: 'Back' }).click()
  await phone.getByRole('button', { name: 'Workflows', exact: true }).click()
  const row = phone.getByRole('listitem', { name: /Phone schedule, Daily at 07:30/ })
  await row.waitFor({ timeout: 20_000 })
  check('the phone lists the computer’s schedules, with when each runs next', /Next:/.test(await row.innerText()), await row.innerText())
  await row.click()
  await until(async () => (await call('schedules.list')).find((x) => x.id === sched.id)?.enabled === false, 'the schedule to be switched off')
  check('switching one off on the phone switches it off on the computer', true)
  await row.click()
  await until(async () => (await call('schedules.list')).find((x) => x.id === sched.id)?.enabled === true, 'the schedule to be switched on')
  check('and on again', true)
  await call('workflows.save', { id: wf.id, name: 'Phone schedule', description: '', definition: { nodes: [{ id: 'start', type: 'start', name: 'Start', inputs: [] }, { id: 'write', type: 'tool', name: 'Write', tool: { kind: 'file', op: 'write', path: 'p.md', content: 'changed' } }, { id: 'end', type: 'end', name: 'End' }], edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }] } })
  await phone.getByText(/approve it again on the computer/).waitFor({ timeout: 20_000 })
  check('when the workflow changes the phone says it has to be approved again on the computer', true)
  check('and it cannot be switched back on from the phone', await row.isDisabled())
  const refusedOn = await call('schedules.setEnabled', sched.id, true).then(() => false, (err) => /approve this again|approve it again/i.test(String(err.message)))
  check('the computer refuses too', refusedOn)

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
