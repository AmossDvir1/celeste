// Closing the window leaves Celeste running in the tray (Windows): the window is hidden and not destroyed, the process lives, starting Celeste
// again brings the window back, and with the setting off closing quits as before. The schedules' part of the tray (docs/plans/SCHEDULING_PLAN.md,
// step 5): the menu item "Pause all schedules" appears once there is a schedule and pauses and resumes them, the computer waking runs what came
// due while it slept, a scheduled run that fails is told to the person in a notification that opens Celeste again, and a start with
// --background leaves the window hidden until it is opened from the tray.
// The tray icon itself cannot be seen from here: look at it by hand.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, what, ms = 15_000) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`)
    await sleep(200)
  }
}
// The tray menu is the system's own, so the app hands the checks its labels and lets them press an item (CELESTE_TEST_HOOKS).
const menu = (app) => app.evaluate(() => globalThis.celesteTest.tray().labels)
const tooltip = (app) => app.evaluate(() => globalThis.celesteTest.tray().tooltip)
const notices = (app) => app.evaluate(() => globalThis.celesteTest.notices())
const press = (app, label) => app.evaluate((_, l) => globalThis.celesteTest.tray().press(l), label)

let started
let hidden2
const profile2 = mkdtempSync(join(tmpdir(), 'celeste-tray-bg-'))
try {
  started = await launch({ width: 1440, height: 900, theme: null, profile, env: { CELESTE_TEST_HOOKS: '1', CELESTE_SCHEDULER_TICK_MS: '120000' } })
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

  console.log('\n# Schedules')
  check('with no schedule there is nothing to pause, so the menu does not offer it', !(await menu(app)).includes('Pause all schedules'))
  const core = (method, ...params) => page.evaluate(([m, p]) => window.celeste.core.call(m, p), [method, params])
  const wf = await core('workflows.save', {
    name: 'Tray report',
    description: '',
    definition: {
      nodes: [
        { id: 'start', type: 'start', name: 'Start', inputs: [] },
        { id: 'write', type: 'tool', name: 'Write', tool: { kind: 'file', op: 'write', path: 'tray.md', content: 'hi' } },
        { id: 'end', type: 'end', name: 'End' }
      ],
      edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }]
    }
  })
  const due = Date.now() + 3000
  await core('schedules.save', { workflowId: wf.id, spec: { kind: 'once', at: due }, inputs: {}, approved: true })
  await waitFor(async () => (await menu(app)).includes('Pause all schedules'), 'the menu to offer "Pause all schedules"')
  check('once there is a schedule the menu offers "Pause all schedules"', true)
  check('pressing it pauses them, and the menu and the tooltip say so', (await press(app, 'Pause all schedules')) === true && (await waitFor(async () => (await menu(app)).includes('Resume all schedules'), 'the menu to offer Resume')) && /schedules paused/.test(await tooltip(app)) && (await core('schedules.paused')) === true)
  await press(app, 'Resume all schedules')
  await waitFor(async () => (await menu(app)).includes('Pause all schedules'), 'the menu to offer Pause again')
  check('pressing it again resumes them', (await core('schedules.paused')) === false && !/schedules paused/.test(await tooltip(app)))
  await sleep(Math.max(0, due + 500 - Date.now()))
  check('the scheduler looks only every two minutes here, so its time has passed and nothing has run', (await core('runs.list', wf.id)).length === 0)
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  const woke = await waitFor(async () => (await core('runs.list', wf.id)).find((r) => r.status === 'completed'), 'the run after the computer woke')
  check('the computer waking runs what came due while it slept, at once', woke.startedBy === 'schedule')

  console.log('\n# Telling the person')
  // The window is hidden (as it is in the tray), which is when a notification is wanted.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  const bad = await core('workflows.save', {
    name: 'Failing job',
    description: '',
    definition: {
      nodes: [
        { id: 'start', type: 'start', name: 'Start', inputs: [] },
        { id: 'boom', type: 'tool', name: 'Fail', tool: { kind: 'shell', command: 'exit 1' } },
        { id: 'end', type: 'end', name: 'End' }
      ],
      edges: [{ from: 'start', to: 'boom' }, { from: 'boom', to: 'end' }]
    }
  })
  const due2 = Date.now() + 2000
  await core('schedules.save', { workflowId: bad.id, spec: { kind: 'once', at: due2 }, inputs: {}, approved: true })
  await sleep(Math.max(0, due2 + 500 - Date.now()))
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  const said = await waitFor(async () => (await notices(app)).find((n) => /Failing job failed/.test(n.title)), 'the notification about the failed run')
  check('a scheduled run that failed is told to the person: its name and what went wrong', !!said && said.body.length > 0, JSON.stringify(said))
  const failed = (await core('runs.list', bad.id)).find((r) => r.status === 'failed')
  check('and it is in the history as a scheduled run that failed', failed?.startedBy === 'schedule')
  check('the window stayed hidden while it did', (await state(app))?.visible === false)
  await app.evaluate((_, i) => globalThis.celesteTest.clickNotice(i), (await notices(app)).findIndex((n) => n.title === said.title))
  await sleep(800)
  check('clicking the notification brings Celeste back', (await state(app))?.visible === true)

  console.log('\n# With the setting off')
  await saveSettings(page, { closeToTray: false })
  await new Promise((r) => setTimeout(r, 500))
  const gone = new Promise((resolve) => app.process().once('exit', () => resolve(true)))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => undefined)
  const quit = await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 15_000))])
  check('closing the window quits', quit === true)

  console.log('\n# Started with the computer')
  started = undefined
  hidden2 = await launch({ width: 1440, height: 900, theme: null, profile: profile2, chromiumArgs: ['--background'], env: { CELESTE_TEST_HOOKS: '1' } })
  await sleep(1500)
  check('with --background the window is made but stays hidden, and Celeste is running', (await state(hidden2.app))?.visible === false && hidden2.app.process().exitCode === null)
  check('the tray has the way back in', (await menu(hidden2.app)).includes('Open Celeste'))
  await press(hidden2.app, 'Open Celeste')
  await sleep(800)
  check('"Open Celeste" shows the window', (await state(hidden2.app))?.visible === true)
} catch (err) {
  console.error(err)
  failures.push('the script failed')
} finally {
  await started?.app.close().catch(() => undefined)
  await hidden2?.app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
  rmSync(profile2, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nAll passed')
