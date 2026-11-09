// Desktop control, in the real built app, with the real mouse and keyboard, against a window of our own (scripts/lib/desktop-target.cjs):
// off until switched on, a consent card of Celeste's own, a click and typing that really arrive, Celeste's own windows refused,
// Stop and the stop key end it, the bar is gone afterwards, a "no" is remembered.   npm run verify:desktop   (Windows only; no account, no cost)
//
// Setting CELESTE_ENTRY to the app.asar of a packed build (npm run dist:dir makes one) runs it against that instead.
// It MOVES THE REAL MOUSE and types for about a minute. Leave the mouse and keyboard alone while it runs.
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'
import { _electron as electron } from 'playwright-core'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, echo, pasteClaudeKey, startStub } from './lib/stub.mjs'

if (process.platform !== 'win32') {
  console.log('Desktop control works on Windows only for now: nothing to check on this system.')
  process.exit(0)
}

const out = join(import.meta.dirname, '.output')
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'celeste-desktop-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- the stop key, sent the way a person's fingers would ---
const user32 = koffi.load('user32.dll')
const KEYBD = koffi.struct('CHKKEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
const MOUSE = koffi.struct('CHKMOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
const INPUT = koffi.struct('CHKINPUT', { type: 'uint32', u: koffi.union({ mi: MOUSE, ki: KEYBD }) })
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, CHKINPUT *inputs, int size)')
function pressStopKey() {
  const k = (vk, up) => ({ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: 0 } } })
  SendInput(6, [k(0x11), k(0x12), k(0x1b), k(0x1b, 1), k(0x12, 1), k(0x11, 1)], koffi.sizeof(INPUT))
}

// --- what the stand-in assistant does, round by round ---
const tool = (name, input) => ({ type: 'tool_use', name: `mcp__celeste-devices__${name}`, input })
const plan = { shotW: 0, shotH: 0, phys: { w: 0, h: 0 }, button: { x: 0, y: 0 }, field: { x: 0, y: 0 }, celeste: { x: 0, y: 0 } }
const inPicture = (p) => ({ x: Math.round((p.x * plan.shotW) / plan.phys.w), y: Math.round((p.y * plan.shotH) / plan.phys.h) })
const results = []
let round = ''
let step = 0
const rounds = {
  off: () => [{ type: 'text', text: 'Round off is over.' }],
  deny: () => [{ type: 'text', text: 'Round deny is over.' }],
  deny2: () => [{ type: 'text', text: 'Round deny2 is over.' }],
  work: (s, text) => {
    if (s === 1) return [tool('desktop_screenshot', {})]
    if (s === 2) {
      const m = /(\d+) by (\d+) pixels/.exec(text)
      plan.shotW = Number(m?.[1] ?? 0)
      plan.shotH = Number(m?.[2] ?? 0)
      return [tool('desktop_click', inPicture(plan.button))]
    }
    if (s === 3) return [tool('desktop_click', inPicture(plan.field))]
    if (s === 4) return [tool('desktop_type', { text: 'Hello from the assistant' })]
    if (s === 5) return [tool('desktop_click', inPicture(plan.celeste))]
    if (s === 6) return [tool('desktop_key', { keys: 'ctrl+alt+esc' })]
    if (s === 7) return [tool('desktop_release_control', {})]
    return [{ type: 'text', text: 'Round work is over.' }]
  },
  stopbutton: (s) => (s === 1 ? [tool('desktop_wait', { seconds: 10 })] : [{ type: 'text', text: 'Round stopbutton is over.' }]),
  hotkey: (s) => (s === 1 ? [tool('desktop_wait', { seconds: 10 })] : [{ type: 'text', text: 'Round hotkey is over.' }])
}
const script = (r) => {
  if (r.last.kind === 'text') {
    const m = /ROUND:(\w+)/.exec(r.last.text)
    if (!m) return echo(r)
    round = m[1]
    step = 0
    return [tool('desktop_request_control', { reason: `Round ${round}: press the button in the test window` })]
  }
  step++
  results.push({ round, step, text: r.last.text, isError: r.last.isError })
  return (rounds[round] ?? (() => [{ type: 'text', text: 'Unknown round.' }]))(step, r.last.text)
}
const resultOf = (rnd, s) => results.find((r) => r.round === rnd && r.step === s)

let stub
let app
let target
try {
  stub = await startStub(script)
  app = await launch({ width: 900, height: 700, theme: null, profile, env: stub.env, entry: process.env.CELESTE_ENTRY || undefined })
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

  // Celeste at the top left, the target to the right of it and below the bar, so nothing overlaps.
  const screenInfo = await app.app.evaluate(({ BrowserWindow, screen }) => {
    BrowserWindow.getAllWindows()[0].setPosition(0, 0)
    const phys = screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds)
    return { w: phys.width, h: phys.height }
  })
  plan.phys = screenInfo
  if (screenInfo.w < 1800 || screenInfo.h < 800) throw new Error(`The screen is ${screenInfo.w} by ${screenInfo.h}; this check needs at least 1800 by 800 so the windows do not overlap.`)
  target = await electron.launch({ args: [join(import.meta.dirname, 'lib', 'desktop-target.cjs')], env: { ...process.env, TARGET_X: '1000', TARGET_Y: '300' } })
  const tp = await target.firstWindow()
  await tp.waitForLoadState('domcontentloaded')
  const rects = await tp.evaluate(() => {
    const c = (id) => {
      const r = document.getElementById(id).getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return { btn: c('btn'), field: c('box') }
  })
  const phys = (appHandle, p) =>
    appHandle.evaluate(({ BrowserWindow, screen }, pt) => {
      const cb = BrowserWindow.getAllWindows()[0].getContentBounds()
      return screen.dipToScreenPoint({ x: Math.round(cb.x + pt.x), y: Math.round(cb.y + pt.y) })
    }, p)
  plan.button = await phys(target, rects.btn)
  plan.field = await phys(target, rects.field)
  const settingsBtn = await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox()
  plan.celeste = await phys(app.app, { x: settingsBtn.x + settingsBtn.width / 2, y: settingsBtn.y + settingsBtn.height / 2 })

  const send = async (text) => {
    const box = page.getByRole('textbox', { name: 'Message' })
    await box.fill(text)
    await box.press('Enter')
  }
  const newChat = async () => {
    await page.getByRole('button', { name: 'New chat' }).click()
    await page.getByRole('textbox', { name: 'Message' }).waitFor()
  }
  const answerCard = async (button) => {
    const card = page.getByRole('group', { name: 'Approval needed' }).last()
    await card.waitFor({ timeout: 30_000 })
    await card.getByRole('button', { name: button, exact: true }).click()
  }
  const barWindow = async () => {
    for (let i = 0; i < 40; i++) {
      for (const w of app.app.windows()) {
        if (w === page) continue
        if ((await w.title().catch(() => '')) === 'Celeste desktop control' || (await w.locator('#stop').count().catch(() => 0)) > 0) return w
      }
      await sleep(250)
    }
    return undefined
  }
  const windowCount = () => app.app.windows().length

  console.log('\n# Off until switched on')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Desktop control' }).click()
  const sw = page.getByRole('switch', { name: 'Let the assistant ask to control this computer' })
  check('Settings has a Desktop control switch, and it is off', (await sw.getAttribute('aria-checked')) === 'false')
  await page.keyboard.press('Escape')
  await newChat()
  await send('ROUND:off use the screen')
  await page.getByText('Round off is over.').waitFor({ timeout: 60_000 })
  check('with it off, the assistant’s request is refused and says why', /switched off/.test(resultOf('off', 1)?.text ?? '') && resultOf('off', 1)?.isError === true, resultOf('off', 1)?.text)
  check('and no card is raised', (await page.getByRole('group', { name: 'Approval needed' }).count()) === 0)

  console.log('\n# A "no" is remembered')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Desktop control' }).click()
  await sw.click()
  check('the switch can be turned on', (await sw.getAttribute('aria-checked')) === 'true')
  await page.keyboard.press('Escape')
  await newChat()
  await send('ROUND:deny use the screen')
  const card = page.getByRole('group', { name: 'Approval needed' }).last()
  await card.waitFor({ timeout: 30_000 })
  const cardText = await card.innerText()
  check('with it on, the assistant’s request raises a card of Celeste’s own, with the reason and the warning', /control this computer for 15 minutes/.test(cardText) && /Round deny: press the button/.test(cardText) && /see everything on your screen/.test(cardText), cardText.slice(0, 200))
  await page.screenshot({ path: join(out, 'desktop-consent.png') })
  await answerCard('Deny')
  await page.getByText('Round deny is over.').waitFor({ timeout: 60_000 })
  check('Deny tells the assistant no', /said no/.test(resultOf('deny', 1)?.text ?? ''), resultOf('deny', 1)?.text)
  await send('ROUND:deny2 please use the screen')
  await page.getByText('Round deny2 is over.').waitFor({ timeout: 60_000 })
  check('asking again in that chat is refused with no new card', /Do not ask again/.test(resultOf('deny2', 1)?.text ?? '') && (await page.getByRole('group', { name: 'Approval needed' }).count()) === 0, resultOf('deny2', 1)?.text)
  check('nothing was shown on the screen, and no key was taken', windowCount() === 1)

  console.log('\n# Allowed: a real click and real typing, in a window of our own')
  await newChat()
  await send('ROUND:work use the screen')
  await answerCard('Allow')
  const bar = await barWindow()
  check('a control bar is on screen while it lasts', !!bar && /controlling this computer/.test(await bar.locator('body').innerText()), bar ? '' : 'no bar window')
  // A picture of the bar with a few lines on it, for looking at (the lines are put in by hand: the real ones go too fast to catch).
  await bar
    ?.evaluate(() => window.setState({ until: Date.now() + 14 * 60_000, lines: ['Click at (874, 390)', 'Type “Hello from the assistant”', 'Refused: Click at (100, 519)'] }))
    .catch(() => undefined)
  await bar?.screenshot({ path: join(out, 'desktop-bar.png') }).catch(() => undefined)
  await page.getByText('Round work is over.').waitFor({ timeout: 90_000 })
  const clicks = await tp.evaluate(() => window.clicks)
  const typed = await tp.evaluate(() => document.getElementById('box').value)
  check('the assistant’s click pressed the button in the other window', clicks === 1, `clicks=${clicks}; ${JSON.stringify(results.filter((r) => r.round === 'work').map((r) => r.text.slice(0, 60)))}`)
  check('and its typing arrived in the field', typed === 'Hello from the assistant', typed)
  check('a click on Celeste’s own window was refused', resultOf('work', 6)?.isError === true && /inside a Celeste window/.test(resultOf('work', 6)?.text ?? ''), resultOf('work', 6)?.text)
  check('and Celeste did not react to it (Settings did not open)', (await page.getByRole('dialog', { name: 'Settings' }).count()) === 0)
  check('the stop key cannot be pressed by the assistant', resultOf('work', 7)?.isError === true && /stops desktop control/.test(resultOf('work', 7)?.text ?? ''), resultOf('work', 7)?.text)
  check('it gave the control back, and the bar is gone', /Control ended/.test(resultOf('work', 8)?.text ?? ''))
  await sleep(800)
  check('no window of the bar or the border is left', windowCount() === 1, `${windowCount()} windows`)
  const dc = page.getByRole('group', { name: 'Desktop control' })
  const dcText = await dc.innerText()
  check('the conversation shows each action, the refusal, and how it ended', /Click at/.test(dcText) && /Type “Hello from the assistant”/.test(dcText) && /Refused: Click at/.test(dcText) && /Ended: The assistant said it was done\./.test(dcText), dcText)
  await dc.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, 'desktop-card.png') })
  // What the assistant saw: Celeste's own windows must not be in it.
  const body = JSON.stringify(stub.requests.map((r) => r.body))
  const shot = /"data":"(\/9j\/[A-Za-z0-9+/=]+)"/.exec(body)
  if (shot) writeFileSync(join(out, 'desktop-screenshot.jpg'), Buffer.from(shot[1], 'base64'))
  check('the assistant was given a picture of the screen', !!shot)

  console.log('\n# Stop, from the bar and from the keyboard')
  await newChat()
  await send('ROUND:stopbutton use the screen')
  await answerCard('Allow')
  const bar2 = await barWindow()
  check('the bar is back for the next grant', !!bar2)
  await sleep(1500)
  await bar2?.getByRole('button', { name: /Stop/ }).click()
  await page.getByText('Round stopbutton is over.').waitFor({ timeout: 40_000 })
  check('the bar’s Stop ends it at once, even in the middle of a wait', resultOf('stopbutton', 2)?.isError === true && /ended/i.test(resultOf('stopbutton', 2)?.text ?? ''), resultOf('stopbutton', 2)?.text)
  await sleep(800)
  check('and the bar goes away', windowCount() === 1)
  check('and the conversation says who stopped it', /Ended: You pressed Stop\./.test(await page.getByRole('group', { name: 'Desktop control' }).last().innerText()))

  await newChat()
  await send('ROUND:hotkey use the screen')
  await answerCard('Allow')
  await barWindow()
  await sleep(1500)
  pressStopKey()
  await page.getByText('Round hotkey is over.').waitFor({ timeout: 40_000 })
  check('Ctrl+Alt+Esc ends it from anywhere', resultOf('hotkey', 2)?.isError === true, resultOf('hotkey', 2)?.text)
  await sleep(800)
  check('and takes the bar away', windowCount() === 1)
  check('and the conversation says it was the stop key', /Ended: You pressed the stop key\./.test(await page.getByRole('group', { name: 'Desktop control' }).last().innerText()))
  await saveSettings(page, { desktopControl: false })
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(out, 'desktop-failure.png') }).catch(() => undefined)
} finally {
  await target?.close().catch(() => undefined)
  await app?.close().catch(() => undefined)
  await stub?.stop().catch(() => undefined)
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(profile, { recursive: true, force: true })
      break
    } catch {
      if (i === 19) console.warn(`Could not remove ${profile}`)
      await sleep(500)
    }
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
