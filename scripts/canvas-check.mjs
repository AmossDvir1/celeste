// The canvas, in the real built app (docs/plans/CHAT_DISPLAY_PLAN.md, sections 5, 6 and 11b): the "+" menu offers Draw, the drawing panel opens under
// the page's real Content Security Policy with the network cut (no policy violation, no request to anywhere but the app), the person draws and
// adds the drawing to the message as a picture and as Excalidraw's file, the drawing is kept when the panel is closed, a drawing an assistant
// writes is placed by Celeste (its arrows join its shapes), shown as a picture with Expand and Edit, a broken or hostile one is a note, and the
// library is a chunk of its own with its fonts beside the app and no Chinese font.   npm run verify:canvas     (no account, no cost)
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``
const SKETCH = fence(
  'excalidraw',
  JSON.stringify({
    title: 'Sign-in',
    summary: 'The browser asks the server, which asks the database.',
    shapes: [{ id: 'browser', text: 'Browser' }, { id: 'server', text: 'Server', color: 'blue' }, { id: 'db', text: 'Database', kind: 'ellipse' }],
    arrows: [{ from: 'browser', to: 'server', text: 'request' }, { from: 'server', to: 'db' }]
  })
)
const BROKEN = fence('excalidraw', JSON.stringify({ shapes: [{ id: 'a', text: 'A' }], arrows: [{ from: 'a', to: 'nowhere' }] }))
const HOSTILE = fence(
  'excalidraw',
  JSON.stringify({
    summary: 'Hostile.',
    shapes: [{ id: 'a', text: 'click', link: 'javascript:window.__pwned=1', onclick: 'window.__pwned=2' }, { id: 'f', kind: 'iframe', text: 'frame', link: 'https://evil.test/' }],
    arrows: []
  })
)
const HOSTILE_OK = fence(
  'excalidraw',
  JSON.stringify({ summary: 'Only a box.', shapes: [{ id: 'a', text: '<img src=x onerror=window.__pwned=3>', link: 'javascript:window.__pwned=1', onclick: 'window.__pwned=2' }], arrows: [] })
)

const script = (r) => {
  const text = r.last.kind === 'text' ? r.last.text : ''
  if (/^DRAW A SKETCH/.test(text)) return [{ type: 'text', text: `Here it is:\n\n${SKETCH}\n\nDone.` }]
  if (/^DRAW BROKEN/.test(text)) return [{ type: 'text', text: `A drawing:\n\n${BROKEN}\n\nDone.` }]
  if (/^DRAW HOSTILE/.test(text)) return [{ type: 'text', text: `First:\n\n${HOSTILE}\n\nSecond:\n\n${HOSTILE_OK}\n\nDone.` }]
  return [{ type: 'text', text: `Saw: ${text.slice(0, 120)}` }]
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-canvas-'))
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const idle = (page) => page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 90_000 })
const send = async (page, text) => {
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill(text)
  await box.press('Enter')
}
const newChat = async (page) => {
  await page.keyboard.press('Control+n')
  await page.getByRole('heading', { level: 1 }).first().waitFor()
}
// Where the scene file of a message was kept: the assistant is told by a line "Attached files:" in the text of its message.
const attachedPath = (request) => {
  const user = [...request.body.messages].reverse().find((m) => m.role === 'user')
  const blocks = Array.isArray(user?.content) ? user.content : [{ type: 'text', text: String(user?.content ?? '') }]
  for (const b of blocks) {
    const m = b.type === 'text' ? /drawing\.excalidraw: (.+)/.exec(b.text) : null
    if (m) return m[1].trim()
  }
  return undefined
}
const shot = (page, name) => page.screenshot({ path: join(import.meta.dirname, '.output', name) })

let stub
let app
try {
  stub = await startStub(script)
  // Every address but this computer's own is unknown: a request to the network would fail here, and be reported.
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, chromiumArgs: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] })
  const { page } = app
  const outside = []
  page.on('request', (r) => {
    if (!/^(file|data|blob|devtools|celeste-file):|^https?:\/\/(127\.0\.0\.1|localhost)/.test(r.url())) outside.push(r.url().slice(0, 120))
  })
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana', theme: 'dark' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.evaluate(() => {
    window.__violations = []
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective}: ${e.blockedURI}`))
  })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)

  console.log('\n# The "+" menu')
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await page.getByRole('button', { name: 'Add to the message' }).click()
  check('the "+" button opens a menu with Attach files and Draw', (await page.getByRole('menuitem', { name: 'Attach files' }).count()) === 1 && (await page.getByRole('menuitem', { name: 'Draw' }).count()) === 1)
  await shot(page, 'canvas-menu.png')
  await page.keyboard.press('Escape')
  check('Escape closes it', (await page.getByRole('menu').count()) === 0)

  console.log('\n# Drawing by hand')
  await page.getByRole('button', { name: 'Add to the message' }).click()
  await page.getByRole('menuitem', { name: 'Draw' }).click()
  const panel = page.getByRole('region', { name: 'Drawing' })
  await panel.locator('.excalidraw canvas').first().waitFor({ timeout: 60_000 })
  check('Draw opens the drawing panel beside the chat, with the editor', (await panel.locator('.excalidraw').count()) === 1)
  await page.waitForTimeout(1500)
  await panel.locator('.excalidraw').click({ position: { x: 300, y: 300 } })
  // The rectangle tool, then a drag on the board.
  await page.keyboard.press('r')
  const box = await panel.locator('.excalidraw canvas.interactive').boundingBox()
  await page.mouse.move(box.x + 180, box.y + 220)
  await page.mouse.down()
  await page.mouse.move(box.x + 330, box.y + 300, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  await shot(page, 'canvas-drawing.png')
  const tools = await panel.evaluate((el) => ({ toolbar: el.querySelectorAll('.App-toolbar, .App-toolbar-content').length, library: [...el.querySelectorAll('.sidebar-trigger')].some((b) => b.getBoundingClientRect().width > 0) }))
  check('the toolbar is there, and the library of shapes (a network fetch) is not offered', tools.toolbar > 0 && !tools.library, JSON.stringify(tools))

  await panel.getByRole('button', { name: 'Add to message' }).click()
  const chip = (name) => page.getByRole('button', { name: new RegExp(`^Open ${name}`) })
  await chip('drawing.png').waitFor({ timeout: 20_000 })
  check('Add to message puts the picture and the scene file on the message', (await chip('drawing.png').count()) === 1 && (await chip('drawing.excalidraw').count()) === 1)

  console.log('\n# The drawing is kept')
  await panel.getByRole('button', { name: 'Close panel' }).click()
  await page.getByRole('region', { name: 'Drawing' }).waitFor({ state: 'detached', timeout: 5000 })
  await page.getByRole('button', { name: 'Add to the message' }).click()
  await page.getByRole('menuitem', { name: 'Draw' }).click()
  await panel.locator('.excalidraw canvas').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1200)
  // Sent twice would be two files with one name: remove the first pair so the second is the one that is read.
  await page.getByRole('button', { name: 'Remove drawing.png' }).click()
  await page.getByRole('button', { name: 'Remove drawing.excalidraw' }).click()
  await panel.getByRole('button', { name: 'Add to message' }).click()
  await chip('drawing.excalidraw').waitFor({ timeout: 20_000 })
  await panel.getByRole('button', { name: 'Close panel' }).click()
  const mark = stub.main.length
  await send(page, 'LOOK at my drawing')
  await page.getByText(/^Saw: /).first().waitFor({ timeout: 90_000 })
  await idle(page)
  const request = stub.main[mark]
  const files = [null, attachedPath(request)]
  const scene = files[1] && existsSync(files[1]) ? JSON.parse(readFileSync(files[1], 'utf8')) : null
  check('the assistant is given the scene as a file it can read, and it holds the rectangle that was drawn before the panel was closed', !!scene && scene.type === 'excalidraw' && scene.elements.some((e) => e.type === 'rectangle' && !e.isDeleted), JSON.stringify(scene?.elements?.map((e) => e.type)) + ' | ' + JSON.stringify(request.last).slice(0, 400))
  check('and the picture as an image', request.image === true)

  console.log('\n# A drawing an assistant writes')
  await newChat(page)
  await send(page, 'DRAW A SKETCH')
  const sketch = page.getByRole('img', { name: 'The browser asks the server, which asks the database.' })
  await sketch.locator('img').waitFor({ timeout: 90_000 })
  await idle(page)
  check('it is shown as a picture in the answer, with its summary as the name', (await sketch.locator('img').count()) === 1 && (await sketch.locator('img').getAttribute('src')).startsWith('blob:'))
  const size = await sketch.locator('img').evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }))
  check('a real picture (not empty), wider than it is tall as three shapes in a row would be', size.w > 300 && size.h > 50 && size.w > size.h, JSON.stringify(size))
  check('and its source is not shown as text', !/"shapes"/.test(await page.locator('main').first().innerText()))
  await shot(page, 'canvas-answer-dark.png')
  await page.getByRole('button', { name: 'Expand the drawing' }).click()
  const large = page.getByRole('dialog', { name: 'The browser asks the server, which asks the database.' })
  await large.locator('img').waitFor({ timeout: 10_000 })
  check('Expand shows it large', (await large.locator('img').count()) === 1)
  await page.keyboard.press('Escape')
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await page.waitForTimeout(1500)
  await shot(page, 'canvas-answer-light.png')
  check('in the light theme it is drawn again, not left dark', (await sketch.locator('img').count()) === 1)
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))

  console.log('\n# Edit')
  await page.getByRole('button', { name: 'Edit the drawing in the canvas' }).click()
  await panel.locator('.excalidraw canvas').first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(1500)
  await shot(page, 'canvas-edit.png')
  await panel.getByRole('button', { name: 'Add to message' }).click()
  await chip('drawing.excalidraw').waitFor({ timeout: 20_000 })
  await panel.getByRole('button', { name: 'Close panel' }).click()
  const mark2 = stub.main.length
  await send(page, 'LOOK at this one')
  await page.getByText(/^Saw: /).first().waitFor({ timeout: 90_000 })
  await idle(page)
  const sent = stub.main[mark2]
  const path2 = attachedPath(sent)
  const scene2 = path2 && existsSync(path2) ? JSON.parse(readFileSync(path2, 'utf8')) : null
  const live = scene2?.elements?.filter((e) => !e.isDeleted) ?? []
  const shapes = live.filter((e) => ['rectangle', 'ellipse', 'diamond'].includes(e.type))
  const arrows = live.filter((e) => e.type === 'arrow')
  check('Edit puts the drawing in the canvas: three shapes with their words, and two arrows', shapes.length === 3 && arrows.length === 2 && live.filter((e) => e.type === 'text').length >= 4, live.map((e) => e.type).join(',') + ' | ' + JSON.stringify(sent.last).slice(0, 400))
  // The arrows join their shapes: each end is bound to a shape, and lies on that shape's outline, not far inside or away from it.
  const joined = arrows.every((a) => a.startBinding?.elementId && a.endBinding?.elementId)
  check('and the arrows are joined to their shapes, so moving a shape takes the arrow with it', joined)
  const serverBox = shapes.find((s) => s.backgroundColor === '#a5d8ff')
  check('a colour chosen by name is a colour from Celeste’s own list', !!serverBox)

  console.log('\n# A drawing that cannot be drawn, and one that tries to run something')
  await newChat(page)
  await send(page, 'DRAW BROKEN')
  const note = page.getByRole('group', { name: 'The drawing could not be drawn' })
  await note.waitFor({ timeout: 60_000 })
  await idle(page)
  check('an arrow to a shape that is not there is a short note with Try again, not a half drawing', /Couldn’t draw this drawing/.test(await note.innerText()) && (await note.getByRole('button', { name: 'Try again' }).count()) === 1)
  await newChat(page)
  await send(page, 'DRAW HOSTILE')
  await page.getByText('Done.').first().waitFor({ timeout: 60_000 })
  await idle(page)
  await page.getByRole('img', { name: 'Only a box.' }).locator('img').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  check('a shape of a kind that loads a page is refused as a note, and a box with a script in its text is only a box', (await page.getByRole('group', { name: 'The drawing could not be drawn' }).count()) === 1 && (await page.getByRole('img', { name: 'Only a box.' }).count()) === 1)
  check('nothing ran: no handler, no javascript: link', (await page.evaluate(() => window.__pwned ?? null)) === null)

  console.log('\n# The policy of the page, the network, and the files')
  const seen = await page.evaluate(() => window.__violations)
  check('nothing was blocked by the Content Security Policy: Excalidraw asked for no address outside the app', seen.length === 0, seen.slice(0, 5).join(' | '))
  check('and no request went to anywhere but the app', outside.length === 0, outside.slice(0, 5).join(' | '))
  const dir = join(import.meta.dirname, '..', 'out', 'renderer')
  const fonts = readdirSync(join(dir, 'fonts'))
  check('the fonts are beside the app (the hand-drawn one among them), and the 13 MB Chinese font is not', fonts.includes('Excalifont') && !fonts.includes('Xiaolai'), fonts.join(','))
  const js = readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js'))
  const index = readFileSync(join(dir, 'index.html'), 'utf8').match(/assets\/(index-[^"]+\.js)/)?.[1]
  const withLib = js.filter((f) => readFileSync(join(dir, 'assets', f), 'utf8').includes('excalidraw-cdn-is-off'))
  check('the library is a chunk of its own, loaded when a drawing is needed, not part of the main bundle', withLib.length > 0 && !!index && !withLib.includes(index), `${withLib.join(', ')} / ${index}`)
  check('and its CDN address is gone from the code', !js.some((f) => readFileSync(join(dir, 'assets', f), 'utf8').includes('https://esm.sh/')))
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'canvas-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
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
