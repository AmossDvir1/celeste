// The compact window, in the real built app: the button next to the window buttons makes the window a small side window at the bottom right
// of the screen, with a slim top bar and no sidebar; the home of the small window lists the chats and takes a message; a conversation shows
// folded and can be answered; the way back restores the old size; the shape is remembered across a restart.
// npm run verify:compact       (no account, no cost)
// Claude is real (the real SDK and program); what it says is chosen by a stand-in for Anthropic's API (scripts/lib/stub.mjs).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'
import { claudeReady, pasteClaudeKey, say, startStub } from './lib/stub.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-compact-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const geometry = (app) =>
  app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const b = win.getBounds()
    return { ...b, onTop: win.isAlwaysOnTop(), area: screen.getDisplayMatching(b).workArea }
  })

let stub
let started
try {
  stub = await startStub()
  started = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  let { app, page } = started
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  await page.reload()
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI vendors' }).click()
  await pasteClaudeKey(page)
  await page.keyboard.press('Escape')
  await claudeReady(page)
  await say(page, 'First question')
  const before = await geometry(app)

  console.log('\n# Making the window small')
  // This computer may have Windows' animation effects off: the change is animated all the same.
  await page.getByRole('button', { name: 'Compact view (Ctrl+Shift+M)' }).click()
  // The window glides: the widths seen on the way are between the two sizes.
  const seen = new Set()
  let faded = false
  for (let i = 0; i < 24; i++) {
    seen.add((await geometry(app)).width)
    faded ||= (await page.evaluate(() => document.documentElement.getAttribute('data-layout-switch'))) === 'out'
    await sleep(25)
  }
  check('the page is faded out while the window moves', faded)
  const between = [...seen].filter((w) => w > 560 && w < before.width - 40)
  check('the window is animated: it is seen at sizes between the two', between.length >= 2, [...seen].join(', '))
  await page.getByRole('button', { name: 'Full view (Ctrl+Shift+M)' }).waitFor({ timeout: 8000 })
  await sleep(500)
  check('and shown again once the new layout is there', (await page.evaluate(() => document.documentElement.getAttribute('data-layout-switch'))) === null)
  const small = await geometry(app)
  check('the window is about 520 pixels wide', small.width >= 440 && small.width <= 540, `${small.width}`)
  check('it rests at the bottom right of the usable area', Math.abs(small.x + small.width - (small.area.x + small.area.width)) <= 24 && Math.abs(small.y + small.height - (small.area.y + small.area.height)) <= 24, JSON.stringify(small))
  check('it stays above other windows', small.onTop === true)
  check('there is no sidebar and no top bar of the full window', (await page.getByRole('complementary').count()) === 0 && (await page.getByText('Your AI workbench').count()) === 0)
  check('the three modes are there as icons', (await page.getByRole('navigation', { name: 'Modes' }).getByRole('button').count()) === 3)

  console.log('\n# Changing back and forth quickly')
  await page.getByRole('button', { name: 'Full view (Ctrl+Shift+M)' }).click()
  await sleep(120)
  await page.keyboard.press('Control+Shift+M')
  await sleep(100)
  await page.keyboard.press('Control+Shift+M')
  await page.getByRole('button', { name: 'Compact view (Ctrl+Shift+M)' }).waitFor({ timeout: 8000 })
  await sleep(700)
  const bounced = await geometry(app)
  check('after a quick change of mind the window is the full one it was', Math.abs(bounced.width - before.width) <= 4 && Math.abs(bounced.height - before.height) <= 4, JSON.stringify(bounced))
  await page.getByRole('button', { name: 'Compact view (Ctrl+Shift+M)' }).click()
  await page.getByRole('button', { name: 'Full view (Ctrl+Shift+M)' }).waitFor({ timeout: 8000 })
  await sleep(500)

  console.log('\n# The conversation, compacted')
  check('the chat that was open is shown, with a way back to the list', (await page.getByText('First question').count()) > 0 && (await page.getByRole('button', { name: 'All chats' }).count()) === 1)
  check('the right-hand panels are not offered', (await page.getByRole('button', { name: /Tools & Integrations|Browser \(/ }).count()) === 0)
  await say(page, 'Second question')
  check('a message sent from the small window is answered', (await page.getByText('Echo: Second question', { exact: false }).count()) > 0)

  console.log('\n# The home of the small window')
  await page.getByRole('button', { name: 'All chats' }).click()
  const recent = page.getByRole('region', { name: 'Recent chats' })
  await recent.waitFor({ timeout: 8000 })
  check('the recent chats are listed, the newest first as "Continue"', (await recent.getByText('Continue').count()) === 1 && (await recent.getByRole('listitem').count()) >= 1)
  check('there is a box to type in', (await page.getByRole('textbox', { name: 'Message' }).count()) === 1)
  await recent.getByRole('listitem').first().getByRole('button').click()
  await page.getByRole('button', { name: 'All chats' }).waitFor()
  check('choosing one opens it', true)

  console.log('\n# Workflows')
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Workflows' }).click()
  await page.getByRole('heading', { name: 'Workflows', exact: true }).waitFor()
  check('the Workflows tab lists the workflows and says editing is in the full view', (await page.getByText('Editing, building with AI and importing are in the').count()) === 1)
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Chat' }).click()

  console.log('\n# The smallest the window can be')
  await page.getByRole('navigation', { name: 'Modes' }).getByRole('button', { name: 'Chat' }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(100, 300))
  await sleep(400)
  const least = await geometry(app)
  check('it cannot be made narrower than the top bar needs', least.width >= 400, `${least.width}`)
  // The native window buttons are drawn over the right edge: the pin and the way back must end before them.
  const room = await page.evaluate(() => {
    const area = navigator.windowControlsOverlay?.getTitlebarAreaRect()
    const full = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Full view'))
    if (!area || !full) return null
    return { buttons: full.getBoundingClientRect().right, free: area.x + area.width }
  })
  check('the pin and the way back are clear of the window buttons', room !== null && room.buttons <= room.free, JSON.stringify(room))

  console.log('\n# Always opens as the full window')
  await started.app.close()
  started = await launch({ width: 1440, height: 900, theme: null, profile, env: stub.env })
  ;({ app, page } = started)
  await page.getByRole('button', { name: 'Compact view (Ctrl+Shift+M)' }).waitFor({ timeout: 20_000 })
  await sleep(500)
  const after = await geometry(app)
  check('after being closed as the small window, Celeste opens as the full one', after.width >= 1000 && after.onTop === false, JSON.stringify(after))
  check('the sidebar is there', (await page.getByRole('complementary').count()) >= 1)
} catch (err) {
  console.error(err)
  failures.push('the script failed')
} finally {
  await started?.app.close().catch(() => undefined)
  await stub?.stop?.().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nAll passed')
