// Closing the window leaves Celeste running in the tray (Windows): the window is hidden and not destroyed, the process lives, starting Celeste
// again brings the window back, and with the setting off closing quits as before. The tray icon itself cannot be seen from here: look at it by hand.
// npm run verify:tray       (no account, no cost; Windows only)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'

if (process.platform !== 'win32') {
  console.log('SKIP  the tray is only used on Windows')
  process.exit(0)
}

const profile = mkdtempSync(join(tmpdir(), 'celeste-tray-'))
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const state = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return win ? { visible: win.isVisible(), count: BrowserWindow.getAllWindows().length } : null
  })

let started
try {
  started = await launch({ width: 1440, height: 900, theme: null, profile })
  const { app, page } = started
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })
  const settings = await page.evaluate(() => window.celeste.core.call('settings.get', []))
  check('closing keeps Celeste running by default', settings.closeToTray === true)
  await page.waitForTimeout(500)

  console.log('\n# Closing the window')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await new Promise((r) => setTimeout(r, 2500))
  const hidden = await state(app)
  check('the window is hidden, not destroyed', hidden !== null && hidden.visible === false)
  check('Celeste is still running', app.process().exitCode === null)

  console.log('\n# Starting Celeste again');
  await app.evaluate(({ app: electron }) => electron.emit('second-instance'))
  await new Promise((r) => setTimeout(r, 800))
  check('the window comes back', (await state(app))?.visible === true)

  console.log('\n# With the setting off')
  await saveSettings(page, { closeToTray: false })
  await new Promise((r) => setTimeout(r, 500))
  const gone = new Promise((resolve) => app.process().once('exit', () => resolve(true)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => undefined)
  const quit = await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))])
  check('closing the window quits', quit === true)
} catch (err) {
  console.error(err)
  failures.push('the script failed')
} finally {
  await started?.app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nAll passed')
