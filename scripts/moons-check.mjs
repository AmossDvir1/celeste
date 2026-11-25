// Two Moons in the real built app (docs/plans/TWO_MOONS_PLAN.md): a chat with two agents that Celeste gives turns to. Build and review with two
// notes (one fixed, one refused with a reason), Revert in Develop, plan then build with its card, find and fix a bug in two rounds, two reviews
// that look at once, Stop and a queued message, @Reviewer, a crash in the middle, and a console without errors. Pictures in both themes are
// taken WHILE each step runs (scripts/.output/moons-*.png).
//   npm run verify:moons     (no account, no cost)
//   MOONS_ONLY=A,B node scripts/moons-check.mjs     runs some scenarios only (C needs B, E's revert is part of C)
// Claude is real (the real SDK and program), for the chat and for the other moon; what each says is chosen by a stand-in for Anthropic's API
// (scripts/lib/stub.mjs). It tells the two apart, and a small helper request such as a chat's title, by the words Celeste gives each of them
// (src/core/moons/words.ts). Only Claude is connected, so both moons are Claude.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-moons-'))
const project = join(mkdtempSync(join(tmpdir(), 'celeste-moons-project-')), 'greeter')
const out = join(import.meta.dirname, '.output')
mkdirSync(out, { recursive: true })
mkdirSync(project, { recursive: true })

// ---- what the stand-in says ----

const GREETER = ['function greet(name) {', "  return 'Hello ' + name.trim()", '}', '', 'function area(w, h) {', '  return w * h', '}', '', 'module.exports = { greet, area }', ''].join('\n')
const PRICE = ['function total(price, tax) {', '  return price - tax', '}', '', 'module.exports = { total }', ''].join('\n')
const FENCE = '```'
const withBlock = (words, json) => `${words}\n${FENCE}moons\n${JSON.stringify(json)}\n${FENCE}`
const slow = (text, chunk = 6, delayMs = 250) => ({ type: 'text', text, chunk, delayMs })
const tool = (name, input) => ({ type: 'tool_use', name, input })

/** The runs that build and review, by the letter in the person's message ("TAG-B"). The file each writes, and what the Reviewer does each time. */
const BUILDS = {
  B: { file: 'greet.js', first: 'notes', second: 'clean' },
  M: { file: 'greet-motion.js', first: 'notes', second: 'clean' },
  I: { file: 'greet-crash.js', first: 'notes', second: 'hold' },
  G: { file: 'greet-stop.js', first: 'hold' },
  K: { file: 'greet-gpu.js', first: 'hold' },
  Q: { file: 'greet-queue.js', first: 'slow-clean' }
}
const NOTES = (file) => [
  { text: 'greet crashes when the name is missing.', file, line: 2, code: "return 'Hello ' + name.trim()" },
  { text: 'area should round its result to two decimals.', file, line: 6, code: 'return w * h' }
]
const FIXED = {
  say: 'I fixed the first note and left the second as it is.',
  answers: [
    { n: 1, fixed: true, say: 'name is turned into a string before trim.' },
    { n: 2, fixed: false, say: 'area gets exact numbers from its callers, and rounding would hide mistakes.' }
  ]
}
const STEPS = ['Add a farewell function', 'Export it next to greet', 'Say goodbye by name']

const all = (r) => JSON.stringify(r.body.messages ?? [])
/** What the person (or Celeste for the other moon) last wrote in this conversation, not a tool's result and not Claude Code's own reminders. */
const prompt = (r) => {
  for (const m of [...(r.body.messages ?? [])].reverse()) {
    if (m.role !== 'user') continue
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]
    const texts = blocks.filter((b) => b.type === 'text' && !String(b.text).trimStart().startsWith('<system-reminder>')).map((b) => String(b.text))
    if (texts.length) return texts.join('\n')
  }
  return ''
}
const tagIn = (s) => /TAG-([A-Z]+)/.exec(s)?.[1]
const countIn = (s, re) => (s.match(re) ?? []).length

/** Which agent a request belongs to, by what Celeste told it. */
function who(r) {
  const a = all(r)
  if (/The person is writing to you, not to the/.test(a)) return 'direct'
  if (/You are the Reviewer in a chat with another assistant/.test(a)) return 'reviewer'
  if (/You are the Planner in a chat with another assistant/.test(a)) return 'planner'
  if (/You are the Tester in a chat with another assistant/.test(a)) return 'tester'
  if (/You are Reviewer 2 in a chat with another assistant/.test(a)) return 'reviewer2'
  if (/You are Reviewer 1\./.test(a)) return 'reviewer1'
  return 'pen'
}

const requestsBy = []
const script = (r) => {
  // A small request that carries no tools (a title, a check Claude Code makes for itself) gets plain short words.
  if (!Array.isArray(r.body.tools) || r.body.tools.length === 0) return [{ type: 'text', text: 'Short answer' }]
  const role = who(r)
  const p = prompt(r)
  const tag = tagIn(p) ?? tagIn(all(r))
  requestsBy.push({ role, tag, p, at: Date.now() })
  const build = BUILDS[tag]
  switch (role) {
    case 'direct':
      return [slow(`TAG-${tag} answer: I would keep it as it is, the greeter reads well.`, 12, 150)]
    case 'reviewer': {
      if (!build) return [{ type: 'text', text: withBlock('Nothing to report.', { say: 'Fine.', findings: [] }) }]
      const checking = /answered your notes/.test(p)
      if (checking) {
        if (build.second === 'hold') return [{ type: 'hold' }]
        return process.env.MOONS_SCROLL_TEST === '1'
          ? [slow(withBlock('I looked at the change again.', { say: 'Both of my notes are dealt with.', findings: [] }), 4, 400)]
          : [slow(withBlock('I looked at the change again.', { say: 'Both of my notes are dealt with.', findings: [] }), 30, 500)]
      }
      if (build.first === 'hold') return [{ type: 'hold' }]
      if (build.first === 'slow-clean') return [slow(withBlock('I read it carefully.', { say: 'I found nothing wrong.', findings: [] }), 12, 400)]
      return [slow(withBlock('I read greet.js and found two problems.', { say: 'Two things to look at.', findings: NOTES(build.file) }), 40, 300)]
    }
    case 'planner':
      return [slow(withBlock('Here is how I would do it.', { say: 'Three steps, none of them risky.', steps: STEPS }), 40, 250)]
    case 'tester': {
      if (/says the problem is fixed/.test(p)) {
        // The first time it still fails, the second time it passes.
        const n = countIn(all(r), /says the problem is fixed/g)
        return n < 2
          ? [{ type: 'text', text: withBlock('It still gives the wrong total.', { say: 'It still fails: the total is not the sum.', failed: true, file: 'price.js', line: 2, code: 'return Math.abs(price - tax)' }) }]
          : [{ type: 'text', text: withBlock('It passes now.', { say: 'It passes now: the total is the sum.', failed: false }) }]
      }
      if (r.last.kind === 'tool_result') return [{ type: 'text', text: withBlock('I wrote a test and ran it.', { say: 'The total is wrong: it subtracts the tax.', failed: true, file: 'price.js', line: 2, code: 'return price - tax' }) }]
      return [slow('I will add a test that shows it.', 8, 200), tool('Write', { file_path: join(project, 'price.test.js'), content: "const { total } = require('./price')\nif (total(10, 2) !== 12) throw new Error('total(10, 2) should be 12')\n" })]
    }
    case 'reviewer1':
    case 'reviewer2': {
      const mine = role === 'reviewer1' ? [{ text: 'greet crashes when the name is missing.', file: 'greet.js', line: 2, code: "return 'Hello ' + name.trim()" }, { text: 'module.exports leaves out nothing, but there is no test.', file: 'greet.js', line: 9, code: 'module.exports = { greet, area }' }] : [{ text: 'a missing name makes trim throw.', file: 'greet.js', line: 3, code: '}' }, { text: 'area has no check for negative sizes.', file: 'util.js', line: 1, code: 'return w * h' }]
      return [slow(withBlock(`I read the files as ${role === 'reviewer1' ? 'Reviewer 1' : 'Reviewer 2'}.`, { say: role === 'reviewer1' ? 'Two things from me.' : 'Two things from me too.', findings: mine }), 20, 300)]
    }
  }
  // The pen: the chat's own agent.
  if (/TAG-[A-Z]*N\b/.test(p) && !build) return [{ type: 'text', text: `PLAIN ANSWER to: ${p.slice(0, 60)}` }]
  const asked = p
  if (/The person agreed to this plan/.test(asked)) {
    if (r.last.kind === 'tool_result') return [slow('Built the plan: farewell is in farewell.js.', 10, 200)]
    return [slow('I will build the plan now.', 8, 200), tool('Write', { file_path: join(project, 'farewell.js'), content: "function farewell(name) {\n  return 'Goodbye ' + name\n}\n\nmodule.exports = { farewell }\n" })]
  }
  if (/\[From the Tester/.test(asked)) {
    const n = countIn(all(r), /\[From the Tester/g)
    if (r.last.kind === 'tool_result') return [slow(withBlock('Changed the total.', { say: 'I changed the total.', answers: [{ n: 1, fixed: true, say: n < 2 ? 'The total now cannot go negative.' : 'The total is now price plus tax.' }] }), n < 2 ? 8 : 40, 250)]
    // The first time it looks around a lot, so the thinking map has long words to place.
    const around = n < 2 ? ['moons-6-reviewer-checks-dark.png', 'moons-1-builds-dark.png', 'Composer.tsx', 'moons-3-reviewer-looks-dark.png', 'sky-model.ts'].map((f) => tool('Read', { file_path: join(project, f) })).concat(tool('Grep', { pattern: 'a rather long thing to look for', path: project })) : []
    return [slow('Fixing the total.', 8, 200), ...around, tool('Edit', { file_path: join(project, 'price.js'), old_string: n < 2 ? 'return price - tax' : 'return Math.abs(price - tax)', new_string: n < 2 ? 'return Math.abs(price - tax)' : 'return price + tax' })]
  }
  if (/\[From the Reviewer/.test(asked) && build) {
    if (r.last.kind === 'tool_result') return [slow(withBlock('Fixed the first one.', FIXED), 24, 350)]
    return [slow('Fixing the first note.', 4, 250), tool('Edit', { file_path: join(project, build.file), old_string: 'name.trim()', new_string: 'String(name ?? "").trim()' })]
  }
  if (build && /TAG-/.test(asked)) {
    if (r.last.kind === 'tool_result') return [slow(`Wrote ${build.file} with greet and area.`, 6, 250)]
    return [slow('I will write the greeter now.', 6, 250), tool('Write', { file_path: join(project, build.file), content: GREETER })]
  }
  return [{ type: 'text', text: `PLAIN ANSWER to: ${asked.slice(0, 60)}` }]
}

// ---- helpers ----

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${String(detail).slice(0, 700)})`}`)
  if (!ok) failures.push(label)
}
const only = process.env.MOONS_ONLY?.split(',').map((s) => s.trim().toUpperCase())
const wanted = (letter) => !only || only.includes(letter)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stopButton = (page) => page.getByLabel('Stop', { exact: true })
const idle = (page) => stopButton(page).waitFor({ state: 'detached', timeout: 120_000 })
const box = (page) => page.getByRole('textbox', { name: 'Message' })
const send = async (page, text) => {
  await box(page).fill(text)
  await box(page).press('Enter')
}
const core = (page, method, ...params) => page.evaluate(([m, p]) => window.celeste.core.call(m, p), [method, params])
const shot = async (page, name) => {
  const gone = await processesGone(app)
  while (goneWhen.length < gone.length) {
    goneWhen.push(gone[goneWhen.length])
    console.log(`(before the picture "${name}" a process went away: ${JSON.stringify(goneWhen.at(-1))})`)
  }
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    // The colors fade from one theme to the other: the picture waits for the end of it.
    await sleep(350)
    await page.screenshot({ path: join(out, `moons-${name}-${theme}.png`) })
  }
}
/**
 * Whether the characters are drawn in the sky, and not only their glow: the whites of open eyes, counted in the dark theme, where nothing else
 * on that canvas is white for more than a few pixels.
 */
const eyes = async (page) => {
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await sleep(500)
  return page.evaluate(() => {
    const cv = document.querySelector('.moons-canvas')
    if (!cv || !cv.width) return -1
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 250 && d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) n++
    return n
  })
}
const MANY = 120
/**
 * How much the picture jumps at the edges of the sky, in levels of 255: the mean color of each line of pixels next to the edge, and the biggest step from
 * one line to the next. It is a blend when no line stands out. (Measured without the cards and the words. `extra` is for the control: an edge put there on purpose.)
 */
const edgeSteps = async (page, extra = '') => {
  const style = await page.addStyleTag({ content: `.moons-scene, .moons-talk, .moons-cap, .moons-thread > * { visibility: hidden !important } ${extra}` })
  await sleep(150)
  const png = (await page.screenshot()).toString('base64')
  const steps = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const cv = new OffscreenCanvas(bmp.width, bmp.height)
    const c = cv.getContext('2d')
    c.drawImage(bmp, 0, 0)
    const k = bmp.width / innerWidth
    const sky = document.querySelector('.moons-sky').getBoundingClientRect()
    const mean = (x, y, w, h) => {
      const d = c.getImageData(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))).data
      const m = [0, 0, 0]
      for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) m[j] += d[i + j]
      return m.map((v) => v / (d.length / 4))
    }
    const worst = (lines) => lines.slice(1).reduce((w, l, i) => Math.max(w, ...l.map((v, j) => Math.abs(v - lines[i][j]))), 0)
    const range = [...Array(25).keys()].map((i) => i - 12)
    return {
      top: worst(range.map((i) => mean(sky.left + sky.width * 0.35, sky.top + i, sky.width * 0.3, 1))),
      left: worst(range.map((i) => mean(sky.left + i, sky.top + 80, 1, sky.height - 120))),
      right: worst(range.map((i) => mean(sky.right + i, sky.top + 80, 1, sky.height - 120)))
    }
  }, png)
  await style.evaluate((el) => el.remove())
  return steps
}
const text = (page) => page.evaluate(() => document.body.innerText)
const everything = (page) => page.evaluate(() => document.body.textContent ?? '')
const sessionsNow = async (page) => (await core(page, 'app.bootstrap')).sessions
const logOf = async (page, id) => (await core(page, 'sessions.get', id)).events.map((e) => e.event)
const moonsOf = (events) => events.filter((e) => e.type.startsWith('moons.'))
const waitFor = async (what, fn, ms = 120_000, every = 100) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(every)
  }
  throw new Error(`Timed out waiting for ${what}`)
}
const hasEvent = (page, id, pred) => async () => (await logOf(page, id)).some(pred)
const turnOf = (step, seat) => (e) => e.type === 'moons.turn' && e.step === step && (seat === undefined || e.seat === seat)
const ended = (why) => (e) => e.type === 'moons.ended' && (why === undefined || e.why === why)
const skyHeight = (page) => page.evaluate(() => document.querySelector('.moons-sky')?.getBoundingClientRect().height ?? 0)
const read = (name) => readFileSync(join(project, name), 'utf8')
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim()

// What the console said, in every window of the whole run.
const consoleProblems = []
const watchConsole = (page) => {
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' || /Content[- ]Security[- ]Policy|Refused to|sky could not|Two Moons/i.test(t)) consoleProblems.push(`${m.type()}: ${t.slice(0, 400)}`)
  })
  page.on('pageerror', (e) => consoleProblems.push(`pageerror: ${e.message.slice(0, 400)}`))
}

// What the app's other processes did: a graphics process that goes away takes the characters with it.
const goneWhen = []
const watchProcesses = async (a) => {
  await a.app.evaluate(({ app }) => {
    globalThis.__gone = []
    app.on('child-process-gone', (_e, d) => globalThis.__gone.push({ at: Date.now(), type: d.type, reason: d.reason, code: d.exitCode }))
  })
}
const processesGone = async (a) => a.app.evaluate(() => globalThis.__gone ?? []).catch(() => [])

/** Text that must never be seen on the page: the block only Celeste reads, and the words Celeste passes between the moons. */
const LEAKS = [/```/, /"findings"/, /"answers"/, /"steps"\s*:/, /"failed"\s*:/, /\[From the (Reviewer|Builder|Tester|Planner)/, /Notes on your change/, /another assistant in this chat/]
const seen = new Set()
const watchLeaks = (page) => {
  let on = true
  ;(async () => {
    while (on) {
      try {
        const t = await everything(page)
        for (const re of LEAKS) if (re.test(t)) seen.add(String(re))
      } catch {
        /* the page is changing */
      }
      await sleep(200)
    }
  })()
  return {
    stop: () => {
      on = false
    }
  }
}

const PATTERN_LABEL = { build: 'Build and review', plan: 'Plan, then build', bug: 'Find and fix a bug', reviews: 'Two reviews' }
const picker = (page) => page.getByRole('group', { name: 'Two Moons', exact: true })
/** Opens the picker on the home screen (if it is not open) and chooses a pattern. */
async function choosePattern(page, pattern) {
  if (!(await picker(page).count())) {
    const add = page.getByRole('button', { name: /Add a second moon/ })
    if (await add.count()) await add.click()
    else await page.getByRole('button', { name: /^Two Moons ·/ }).click()
  }
  await picker(page).getByRole('button', { name: PATTERN_LABEL[pattern], exact: true }).click()
}
/** The home screen of a new session (Develop calls the button "New session"). */
const newSession = (page) => page.getByRole('button', { name: /^New (chat|session)$/ }).click()
const topChats = async (page) => (await sessionsNow(page)).filter((s) => !s.parentId)

/** A new chat with two moons that begins with `message`. Returns its id. */
async function moonsChat(page, pattern, message) {
  await newSession(page)
  await choosePattern(page, pattern)
  const before = new Set((await topChats(page)).map((s) => s.id))
  await send(page, message)
  const chat = await waitFor('the new chat', async () => (await topChats(page)).find((s) => !before.has(s.id)), 30_000)
  await box(page).waitFor()
  return chat.id
}
/** The other moon of a chat, as the list gives it. */
const childOf = async (page, id) => (await sessionsNow(page)).find((s) => s.parentId === id)

let stub
let app
let leaks
try {
  writeFileSync(join(project, 'price.js'), PRICE)
  writeFileSync(join(project, 'README.md'), '# greeter\n')
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=T', '-c', 'user.email=t@t', 'add', '.')
  git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')

  stub = await startStub(script)
  stub.naming = (message) => `Moons ${tagIn(message) ?? 'chat'}`
  app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, copilotKnowsNoOne: true })
  let { page } = app
  watchConsole(page)
  await watchProcesses(app)
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)
  leaks = watchLeaks(page)

  // Develop, on a real temporary git folder: the home screen has the picker, and a revert needs the saved copies.
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Develop' }).click()
  await app.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, project)
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  await page.getByText('main', { exact: true }).first().waitFor({ timeout: 10_000 })

  let build // the chat of scenario B

  if (wanted('A')) {
    console.log('\n# A. Starting: the picker on the home screen of a Develop chat')
    await newSession(page)
    await box(page).waitFor()
    check('no picker is open until it is asked for, and "Add a second moon" is there', (await picker(page).count()) === 0 && (await page.getByRole('button', { name: /Add a second moon/ }).count()) === 1)
    await shot(page, 'picker-off')
    await page.getByRole('button', { name: /Add a second moon/ }).click()
    for (const pattern of ['build', 'plan', 'bug', 'reviews']) {
      await choosePattern(page, pattern)
      const g = picker(page)
      const said = await g.innerText()
      const pressed = await g.getByRole('button', { name: PATTERN_LABEL[pattern], exact: true }).getAttribute('aria-pressed')
      check(`${pattern}: the pattern is pressed, and what happens is said in a sentence`, pressed === 'true' && /\w+ \w+ \w+ \w+/.test(said.split('\n').find((l) => l.length > 40) ?? ''), said)
      const names = { build: ['Builder', 'Reviewer'], plan: ['Planner', 'Builder'], bug: ['Tester', 'Builder'], reviews: ['Reviewer 1', 'Reviewer 2'] }[pattern]
      check(`${pattern}: both moons are named, each with the model it uses`, names.every((n) => new RegExp(`${n} uses`).test(said)), said)
      await shot(page, `picker-${pattern}-open`)
      await page.getByRole('button', { name: /^Two Moons ·/ }).click()
      check(`${pattern}: closed, it is one quiet line that names the pattern`, (await picker(page).count()) === 0 && (await page.getByRole('button', { name: new RegExp(`^Two Moons · ${PATTERN_LABEL[pattern]}`) }).count()) === 1)
      await shot(page, `picker-${pattern}-closed`)
      await page.getByRole('button', { name: /^Two Moons ·/ }).click()
    }
    await choosePattern(page, 'build')
    // The second moon gets a model of its own.
    const modelButtons = picker(page).getByRole('button', { name: /^Model:/ })
    await modelButtons.first().click()
    await page.getByRole('menuitemradio', { name: 'Haiku', exact: true }).click()
    check('the second moon’s model is its own: the menu button now says Haiku, the composer’s does not', /Haiku/.test((await modelButtons.first().getAttribute('aria-label')) ?? '') && !/Haiku/.test((await page.getByRole('button', { name: /^Model:/ }).first().getAttribute('aria-label')) ?? ''))
    await shot(page, 'picker-build-model')
    await page.getByRole('button', { name: 'Remove' }).click()
    check('Remove takes the second moon away again', (await picker(page).count()) === 0 && (await page.getByRole('button', { name: /Add a second moon/ }).count()) === 1)
    // Sending with the pattern chosen makes a chat with moons, and the other moon as a session that is not one of the chats.
    await choosePattern(page, 'build')
    const was = new Set((await topChats(page)).map((s) => s.id))
    await modelButtons.first().click()
    await page.getByRole('menuitemradio', { name: 'Haiku', exact: true }).click()
    await send(page, 'TAG-A say hello')
    const made = await waitFor('the chat', async () => (await topChats(page)).find((s) => !was.has(s.id)), 30_000)
    const kids = (await sessionsNow(page)).filter((s) => s.parentId === made.id)
    console.log('chat:', JSON.stringify({ ...made, title: undefined }), '\nchild:', JSON.stringify(kids[0]))
    check('the chat has moons: its pattern, and a child id', made.moons?.pattern === 'build' && typeof made.moons?.childId === 'string')
    check('and exactly one child session, the other moon, named for its role', kids.length === 1 && kids[0].id === made.moons.childId && kids[0].title === 'Reviewer', JSON.stringify(kids.map((k) => k.title)))
    // The list's summary carries `parentId` and `ceiling` and not the row's `spawn.moon` flag: a moon is told from a helper by the parent's `moons.childId` above.
    check('the child has the chat as its parent, and its ceiling is the mode it works in (a moon that only looks stays in plan)', kids[0]?.parentId === made.id && kids[0]?.ceiling === 'plan', JSON.stringify(kids[0]))
    check('it has the model that was chosen for it, and the chat keeps the composer’s', /haiku/i.test(kids[0]?.model ?? '') && !/haiku/i.test(made.model ?? ''), `${kids[0]?.model} / ${made.model}`)
    await box(page).waitFor()
    await waitFor('the end of the run', hasEvent(page, made.id, ended()), 60_000)
    await idle(page)
    // Folded behind "Second moon" while nothing works.
    const fold = page.getByRole('button', { name: /^Second moon$/ })
    const folded = await fold.count()
    if (folded) await fold.click()
    const helperRows = await page.locator('[data-helper-row]').count()
    const chatRows = await page.locator('[data-session-row]:not([data-helper-row])').filter({ hasText: 'Reviewer' }).count()
    check('it is in the sidebar under the chat, called the second moon, not as a chat of its own', folded === 1 && helperRows === 1 && chatRows === 0, `${helperRows} helper rows, ${chatRows} chat rows named Reviewer`)
    check('a message that changes nothing ends with no review', (await logOf(page, made.id)).filter(ended('nothing')).length === 1 && !(await logOf(page, made.id)).some((e) => e.type === 'moons.handed'))
    await shot(page, 'first-chat')
  }

  /** Waits for a hand-over of that kind in the chat's log. */
  const handed = (from, to) => (e) => e.type === 'moons.handed' && e.from === from && e.to === to
  const revertButtons = () => page.getByRole('button', { name: 'Revert to before this message' })

  /** Build and review with two notes, one picture at each step while it runs. `pics` is the prefix of the pictures; `full` runs every check. */
  async function buildAndReview(tag, message, pics, full) {
    const chat = await moonsChat(page, 'build', message)
    const file = BUILDS[tag].file
    await waitFor('the Builder writing', hasEvent(page, chat, (e) => e.type === 'message.delta'), 60_000)
    if (full) check('while the Builder builds the sky is up and the Stop button is there', (await skyHeight(page)) > 0 && (await stopButton(page).count()) === 1)
    await shot(page, `${pics}1-builds`)
    await waitFor('the hand-over', hasEvent(page, chat, handed(0, 1)), 60_000)
    await shot(page, `${pics}2-handover`)
    await sleep(1800)
    await waitFor('the Reviewer looking', hasEvent(page, chat, turnOf('review', 1)), 30_000)
    if (full) {
      check('during the Reviewer’s turn the Stop button is there, and the chat shows it is working', (await stopButton(page).count()) === 1 && (await skyHeight(page)) > 0)
      const header = page.getByRole('button', { name: /^Builder and Reviewer\./ })
      check('the header names both moons, and says who is working', (await header.count()) === 1 && /Reviewer is working/.test((await header.getAttribute('aria-label')) ?? ''), await header.getAttribute('aria-label'))
    }
    await shot(page, `${pics}3-reviewer-looks`)
    if (full) {
      // The thread scrolled up a little: what is under its lower edge fades out instead of being cut.
      await page.locator('.moons-thread').evaluate((el) => (el.scrollTop -= 190))
      await shot(page, `${pics}thread-fade`)
      await page.locator('.moons-thread').evaluate((el) => (el.scrollTop = el.scrollHeight))
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
        await sleep(400)
        const steps = await edgeSteps(page)
        check(`${theme}: the sky has no edge at its top or its sides`, Math.max(steps.top, steps.left, steps.right) < 1.2, JSON.stringify(steps))
        console.log(`      ${theme}: ${JSON.stringify(steps)}`)
        const control = await edgeSteps(page, '.moons-sky { background: color-mix(in srgb, var(--c-accent) 4%, transparent) !important }')
        check(`${theme}: and a faint edge put there is seen`, Math.min(control.top, control.left, control.right) > 1.2, JSON.stringify(control))
      }
    }
    await page.getByText(/Builder and Reviewer are talking/).first().waitFor({ timeout: 60_000 })
    if (full) {
      const talk = await page.locator('.moons-talk.on').evaluate((el) => {
        const style = getComputedStyle(el)
        return { overflowY: style.overflowY, pointerEvents: style.pointerEvents }
      })
      const still = await page.locator('.moons-talk.on').evaluate((el) => {
        const at = () => [...el.querySelectorAll('.moons-bb')].map((b) => Math.round(b.offsetLeft + b.offsetWidth)).join(',')
        const before = at()
        const tall = document.createElement('div')
        tall.style.cssText = 'flex:none;height:2000px'
        el.prepend(tall)
        const scrolls = el.scrollHeight > el.clientHeight
        const after = at()
        tall.remove()
        return { before, after, scrolls }
      })
      check('the bubbles stay where they are when the scroll bar comes', still.scrolls && still.before === still.after, JSON.stringify(still))
      check('the live conversation accepts pointer input and can scroll', /auto|scroll/.test(talk.overflowY) && talk.pointerEvents !== 'none', JSON.stringify(talk))
    }
    await shot(page, `${pics}4-conversation`)
    await waitFor('the Builder fixing', hasEvent(page, chat, turnOf('fix', 0)), 60_000)
    await sleep(600)
    await shot(page, `${pics}5-builder-fixes`)
    await waitFor('the check', hasEvent(page, chat, turnOf('check', 1)), 60_000)
    await sleep(600)
    if (full && process.env.MOONS_SCROLL_TEST === '1') {
      const talk = page.locator('.moons-talk.on')
      await waitFor('live talk to overflow', async () => (await talk.count()) > 0 && talk.evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0), 15_000)
      const dimensions = await talk.evaluate((el) => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, top: el.scrollTop }))
      if (dimensions.scrollHeight > dimensions.height && dimensions.top > 0) {
        const point = await talk.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const x = r.x + r.width / 2
          const y = r.y + r.height / 2
          return { x, y, target: document.elementFromPoint(x, y)?.className?.toString() }
        })
        await page.mouse.move(point.x, point.y)
        await page.mouse.wheel(0, -500)
        await sleep(150)
        const after = await talk.evaluate((el) => el.scrollTop)
        check('the mouse wheel scrolls back to earlier live messages', after < dimensions.top, `before: ${dimensions.top}; after: ${after}; target: ${point.target}`)
      } else {
        check('the live conversation has enough content to test scrolling', false, JSON.stringify(dimensions))
      }
    }
    await shot(page, `${pics}6-reviewer-checks`)
    await waitFor('the end', hasEvent(page, chat, ended()), 60_000)
    await shot(page, `${pics}7-done`)
    await idle(page)
    return chat
  }

  if (wanted('B')) {
    console.log('\n# B. Build and review, with two notes')
    build = await buildAndReview('B', 'TAG-B write a greeter with greet and area', '', true)
    const events = await logOf(page, build)
    const kinds = moonsOf(events).map((e) => e.type.replace('moons.', ''))
    console.log('moons events:', kinds.join(', '))
    check('the events come in order: turn, hand-over, the Reviewer’s words and two notes, the notes back, the fix, the check, the end', kinds.join(',') === 'turn,handed,said,said,said,handed,turn,said,said,said,turn,handed,said,fixed,ended', kinds.join(','))
    const said = events.filter((e) => e.type === 'moons.said')
    const notes = said.filter((e) => e.finding)
    check('the two notes carry the file, the line and the code', notes.length === 2 && notes[0].file === 'greet.js' && notes[0].line === 2 && notes[0].code === "return 'Hello ' + name.trim()" && notes[1].line === 6 && notes[1].code === 'return w * h', JSON.stringify(notes))
    const fixed = events.find((e) => e.type === 'moons.fixed')
    check('the first note is called fixed by the Reviewer’s check, and the second is not', fixed?.ids.length === 1 && fixed.ids[0] === notes[0].id, JSON.stringify(fixed))
    check('the run ended as agreed', events.find((e) => e.type === 'moons.ended')?.why === 'agreed')
    const from = events.filter((e) => e.type === 'user.message').map((e) => e.from ?? 'person')
    check('the person wrote one message; what Celeste passed between the moons is logged as Celeste’s, from the moon', from.filter((f) => f === 'person').length === 1 && from.includes('moon'), from.join(','))
    check('the Builder really wrote the file, and fixed the first note in it', existsSync(join(project, 'greet.js')) && /String\(name \?\? ""\)\.trim\(\)/.test(read('greet.js')) && /return w \* h/.test(read('greet.js')))
    const seenBy = requestsBy.filter((r) => r.role === 'reviewer' && r.tag === 'B')
    check('the Reviewer was given the request, the file and the diff, with the Builder’s words marked as another assistant’s', seenBy.length === 2 && /greet\.js/.test(seenBy[0].p) && /name\.trim\(\)/.test(seenBy[0].p) && /It is not the person’s words/.test(seenBy[0].p), seenBy[0]?.p.slice(0, 600))
    const fixAsk = requestsBy.find((r) => r.role === 'pen' && /\[From the Reviewer/.test(r.p))
    check('the Builder was given the notes numbered, and told it may refuse a wrong one', /1\. greet crashes/.test(fixAsk?.p ?? '') && /2\. area should round/.test(fixAsk?.p ?? '') && /do not change anything for it, and say why/.test(fixAsk?.p ?? ''), fixAsk?.p.slice(0, 500))
    // What is on the page.
    const body = await text(page)
    check('no moons block and none of the words Celeste passes between them is anywhere on the page, not even while they arrived', seen.size === 0, [...seen].join(' '))
    check('the person’s message is drawn once, and the notes passed to the Builder are not drawn as the person’s', body.split('TAG-B write a greeter').length === 2 && !/Notes on your change|From the Reviewer/.test(body))
    // What the moons say to each other in a run is one block, at its end: the Reviewer's notes, the Builder's answers, the Reviewer's check.
    const group = page.getByRole('group', { name: 'Builder and Reviewer talking' })
    const blocks = await group.count()
    const states = []
    for (let i = 0; i < blocks; i++) states.push(await group.nth(i).getByRole('button').first().getAttribute('aria-expanded'))
    check('the talk of the run is drawn as one block that has folded when it ended, with a count', blocks === 1 && states.every((s) => s === 'false') && /7 messages/.test(await group.nth(0).innerText()), `${blocks} blocks ${states} ${await group.allInnerTexts()}`)
    await shot(page, 'talk-folded')
    for (let i = 0; i < blocks; i++) await group.nth(i).getByRole('button').first().click()
    const bubbles = (await group.locator('.selectable').allInnerTexts()).join('\n---\n')
    check('opened, it shows the notes with their file, line and code', /greet\.js:2/.test(bubbles) && /return 'Hello ' \+ name\.trim\(\)/.test(bubbles) && /greet\.js:6/.test(bubbles) && /return w \* h/.test(bubbles), bubbles)
    const first = group.locator('.selectable').filter({ hasText: 'greet crashes when the name is missing' })
    const second = group.locator('.selectable').filter({ hasText: 'area should round its result' })
    check('"Fixed" is on the first note and not on the second', (await first.getByText('Fixed', { exact: true }).count()) === 1 && (await second.getByText('Fixed', { exact: true }).count()) === 0)
    check('the Builder’s answer for the second says why it did not change it', /rounding would hide mistakes/.test(bubbles))
    await shot(page, 'talk-open')
    // The sky is gone some seconds after the end.
    await waitFor('the sky to fold away', async () => (await skyHeight(page)) === 0, 30_000)
    check('some seconds after the end the sky is gone (height 0)', (await skyHeight(page)) === 0)
    await shot(page, 'after-sky')
    // The header opens the models panel.
    await page.getByRole('button', { name: /^Builder and Reviewer\. Models$/ }).click()
    await page.getByText('A change takes effect on its next turn.').waitFor({ timeout: 5000 })
    const panel = page.getByRole('dialog').filter({ hasText: 'A change takes effect' })
    const modelsIn = await panel.getByRole('button', { name: /^Model:/ }).count()
    check('the header opens a panel with a model for each moon', modelsIn === 2, `${modelsIn} model buttons: ${await panel.innerText()}`)
    await shot(page, 'header-panel')
    await page.keyboard.press('Escape')
  }

  if (wanted('C') && build) {
    console.log('\n# C. Revert undoes the whole run')
    check('only the person’s message has a Revert button, not what Celeste passed on', (await revertButtons().count()) === 1, await revertButtons().count())
    await revertButtons().click()
    const dialog = page.getByRole('dialog', { name: 'Revert to before this message?' })
    const list = dialog.getByRole('list', { name: 'Files that will change' })
    await list.waitFor({ timeout: 30_000 })
    const listed = await list.innerText()
    check('the dialog lists the file both turns of the Builder made', /greet\.js[\s\S]*Removed/.test(listed), listed)
    await shot(page, 'revert-dialog')
    await dialog.getByRole('button', { name: 'Revert 1 file' }).click()
    await page.getByText('Reverted: 1 removed.').waitFor({ timeout: 30_000 })
    check('the file is gone: it is as it was before both of the Builder’s turns', !existsSync(join(project, 'greet.js')))
    await shot(page, 'reverted')
  }

  if (wanted('M')) {
    console.log('\n# B again, with motion on (the PC asks for less motion; this is how it looks with the animations)')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const m = await buildAndReview('M', 'TAG-M write a greeter with greet and area', 'motion-', false)
    const kinds = moonsOf(await logOf(page, m)).map((e) => e.type.replace('moons.', ''))
    check('with motion on the run is the same run', kinds.join(',') === 'turn,handed,said,said,said,handed,turn,said,said,said,turn,handed,said,fixed,ended', kinds.join(','))
    await waitFor('the sky to fold away', async () => (await skyHeight(page)) === 0, 30_000)
    await page.emulateMedia({ reducedMotion: null })
  }

  if (wanted('D')) {
    console.log('\n# D. Plan, then build')
    const plan = await moonsChat(page, 'plan', 'TAG-D add a farewell next to greet')
    const card = page.getByRole('group', { name: 'Approval needed' }).last()
    await card.waitFor({ timeout: 90_000 })
    await sleep(1200)
    const cardText = await card.innerText()
    console.log('card:', JSON.stringify(cardText))
    const planCard = page.getByRole('group', { name: 'The plan' })
    const planTextNow = await planCard.innerText()
    check('the Planner’s plan is drawn as a card of its own, with its steps', (await planCard.count()) === 1 && STEPS.every((s) => planTextNow.includes(s)))
    check('and a card asks "Build it this way", without listing the steps again', /Build it this way/.test(cardText) && /3 steps/.test(cardText) && !STEPS.some((s) => cardText.includes(s)), cardText)
    check('the chat is waiting for the person, and the Builder has not been asked', (await core(page, 'app.bootstrap')).sessions.find((s) => s.id === plan)?.status === 'waiting' && !requestsBy.some((r) => r.role === 'pen' && /agreed to this plan/.test(r.p)))
    const body = await text(page)
    const each = STEPS.map((s) => `${s}: ${body.split(s).length - 1}`)
    const inPlan = await page.getByRole('group', { name: 'The plan' }).innerText()
    const inCard = cardText
    const inSky = (await page.locator('.moons-ask').count()) ? await page.locator('.moons-ask').innerText() : ''
    console.log('the steps on screen, each time they are drawn:', each.join('; '), '| in the plan card:', STEPS.filter((s) => inPlan.includes(s)).length, '| in the approval card:', STEPS.filter((s) => inCard.includes(s)).length, '| in the sky:', STEPS.filter((s) => inSky.includes(s)).length)
    await shot(page, 'plan-waits')
    await card.getByRole('button', { name: 'Deny', exact: true }).click()
    await page.getByText('The plan was not agreed. Say what to change.').waitFor({ timeout: 30_000 })
    await idle(page)
    check('Deny says so in a line, and the chat is idle', true)
    check('and the Builder was never asked, and nothing was written', !requestsBy.some((r) => r.role === 'pen' && /agreed to this plan/.test(r.p)) && !existsSync(join(project, 'farewell.js')))
    await shot(page, 'plan-declined')
    await send(page, 'TAG-D please plan it again')
    const again = page.getByRole('group', { name: 'Approval needed' }).last()
    await again.getByRole('button', { name: 'Allow', exact: true }).waitFor({ timeout: 90_000 })
    await again.getByRole('button', { name: 'Allow', exact: true }).click()
    await waitFor('the end', hasEvent(page, plan, (e) => e.type === 'moons.ended' && e.why === 'agreed'), 90_000)
    await idle(page)
    check('asking again plans again, and Allow builds the plan', existsSync(join(project, 'farewell.js')) && /Goodbye/.test(read('farewell.js')))
    const kinds = moonsOf(await logOf(page, plan)).map((e) => `${e.type.replace('moons.', '')}${e.why ? `:${e.why}` : ''}`)
    console.log('moons events:', kinds.join(', '))
    check('the log says: plan, declined, plan again, agreed, handed to the Builder, build, agreed', kinds.join(',') === 'turn,plan,ended:declined,turn,plan,agreed,handed,turn,ended:agreed', kinds.join(','))
    check('the second plan card says "You agreed"', (await page.getByRole('group', { name: 'The plan' }).getByText('You agreed').count()) === 1)
    await shot(page, 'plan-built')
  }

  if (wanted('E')) {
    console.log('\n# E. Find and fix a bug')
    const bug = await moonsChat(page, 'bug', 'TAG-E the total is wrong, it subtracts the tax')
    await waitFor('the Tester', hasEvent(page, bug, turnOf('test')), 30_000).catch(() => undefined)
    await waitFor('the first fix', hasEvent(page, bug, turnOf('fix')), 90_000)
    await shot(page, 'bug-fix-1')
    const words = page.locator('.moons-think .moons-word')
    await waitFor('the thinking map with its words', async () => (await words.count()) >= 5, 30_000)
    await sleep(2200)
    const map = await page.locator('.moons-think').evaluate((el) => {
      const card = el.getBoundingClientRect()
      const r = [...el.querySelectorAll('.moons-word')].map((w) => ({ text: w.textContent, ...w.getBoundingClientRect().toJSON() }))
      const out = r.filter((a) => a.left < card.left || a.right > card.right || a.top < card.top || a.bottom > card.bottom).map((a) => a.text)
      const over = r.flatMap((a, i) => r.slice(i + 1).filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map((b) => a.text + ' / ' + b.text))
      return { n: r.length, width: Math.round(card.width), out, over }
    })
    check('no word of the thinking map is cut by the card or lies over another', map.n >= 5 && map.out.length === 0 && map.over.length === 0, JSON.stringify(map))
    await shot(page, 'bug-map')
    await waitFor('the retest', hasEvent(page, bug, turnOf('retest')), 90_000)
    await waitFor('the second fix', async () => (await logOf(page, bug)).filter(turnOf('fix')).length === 2, 90_000)
    await shot(page, 'bug-fix-2')
    await waitFor('the end', hasEvent(page, bug, ended()), 90_000)
    await idle(page)
    const placeholder = await box(page).getAttribute('placeholder')
    check('the Two Moons placeholder describes using @ without naming just one moon', /@/.test(placeholder ?? '') && !/@(?:Tester|Builder)/i.test(placeholder ?? ''), placeholder)
    await box(page).fill('@')
    await sleep(300)
    const choice = (name) => page.getByRole('option', { name, exact: true }).or(page.getByRole('button', { name, exact: true }))
    const tester = await choice('Tester').count()
    const builder = await choice('Builder').count()
    check('typing @ offers both Tester and Builder for selection', tester > 0 && builder > 0, `Tester: ${tester}; Builder: ${builder}`)
    await shot(page, 'bug-mention')
    if (tester > 0 && builder > 0) {
      await choice('Tester').click()
      check('choosing Tester addresses the message to Tester', (await box(page).inputValue()) === '@Tester ', await box(page).inputValue())
      await box(page).fill('@')
      await choice('Builder').click()
      check('choosing Builder addresses the message to Builder', (await box(page).inputValue()) === '@Builder ', await box(page).inputValue())
    }
    await box(page).fill('')
    const events = await logOf(page, bug)
    const steps = events.filter((e) => e.type === 'moons.turn').map((e) => e.step)
    check('Tester makes it fail, Builder fixes, the Tester says it still fails, Builder fixes again, then it passes', steps.join(',') === 'test,fix,retest,fix,retest' && events.find((e) => e.type === 'moons.ended')?.why === 'agreed', steps.join(','))
    const mine = requestsBy.filter((r) => r.tag === 'E')
    check('the person’s message went to the Tester first, and the Builder was not asked before it', mine[0]?.role === 'tester' && mine.findIndex((r) => r.role === 'pen') > 0, mine.map((r) => r.role).join(','))
    check('the Tester was told to make it happen and not to fix it; the Builder got what the Tester found', /Do not fix it/.test(mine[0]?.p ?? '') && mine.some((r) => r.role === 'pen' && /\[From the Tester/.test(r.p) && /price\.js/.test(r.p)))
    check('the Tester added a failing test, and the Builder’s two fixes are in the code', existsSync(join(project, 'price.test.js')) && /return price \+ tax/.test(read('price.js')))
    const said = events.filter((e) => e.type === 'moons.said')
    const bugNote = said.find((e) => e.finding)
    check('the bug is a note with its file, line and code, and it is called fixed in the end', bugNote?.file === 'price.js' && bugNote?.line === 2 && events.some((e) => e.type === 'moons.fixed' && e.ids.includes(bugNote.id)), JSON.stringify(bugNote))
    check('no block text on the page', seen.size === 0, [...seen].join(' '))
    await shot(page, 'bug-done')
    // Revert in the chat of a bug: the Tester’s test goes and the Builder’s edits are undone.
    await revertButtons().click()
    const dialog = page.getByRole('dialog', { name: 'Revert to before this message?' })
    const list = dialog.getByRole('list', { name: 'Files that will change' })
    await list.waitFor({ timeout: 30_000 })
    const listed = await list.innerText()
    check('Revert lists the code the Builder changed and the test the Tester wrote', /price\.js[\s\S]*Changed back/.test(listed) && /price\.test\.js[\s\S]*Removed/.test(listed), listed)
    await dialog.getByRole('button', { name: 'Revert 2 files' }).click()
    await page.getByText('Reverted: 1 file put back, 1 removed.').waitFor({ timeout: 30_000 })
    check('the code is as it was before both of the Builder’s turns, and the Tester’s test is gone', read('price.js') === PRICE && !existsSync(join(project, 'price.test.js')))
    await shot(page, 'bug-reverted')
  }

  if (wanted('F')) {
    console.log('\n# F. Two reviews')
    const reviews = await moonsChat(page, 'reviews', 'TAG-F review greet.js please')
    await page.getByText(/Both are reviewing, without seeing each other/).first().waitFor({ timeout: 60_000 })
    await shot(page, 'reviews-both')
    check('both look at once: the sky says so and the chat is working', (await skyHeight(page)) > 0 && (await stopButton(page).count()) === 1)
    await waitFor('the comparison', hasEvent(page, reviews, (e) => e.type === 'moons.compared'), 90_000)
    check('the sky shows the comparison for some seconds after', (await skyHeight(page)) > 0)
    await shot(page, 'reviews-compared')
    await waitFor('the end', hasEvent(page, reviews, ended()), 30_000)
    await idle(page)
    const events = await logOf(page, reviews)
    const compared = events.find((e) => e.type === 'moons.compared')
    check('one finding is shared and one each', compared?.both.length === 1 && compared.first.length === 1 && compared.second.length === 1 && /no test/.test(compared.first[0].text) && /negative sizes/.test(compared.second[0].text), JSON.stringify(compared))
    // Each program takes a moment to start, so the two requests do not arrive together. A review takes five seconds in the stand-in: when the second
    // request arrives long before the first has finished, they were not taken in turn.
    const one = requestsBy.find((r) => r.role === 'reviewer1' && r.tag === 'F')
    const two = requestsBy.find((r) => r.role === 'reviewer2' && r.tag === 'F')
    check('both Reviewers were asked at the same time, not one after the other (the first is the chat’s own agent, the second a session of its own)', !!one && !!two && Math.abs(one.at - two.at) < 3500, `${one && two ? Math.abs(one.at - two.at) : '?'} ms apart`)
    const allBodies = (role) => stub.requests.filter((r) => who(r) === role && tagIn(all(r)) === 'F').map((r) => JSON.stringify(r.body.messages))
    check('neither saw the other’s work', allBodies('reviewer1').length > 0 && allBodies('reviewer2').length > 0 && !allBodies('reviewer1').some((b) => /negative sizes/.test(b)) && !allBodies('reviewer2').some((b) => /there is no test/.test(b)))
    const card = page.getByRole('group', { name: 'What the two reviews found' })
    const cardText = await card.innerText()
    check('the comparison card has what both found first, then what only each found', /Found by both[\s\S]*Only Reviewer 1[\s\S]*Only Reviewer 2/i.test(cardText), cardText)
    await shot(page, 'reviews-card')
    const loose = await core(page, 'sessions.update', reviews, { approval: 'auto' }).then(
      () => 'accepted',
      (e) => String(e.message ?? e)
    )
    check('the chat’s approval cannot be loosened: it is refused in a sentence', /Two reviews only look, so this chat stays in plan mode/.test(loose), loose)
    const kid = await childOf(page, reviews)
    const looseKid = await core(page, 'sessions.update', kid.id, { approval: 'auto' }).then(
      () => 'accepted',
      (e) => String(e.message ?? e)
    )
    check('and neither can the other Reviewer’s', /cannot be looser than the chat that started it \(plan\)/.test(looseKid), looseKid)
    await waitFor('the sky to fold away', async () => (await skyHeight(page)) === 0, 30_000)
    check('then the sky folds away', (await skyHeight(page)) === 0)
  }

  if (wanted('G')) {
    console.log('\n# G. Stop while the Reviewer looks, and a message typed meanwhile')
    const stopChat = await moonsChat(page, 'build', 'TAG-G write another greeter')
    await waitFor('the Reviewer looking', hasEvent(page, stopChat, turnOf('review', 1)), 90_000)
    await sleep(1500)
    check('the Stop button is there during the Reviewer’s turn', (await stopButton(page).count()) === 1)
    await stopButton(page).click()
    await idle(page)
    await page.getByText('You stopped this run.').waitFor({ timeout: 20_000 })
    check('the chat is idle and the line says the run was stopped', (await logOf(page, stopChat)).some(ended('stopped')))
    const kid = await childOf(page, stopChat)
    await waitFor('the Reviewer to be idle', async () => (await childOf(page, stopChat)).status === 'idle', 20_000)
    check('the Reviewer is idle too, and still there', kid.id === (await childOf(page, stopChat)).id)
    const before = stub.requests.length
    await sleep(3500)
    check('no further request is made in the next seconds', stub.requests.length === before, `${stub.requests.length - before} more`)
    await shot(page, 'stopped')
    await send(page, 'TAG-GN just say hi')
    await page.getByText(/PLAIN ANSWER to: TAG-GN just say hi/).first().waitFor({ timeout: 60_000 })
    await idle(page)
    check('the next message works', true)

    const queued = await moonsChat(page, 'build', 'TAG-Q write the queue greeter')
    await waitFor('the Reviewer looking', hasEvent(page, queued, turnOf('review', 1)), 90_000)
    await send(page, 'TAG-QN second thing please')
    await waitFor('the message to wait', hasEvent(page, queued, (e) => e.type === 'queue.added'), 20_000)
    check('a message typed while the Reviewer looks waits, and the run is not ended by it', !(await logOf(page, queued)).some(ended()))
    await shot(page, 'queued')
    await page.getByText(/PLAIN ANSWER to: TAG-QN second thing please/).first().waitFor({ timeout: 90_000 })
    await idle(page)
    const events = await logOf(page, queued)
    const endAt = events.findIndex(ended())
    const sentAt = events.findIndex((e) => e.type === 'user.message' && /TAG-QN/.test(e.text))
    check('it went after the run, not before', endAt >= 0 && sentAt > endAt, `ended at ${endAt}, sent at ${sentAt}`)
    check('and the run itself was not stopped by it', events.find(ended())?.why === 'agreed')
  }

  if (wanted('H')) {
    console.log('\n# H. @Reviewer goes to the Reviewer alone')
    const ask = await moonsChat(page, 'build', '@Reviewer TAG-H what do you think?')
    await page.getByText(/TAG-H answer: I would keep it as it is/).first().waitFor({ timeout: 90_000 })
    await idle(page)
    const events = await logOf(page, ask)
    const kinds = moonsOf(events).map((e) => `${e.type.replace('moons.', '')}${e.to ? `:${e.to}` : ''}`)
    check('the Reviewer answers the person: a turn, its words for the person, the end', kinds.join(',') === 'turn,said:person,ended', kinds.join(','))
    check('the Builder was not asked, and had nothing to say', !requestsBy.some((r) => r.tag === 'H' && r.role === 'pen') && !events.some((e) => e.type === 'message.delta'))
    check('the Reviewer was told the person is writing to it', requestsBy.some((r) => r.tag === 'H' && r.role === 'direct' && /what do you think\?/.test(r.p)))
    check('its answer is shown, and no block with it', seen.size === 0, [...seen].join(' '))
    const answer = page.getByRole('group', { name: 'Builder and Reviewer talking' })
    check('the answer is in the open, not folded away behind a line', (await answer.getByRole('button').first().getAttribute('aria-expanded')) === 'true' && (await answer.locator('.selectable').filter({ hasText: 'TAG-H answer' }).isVisible()))
    await shot(page, 'mention')
  }

  if (wanted('K')) {
    // Before the crash: a new window has no project chosen yet.
    console.log('\n# K. The graphics process goes away (a driver reset) and the characters come back')
    const gpu = await moonsChat(page, 'build', 'TAG-K write a greeter slowly')
    await waitFor('the Reviewer looking', hasEvent(page, gpu, turnOf('review', 1)), 90_000)
    await sleep(2500)
    const before = await eyes(page)
    check('the characters are drawn in the sky', before > MANY, `${before} white pixels`)
    const problems = consoleProblems.length
    await app.app.evaluate(({ app }) => process.kill(app.getAppMetrics().find((m) => m.type === 'GPU').pid))
    const back = await waitFor('the characters to come back', async () => ((await eyes(page)) > MANY ? 'yes' : undefined), 30_000, 500).catch(() => 'no')
    check('after the graphics process was ended they are drawn again', back === 'yes', `${await eyes(page)} white pixels`)
    // What the browser itself says about the lost process is not the app's.
    consoleProblems.length = problems
    await shot(page, 'after-gpu')
    await stopButton(page).click()
    await idle(page)
  }

  if (wanted('I')) {
    console.log('\n# I. A crash while the Reviewer checks')
    const crash = await moonsChat(page, 'build', 'TAG-I write a greeter that will not be finished')
    await waitFor('the check', hasEvent(page, crash, turnOf('check', 1)), 120_000)
    await sleep(900)
    await shot(page, 'before-crash')
    leaks.stop()
    await app.crash()
    const requestsBefore = stub.requests.length
    app = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env, copilotKnowsNoOne: true })
    page = app.page
    watchConsole(page)
    await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
    await claudeReady(page)
    leaks = watchLeaks(page)
    await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Develop' }).click()
    const rowOf = page.locator('[data-session-row]:not([data-helper-row])').filter({ hasText: 'Moons I' })
    await rowOf.first().click()
    await page.getByRole('group', { name: 'Builder and Reviewer talking' }).first().waitFor({ timeout: 20_000 })
    const events = await logOf(page, crash)
    const tail = events.slice(-3).map((e) => e.type)
    console.log('the log ends with:', tail.join(', '))
    check('the chat is idle after the restart, with no Stop button', (await stopButton(page).count()) === 0 && (await core(page, 'app.bootstrap')).sessions.find((s) => s.id === crash)?.status === 'idle')
    const body = await text(page)
    console.log('after the restart the page says:', body.slice(-700).replace(/\n+/g, ' | '))
    check('it says the turn was not finished', /not finished|was closed|did not finish|interrupted/i.test(body), body.slice(-500))
    check('the conversation so far is drawn again from the log: the notes, with their code', /greet crashes when the name is missing/.test(body) || (await page.getByRole('group', { name: 'Builder and Reviewer talking' }).count()) >= 1)
    const talk = page.getByRole('group', { name: 'Builder and Reviewer talking' })
    for (let i = 0; i < (await talk.count()); i++) if ((await talk.nth(i).getByRole('button').first().getAttribute('aria-expanded')) === 'false') await talk.nth(i).getByRole('button').first().click()
    const bubbles = (await talk.locator('.selectable').allInnerTexts()).join('\n')
    check('with the notes’ file, line and code, and the Builder’s answers', /greet-crash\.js:2/.test(bubbles) && /return w \* h/.test(bubbles) && /rounding would hide mistakes/.test(bubbles), bubbles)
    check('the other moon is idle too', (await childOf(page, crash)).status === 'idle')
    await sleep(3500)
    check('nothing was restarted or woken by itself', stub.requests.length === requestsBefore, `${stub.requests.length - requestsBefore} more`)
    check('and the sky is not up', (await skyHeight(page)) === 0)
    await shot(page, 'after-crash')
  }

  console.log('\n# J. The console')
  check('the page’s console had no errors, no policy violations and no complaints from the sky during any of it', consoleProblems.length === 0, consoleProblems.join(' || '))
  check('no moons block or passed-on words were on the page at any moment of the run', seen.size === 0, [...seen].join(' '))
} catch (err) {
  console.error(err)
  failures.push(`crashed: ${err instanceof Error ? err.message : String(err)}`)
  try {
    await app?.page.screenshot({ path: join(out, 'moons-failure.png') })
    console.log((await text(app.page)).slice(-1500))
  } catch {
    /* the window may be gone */
  }
} finally {
  leaks?.stop()
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (const dir of [profile, join(project, '..')]) {
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        if (i === 19) console.warn(`Could not remove ${dir}`)
        await sleep(500)
      }
    }
  }
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed.')
process.exit(failures.length ? 1 : 0)
