// Desktop control, in the real built app, with the real mouse and keyboard, against a window of our own (scripts/lib/desktop-target.cjs):
// off until switched on, a consent card of Celeste's own, a click and typing that really arrive, Celeste's own windows refused,
// Stop and the stop key end it, the bar is gone afterwards, a "no" is remembered; and, in step 2, one window only (a window in front is
// refused and painted over), no typing into a password field, a second yes before a button called Delete, a pause when the person moves
// the mouse, and a program on the never list.   npm run verify:desktop   (Windows only; no account, no cost)
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
const dwm = koffi.load('dwmapi.dll')
const CHKRECT = koffi.struct('CHKRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const DwmGetWindowAttribute = dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr h, uint32 attr, _Out_ CHKRECT *out, uint32 size)')
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')
/** The visible frame of an Electron app's first window, on the screen, the way Windows reports it. */
const frameOf = async (electronApp) => {
  const hwnd = Number(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE(0).toString()))
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  DwmGetWindowAttribute(hwnd, 9, r, 16)
  return { id: hwnd, x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}
function pressStopKey() {
  const k = (vk, up) => ({ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: 0 } } })
  SendInput(6, [k(0x11), k(0x12), k(0x1b), k(0x1b, 1), k(0x12, 1), k(0x11, 1)], koffi.sizeof(INPUT))
}

// --- what the stand-in assistant does, round by round ---
const tool = (name, input) => ({ type: 'tool_use', name: `mcp__celeste-devices__${name}`, input })
const plan = {
  shotW: 0,
  shotH: 0,
  phys: { w: 0, h: 0 },
  button: { x: 0, y: 0 },
  field: { x: 0, y: 0 },
  celeste: { x: 0, y: 0 },
  secret: { x: 0, y: 0 },
  del: { x: 0, y: 0 },
  covered: { x: 0, y: 0 },
  frame: { id: 0, x: 0, y: 0, w: 0, h: 0 },
  coverId: 0
}
/** A point on the screen as a point in a picture of one window only (the picture is that window's frame, scaled). */
const inFrame = (p) => ({ x: Math.round(((p.x - plan.frame.x) * plan.shotW) / plan.frame.w), y: Math.round(((p.y - plan.frame.y) * plan.shotH) / plan.frame.h) })
const requestArgs = { scoped: { window: 'Desktop control target' }, hour: { window: 'Desktop control target' }, wfcomputer: { window: 'Desktop control target' }, never: {} }
const dims = (text) => {
  const m = /(\d+) by (\d+) pixels/.exec(text)
  plan.shotW = Number(m?.[1] ?? 0)
  plan.shotH = Number(m?.[2] ?? 0)
}
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
  scoped: (s, text) => {
    if (s === 1) return [tool('desktop_screenshot', {})]
    if (s === 2) {
      dims(text)
      return [tool('desktop_click', inFrame(plan.button))]
    }
    if (s === 3) return [tool('desktop_click', inFrame(plan.covered))]
    if (s === 4) return [tool('desktop_list_windows', {})]
    if (s === 5) return [tool('desktop_focus_window', { id: plan.coverId })]
    if (s === 6) return [tool('desktop_release_control', {})]
    return [{ type: 'text', text: 'Round scoped is over.' }]
  },
  secret: (s, text) => {
    if (s === 1) return [tool('desktop_screenshot', {})]
    if (s === 2) {
      dims(text)
      return [tool('desktop_click', inPicture(plan.secret))]
    }
    if (s === 3) return [tool('desktop_type', { text: 'hunter2' })]
    if (s === 4) return [tool('desktop_release_control', {})]
    return [{ type: 'text', text: 'Round secret is over.' }]
  },
  confirm: (s, text) => {
    if (s === 1) return [tool('desktop_screenshot', {})]
    if (s === 2) {
      dims(text)
      return [tool('desktop_click', inPicture(plan.del))]
    }
    if (s === 3) return [tool('desktop_click', inPicture(plan.del))]
    if (s === 4) return [tool('desktop_release_control', {})]
    return [{ type: 'text', text: 'Round confirm is over.' }]
  },
  moved: (s, text) => {
    if (s === 1) return [tool('desktop_screenshot', {})]
    if (s === 2) {
      dims(text)
      return [tool('desktop_click', inPicture(plan.button))]
    }
    if (s === 3) return [tool('desktop_wait', { seconds: 4 })]
    if (s === 4) return [tool('desktop_click', inPicture(plan.button))]
    if (s === 5) return [tool('desktop_release_control', {})]
    return [{ type: 'text', text: 'Round moved is over.' }]
  },
  never: (s, text) => {
    if (s === 1) return [tool('desktop_screenshot', {})]
    if (s === 2) {
      dims(text)
      return [tool('desktop_click', inPicture(plan.button))]
    }
    if (s === 3) return [tool('desktop_release_control', {})]
    return [{ type: 'text', text: 'Round never is over.' }]
  },
  hour: (s) => (s === 1 ? [tool('desktop_release_control', {})] : [{ type: 'text', text: 'Round hour is over.' }]),
  wfone: () => [{ type: 'text', text: 'Facebook is open.' }],
  wfcomputer: (s, text) => {
    if (s === 1) return [tool('desktop_screenshot', {})]
    if (s === 2) {
      dims(text)
      return [tool('desktop_click', inFrame(plan.button))]
    }
    if (s === 3) return [tool('desktop_release_control', {})]
    return [{ type: 'text', text: 'Pressed it.' }]
  },
  stopbutton: (s) => (s === 1 ? [tool('desktop_wait', { seconds: 10 })] : [{ type: 'text', text: 'Round stopbutton is over.' }]),
  hotkey: (s) => (s === 1 ? [tool('desktop_wait', { seconds: 10 })] : [{ type: 'text', text: 'Round hotkey is over.' }])
}
const script = (r) => {
  if (r.last.kind === 'text') {
    const m = [...r.last.text.matchAll(/ROUND:(\w+)/g)].at(-1)
    if (!m) return echo(r)
    round = m[1]
    step = 0
    // A step of a workflow that only talks answers at once.
    if (round === 'wfone') return rounds.wfone()
    return [tool('desktop_request_control', { reason: `Round ${round}: press the button in the test window`, ...(requestArgs[round] ?? {}) })]
  }
  step++
  results.push({ round, step, text: r.last.text, isError: r.last.isError })
  return (rounds[round] ?? (() => [{ type: 'text', text: 'Unknown round.' }]))(step, r.last.text)
}
const resultOf = (rnd, s) => results.find((r) => r.round === rnd && r.step === s)

let stub
let app
let target
let cover
try {
  stub = await startStub(script)
  // Copilot is given a data folder that knows no one: nothing in this check may reach a real account, and a step that names no model would otherwise pick it.
  app = await launch({ width: 900, height: 700, theme: null, profile, env: stub.env, entry: process.env.CELESTE_ENTRY || undefined, copilotKnowsNoOne: true })
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
    return { btn: c('btn'), field: c('box'), secret: c('pw'), del: c('del') }
  })
  const phys = (appHandle, p) =>
    appHandle.evaluate(({ BrowserWindow, screen }, pt) => {
      const cb = BrowserWindow.getAllWindows()[0].getContentBounds()
      return screen.dipToScreenPoint({ x: Math.round(cb.x + pt.x), y: Math.round(cb.y + pt.y) })
    }, p)
  plan.button = await phys(target, rects.btn)
  plan.field = await phys(target, rects.field)
  plan.secret = await phys(target, rects.secret)
  plan.del = await phys(target, rects.del)
  // A second window over the lower right of the target, in front of it.
  cover = await electron.launch({ args: [join(import.meta.dirname, 'lib', 'desktop-target.cjs')], env: { ...process.env, TARGET_X: '1420', TARGET_Y: '520', TARGET_W: '360', TARGET_H: '260', TARGET_TITLE: 'Cover window' } })
  const cp = await cover.firstWindow()
  await cp.waitForLoadState('domcontentloaded')
  await sleep(500)
  plan.frame = await frameOf(target)
  plan.coverId = (await frameOf(cover)).id
  plan.covered = { x: 1500, y: 600 }
  const settingsBtn = await page.getByRole('button', { name: 'Settings', exact: true }).boundingBox()
  plan.celeste = await phys(app.app, { x: settingsBtn.x + settingsBtn.width / 2, y: settingsBtn.y + settingsBtn.height / 2 })

  const send = async (text) => {
    const box = page.getByRole('textbox', { name: 'Message' })
    // The last turn may still be finishing, and Enter does nothing until it is.
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 20_000 }).catch(async () => {
      console.log('NOTE  a Stop button stayed on the page: ' + (await page.getByRole('button', { name: 'Stop', exact: true }).evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 160)))).join(' | '))
    })
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
    const text = await card.innerText()
    await card.getByRole('button', { name: button, exact: true }).click()
    return text
  }
  // The pictures the assistant was given, oldest first (each request repeats the earlier ones).
  const pictures = () => [...new Set([...JSON.stringify(stub.requests.map((r) => r.body)).matchAll(/"data":"(\/9j\/[A-Za-z0-9+/=]+)"/g)].map((m) => m[1]))]
  // How bright a spot of a picture is, 0 black to 255 white.
  const brightness = (b64, p) =>
    app.app.evaluate(
      ({ nativeImage }, { b64, p }) => {
        const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
        const { width, height } = img.getSize()
        const bm = img.toBitmap()
        let sum = 0
        let n = 0
        for (let y = Math.max(0, p.y - 3); y <= Math.min(height - 1, p.y + 3); y++) {
          for (let x = Math.max(0, p.x - 3); x <= Math.min(width - 1, p.x + 3); x++) {
            const i = (y * width + x) * 4
            sum += (bm[i] + bm[i + 1] + bm[i + 2]) / 3
            n++
          }
        }
        return sum / n
      },
      { b64, p }
    )
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
  check('with it on, the assistant’s request raises a card of Celeste’s own, with the reason and the warning', /Let the assistant control this computer/.test(cardText) && /For 20 minutes/.test(cardText) && /Round deny: press the button/.test(cardText) && /see everything on your main screen/.test(cardText), cardText.slice(0, 200))
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

  console.log('\n# One window only (step 2)')
  const clicksBefore = await tp.evaluate(() => window.clicks)
  await newChat()
  await send('ROUND:scoped use the screen')
  const scopedCard = await answerCard('Allow')
  check('the card names the window and says it is the only thing', /Let the assistant use “Desktop control target”/.test(scopedCard) && /and nothing else/.test(scopedCard) && !/see everything/.test(scopedCard), scopedCard.slice(0, 300))
  const scopedBar = await barWindow()
  check('the bar says what it may use', /Can use: only the window “Desktop control target”/.test((await scopedBar?.locator('body').innerText()) ?? ''))
  await page.getByText('Round scoped is over.').waitFor({ timeout: 90_000 })
  check('the request told the assistant it is limited to that window', /only the window “Desktop control target”/.test(resultOf('scoped', 1)?.text ?? ''), resultOf('scoped', 1)?.text)
  check('the picture is the window only: its size', Math.abs(plan.shotW - plan.frame.w) <= 3 && Math.abs(plan.shotH - plan.frame.h) <= 3, plan.shotW + ' by ' + plan.shotH + ' for a window of ' + plan.frame.w + ' by ' + plan.frame.h)
  check('a click in it pressed the button', (await tp.evaluate(() => window.clicks)) === clicksBefore + 1)
  check('a click where another window is in front was refused, naming it', resultOf('scoped', 4)?.isError === true && /outside what you were given/.test(resultOf('scoped', 4)?.text ?? '') && /Cover window/.test(resultOf('scoped', 4)?.text ?? ''), resultOf('scoped', 4)?.text)
  check('and never reached the window in front', (await cp.evaluate(() => window.clicks)) === 0)
  const listed = resultOf('scoped', 5)?.text ?? ''
  check('the list of windows has only that window (not the cover, not Celeste)', /Desktop control target/.test(listed) && !/Cover window|Celeste/.test(listed), listed)
  check('bringing the other window to the front was refused', resultOf('scoped', 6)?.isError === true && /outside what you were given/.test(resultOf('scoped', 6)?.text ?? ''), resultOf('scoped', 6)?.text)
  const scopedShot = pictures().at(-1)
  if (scopedShot) writeFileSync(join(out, 'desktop-scoped.jpg'), Buffer.from(scopedShot, 'base64'))
  const coveredAt = inFrame(plan.covered)
  const buttonAt = inFrame(plan.button)
  check('in the picture the window in front is painted black', !!scopedShot && (await brightness(scopedShot, coveredAt)) < 40, scopedShot ? String(await brightness(scopedShot, coveredAt)) : 'no picture')
  check('and the window itself is shown', !!scopedShot && (await brightness(scopedShot, { x: buttonAt.x, y: Math.max(0, buttonAt.y - 40) })) > 120)
  await sleep(800)
  check('and nothing is left on the screen afterwards', windowCount() === 1)

  console.log('\n# A password field, and a button called Delete')
  await newChat()
  await send('ROUND:secret use the screen')
  await answerCard('Allow')
  await page.getByText('Round secret is over.').waitFor({ timeout: 90_000 })
  check('typing into a password field was refused, and says why', resultOf('secret', 4)?.isError === true && /password field/.test(resultOf('secret', 4)?.text ?? ''), resultOf('secret', 4)?.text)
  check('and nothing was typed', (await tp.evaluate(() => document.getElementById('pw').value)) === '')
  const secretCard = await page.getByRole('group', { name: 'Desktop control' }).last().innerText()
  check('and the conversation does not show what it tried to type', /Refused: Type into a password field/.test(secretCard) && !/hunter2/.test(secretCard), secretCard)

  await newChat()
  await send('ROUND:confirm use the screen')
  await answerCard('Allow')
  // The card for the button, not the one for the grant that is still being answered.
  const buttonCard = page.getByRole('group', { name: 'Approval needed' }).filter({ hasText: 'Delete everything' })
  await buttonCard.waitFor({ timeout: 30_000 })
  const askedDeny = await buttonCard.innerText()
  await buttonCard.getByRole('button', { name: 'Deny', exact: true }).click()
  check('before pressing Delete everything, the person is asked, with a warning', /Let the assistant press “Delete everything”/.test(askedDeny) && /cannot be taken back/.test(askedDeny), askedDeny.slice(0, 300))
  await answerCard('Allow')
  await page.getByText('Round confirm is over.').waitFor({ timeout: 90_000 })
  check('on Deny it was not pressed, and the assistant was told not to try again', resultOf('confirm', 3)?.isError === true && /did not allow pressing/.test(resultOf('confirm', 3)?.text ?? ''), resultOf('confirm', 3)?.text)
  check('on Allow it was pressed, once', resultOf('confirm', 4)?.isError === false && (await tp.evaluate(() => window.deletes)) === 1, String(await tp.evaluate(() => window.deletes)))

  console.log('\n# The person moves the mouse')
  const before = await tp.evaluate(() => window.clicks)
  await newChat()
  await send('ROUND:moved use the screen')
  await answerCard('Allow')
  for (let i = 0; i < 200 && !resultOf('moved', 3); i++) await sleep(100)
  // The assistant is waiting for four seconds. Now the person takes the mouse.
  SetCursorPos(200, 750)
  const pausedBar = await barWindow()
  const goButton = pausedBar?.getByRole('button', { name: 'Continue' })
  await goButton?.waitFor({ timeout: 20_000 })
  check('the bar says the mouse was moved and offers Continue', /You moved the mouse/.test((await pausedBar?.locator('body').innerText()) ?? ''))
  await pausedBar?.screenshot({ path: join(out, 'desktop-bar-paused.png') }).catch(() => undefined)
  await sleep(600)
  check('the next click did not happen while it is paused', (await tp.evaluate(() => window.clicks)) === before + 1)
  await goButton?.click()
  await page.getByText('Round moved is over.').waitFor({ timeout: 60_000 })
  check('after Continue the same click was made', (await tp.evaluate(() => window.clicks)) === before + 2 && resultOf('moved', 5)?.isError === false, resultOf('moved', 5)?.text)
  const movedCard = await page.getByRole('group', { name: 'Desktop control' }).last().innerText()
  check('the conversation says it was paused and that the person continued', /You moved the mouse: paused/.test(movedCard) && /You pressed Continue/.test(movedCard), movedCard)

  console.log('\n# A program the person never wants touched')
  await saveSettings(page, { desktopNeverApps: ['Desktop control target'] })
  const clicksNever = await tp.evaluate(() => window.clicks)
  await newChat()
  await send('ROUND:never use the screen')
  const neverCard = await answerCard('Allow')
  check('the card says what stays hidden', /Hidden and never touched, whatever it asks: Desktop control target\./.test(neverCard), neverCard.slice(0, 400))
  await page.getByText('Round never is over.').waitFor({ timeout: 90_000 })
  check('a click on it was refused, even with the whole screen given', resultOf('never', 3)?.isError === true && /never controlled/.test(resultOf('never', 3)?.text ?? ''), resultOf('never', 3)?.text)
  check('and did not arrive', (await tp.evaluate(() => window.clicks)) === clicksNever)
  const neverShot = pictures().at(-1)
  const buttonInPicture = inPicture(plan.button)
  check('and it is painted black in what the assistant saw', !!neverShot && (await brightness(neverShot, buttonInPicture)) < 40, neverShot ? String(await brightness(neverShot, buttonInPicture)) : 'no picture')
  await saveSettings(page, { desktopNeverApps: [] })

  console.log('\n# A workflow with a step that uses the computer, after a step it has to remember')
  const wfFolder = mkdtempSync(join(tmpdir(), 'celeste-desktop-wf-'))
  const wfClicks = await tp.evaluate(() => window.clicks)
  const wfFrom = stub.requests.length
  const wf = await page.evaluate(() =>
    window.celeste.core.call('workflows.save', [
      {
        name: 'Open and press',
        definition: {
          nodes: [
            { id: 'start', type: 'start', name: 'Start', inputs: [] },
            { id: 'open', type: 'agent', name: 'Open the page', prompt: 'ROUND:wfone open the page', approval: 'auto', vendor: 'claude', model: 'claude:default' },
            { id: 'press', type: 'agent', name: 'Press the button', prompt: 'ROUND:wfcomputer press the button there', approval: 'auto', vendor: 'claude', model: 'claude:default', computer: { window: 'Desktop control target' } },
            { id: 'end', type: 'end', name: 'End' }
          ],
          edges: [{ from: 'start', to: 'open' }, { from: 'open', to: 'press' }, { from: 'press', to: 'end' }]
        }
      }
    ])
  )
  const wfRun = await page.evaluate(([id, folder]) => window.celeste.core.call('workflows.run', [id, {}, { folder }]), [wf.id, wfFolder])
  const answered = new Set()
  const askedInRun = []
  let wfStatus = ''
  for (let i = 0; i < 600 && !['completed', 'failed', 'cancelled'].includes(wfStatus); i++) {
    await sleep(300)
    const got = await page.evaluate((id) => window.celeste.core.call('runs.get', [id]), wfRun.id)
    wfStatus = got?.summary.status ?? ''
    for (const item of got?.events ?? []) {
      const e = item.event
      if ((e.type === 'approval.requested' || e.type === 'agent.approval') && !answered.has(e.requestId)) {
        answered.add(e.requestId)
        askedInRun.push(e.type === 'agent.approval' ? e.title : 'the run')
        const expected = e.type === 'approval.requested' || /^Let the assistant use “Desktop control target”/.test(e.title)
        if (!expected) console.log('NOTE  refused something the assistant asked in the run: ' + e.title)
        await page.evaluate(([run, req, allow]) => window.celeste.core.call('runs.respondApproval', [run, req, allow]), [wfRun.id, e.requestId, expected])
      }
    }
  }
  if (wfStatus !== 'completed') {
    const got = await page.evaluate((id) => window.celeste.core.call('runs.get', [id]), wfRun.id)
    const lastUser = (b) => { const m = [...(b?.messages ?? [])].reverse().find((x) => x.role === 'user'); const c = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }]; return c.map((x) => (x.type === 'tool_result' ? 'RESULT ' : '') + JSON.stringify(x.text ?? x.content ?? '').slice(0, 90)).join(' + ') }
    console.log('NOTE  what the stand-in was asked: ' + JSON.stringify(stub.requests.slice(wfFrom).map((r) => lastUser(r.body))))
    console.log('NOTE  rounds seen by the stand-in: ' + JSON.stringify(results.filter((r) => r.round.startsWith('wf')).map((r) => r.round + ':' + r.step + ':' + r.text.slice(0, 80))))
    console.log('NOTE  the run is ' + wfStatus + '; its events: ' + JSON.stringify((got?.events ?? []).map((x) => x.event.type + (x.event.nodeId ? ':' + x.event.nodeId : '') + (x.event.error ? ' ' + x.event.error : '') + (x.event.questions ? ' ' + JSON.stringify(x.event.questions).slice(0, 300) : ''))))
  }
  check('the run finished', wfStatus === 'completed', wfStatus)
  check('the card asking to use the computer appeared in the run, naming the window', askedInRun.some((t) => /Let the assistant use “Desktop control target”/.test(t)), askedInRun.join(' | '))
  check('and the step then pressed the button in that window', (await tp.evaluate(() => window.clicks)) === wfClicks + 1)
  const wfBodies = JSON.stringify(stub.requests.map((r) => r.body))
  check('the second step was told what the first was asked and found, so it knows what “there” is', /Result: Facebook is open\./.test(wfBodies) && /open the page/.test(wfBodies))
  await sleep(800)
  check('control ended with the step, and the bar is gone', windowCount() === 1)
  try {
    rmSync(wfFolder, { recursive: true, force: true })
  } catch {
    /* the run's program may still hold the folder for a moment; it is a temporary one */
  }

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

  console.log('\n# How long, and the list of recent grants')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Desktop control' }).click()
  check('Settings no longer asks how long one yes lasts, or about the whole screen: the card does', (await page.getByLabel('How long one yes lasts').count()) === 0 && (await page.getByRole('switch', { name: 'Let it ask for the whole screen' }).count()) === 0)
  const listText = await page.getByText('Recent times the assistant had the screen').locator('xpath=..').innerText()
  check('and lists the recent times it had the screen, with why, what and how it ended', /Round hotkey/.test(listText) && /the whole main screen/.test(listText) && /You pressed the stop key./.test(listText) && /Round scoped/.test(listText) && /only the window “Desktop control target”/.test(listText), listText.slice(0, 400))
  await page.keyboard.press('Escape')
  await newChat()
  await send('ROUND:hour use the screen')
  const hourCard = page.getByRole('group', { name: 'Approval needed' }).last()
  await hourCard.waitFor({ timeout: 30_000 })
  const slider = hourCard.getByRole('slider')
  check('the card has a slider for how long, at 20 minutes to start with, from 5 minutes to 2 hours', (await slider.inputValue()) === '20' && (await slider.getAttribute('min')) === '5' && (await slider.getAttribute('max')) === '120')
  await slider.fill('60')
  check('moving it says how long', /For 1 hour/.test(await hourCard.innerText()))
  const until = hourCard.getByRole('checkbox', { name: /Until I stop it/ })
  await until.check()
  check('the card also offers “Until I stop it”, which puts the slider away', /Until I stop it/.test(await hourCard.innerText()) && (await slider.isDisabled()))
  await hourCard.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.getByText('Round hour is over.').waitFor({ timeout: 60_000 })
  await saveSettings(page, { desktopControl: false })
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(out, 'desktop-failure.png') }).catch(() => undefined)
} finally {
  await cover?.close().catch(() => undefined)
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
