// Scheduled workflows, in the real built app, as far as Core goes (docs/plans/SCHEDULING_PLAN.md, steps 1 to 3; the window comes with step 4):
// a schedule made with the card's approval starts a real run at its time with no card, the run is marked as the schedule's, editing the
// workflow pauses the schedule at once, a schedule that is switched off does not run, and everything is still there after a restart without
// firing twice.   npm run verify:schedules     (no account, no cost)
// The scheduler looks every half second here (CELESTE_SCHEDULER_TICK_MS), not every thirty seconds.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, saveSettings } from './lib/app.mjs'

const profile = mkdtempSync(join(tmpdir(), 'celeste-schedules-'))
const work = mkdtempSync(join(tmpdir(), 'celeste-schedules-work-'))
mkdirSync(join(import.meta.dirname, '.output'), { recursive: true })
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}
const core = (page, method, ...params) => page.evaluate(([m, p]) => window.celeste.core.call(m, p), [method, params])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, what, ms = 20_000) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`)
    await sleep(200)
  }
}

const definition = (content) => ({
  nodes: [
    { id: 'start', type: 'start', name: 'Start', inputs: [{ name: 'who', type: 'text', default: 'world' }] },
    { id: 'write', type: 'tool', name: 'Write the report', tool: { kind: 'file', op: 'write', path: 'report-{{run.date}}.md', content } },
    { id: 'end', type: 'end', name: 'End', output: 'wrote it for {{inputs.who}}' }
  ],
  edges: [{ from: 'start', to: 'write' }, { from: 'write', to: 'end' }]
})
const open = (env = {}) => launch({ width: 1440, height: 900, theme: null, profile, env: { CELESTE_SCHEDULER_TICK_MS: '500', ...env } })

let app
try {
  app = await open()
  let { page } = app
  await page.getByRole('dialog', { name: 'Set up Celeste' }).waitFor({ timeout: 20_000 })
  await saveSettings(page, { wizardDone: true, userName: 'Dana' })

  const wf = await core(page, 'workflows.save', { name: 'Daily report', description: 'Writes a report.', definition: definition('Hello {{inputs.who}}') })

  console.log('\n# Making one, with the approval')
  const preview = await core(page, 'schedules.preview', { workflowId: wf.id, inputs: { who: 'Dana' }, spec: { kind: 'daily', time: '09:00' } })
  check('the card is drawn from what a run would do, with the answers filled in, and there is nothing wrong with it', preview.problems.length === 0 && preview.actions.some((a) => a.kind === 'file' && /report-/.test(a.text)) && preview.next.length === 5)
  let refused = ''
  try {
    await core(page, 'schedules.save', { workflowId: wf.id, spec: { kind: 'daily', time: '09:00' }, inputs: {}, folder: work, approved: false })
  } catch (err) {
    refused = String(err.message ?? err)
  }
  check('it is refused without the card’s answer', /before a schedule is made/.test(refused), refused)

  console.log('\n# At its time')
  const soon = Date.now() + 3000
  const made = await core(page, 'schedules.save', { workflowId: wf.id, spec: { kind: 'once', at: soon }, inputs: { who: 'Dana' }, folder: work, approved: true })
  check('a schedule is made and says when it runs next', made.enabled === true && made.nextRunAt === soon && /^Once, /.test(made.describe), JSON.stringify(made))
  const run = await waitFor(async () => (await core(page, 'runs.list', wf.id)).find((r) => r.status === 'completed'), 'the scheduled run to finish')
  check('the run started by itself, with the schedule’s name on it, and finished', run.startedBy === 'schedule' && run.scheduleId === made.id && run.output === 'wrote it for Dana', JSON.stringify(run))
  const detail = await core(page, 'runs.get', run.id)
  const types = detail.events.map((e) => e.event.type)
  check('with no card: the log says a schedule allowed it in advance', types.includes('approval.preapproved') && !types.includes('approval.requested'), types.join(', '))
  const date = new Date().toLocaleDateString('sv-SE')
  check('it did what the workflow says, with today’s date in the file name', readFileSync(join(work, `report-${date}.md`), 'utf8') === 'Hello Dana')
  const after = (await core(page, 'schedules.list', wf.id))[0]
  check('a "once" schedule is finished and off afterwards', after.enabled === false && after.nextRunAt === null && after.lastRun?.status === 'completed', JSON.stringify(after))
  await sleep(1500)
  check('and it did not run again', (await core(page, 'runs.list', wf.id)).length === 1)

  console.log('\n# A daily one, an edit, and off')
  const daily = await core(page, 'schedules.save', { workflowId: wf.id, spec: { kind: 'daily', time: '09:00' }, inputs: {}, folder: work, approved: true })
  const off = await core(page, 'schedules.setEnabled', daily.id, false)
  check('it can be switched off', off.enabled === false)
  const on = await core(page, 'schedules.setEnabled', daily.id, true)
  check('and on again, with its next time worked out', on.enabled === true && on.nextRunAt > Date.now())
  await core(page, 'workflows.save', { id: wf.id, name: 'Daily report', description: 'Writes a report.', definition: definition('Something else entirely') })
  const edited = (await core(page, 'schedules.list', wf.id)).find((s) => s.id === daily.id)
  check('editing the workflow pauses the schedule at once: it needs the person’s OK again', edited.enabled === false && edited.pausedReason === 'edited', JSON.stringify(edited))
  let again = ''
  try {
    await core(page, 'schedules.setEnabled', daily.id, true)
  } catch (err) {
    again = String(err.message ?? err)
  }
  check('and cannot be switched on without looking at it again', /approve it again/.test(again), again)
  check('the pause is written in its log', (await core(page, 'schedules.log', daily.id)).some((e) => e.kind === 'paused'))
  const renamed = await core(page, 'workflows.save', { id: wf.id, name: 'Daily report (renamed)', description: 'Writes a report.', definition: definition('Something else entirely') })
  check('a new name alone is not a new version', renamed.version === (await core(page, 'workflows.get', wf.id)).version)

  console.log('\n# After a restart')
  const keep = await core(page, 'schedules.save', { id: daily.id, workflowId: wf.id, spec: { kind: 'daily', time: '09:00' }, inputs: {}, folder: work, approved: true })
  await app.close()
  app = await open()
  page = app.page
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 })
  const kept = (await core(page, 'schedules.list', wf.id)).find((s) => s.id === daily.id)
  check('the schedule is still there with what was approved and when it runs next', kept && kept.enabled === true && kept.nextRunAt === keep.nextRunAt && kept.approvedVersion === keep.approvedVersion, JSON.stringify(kept))
  await sleep(1500)
  check('and nothing ran just because Celeste started', (await core(page, 'runs.list', wf.id)).length === 1)
  await core(page, 'schedules.remove', daily.id)
  await core(page, 'workflows.remove', wf.id)
  check('removing the workflow takes its schedules with it', (await core(page, 'schedules.list')).length === 0)
} catch (err) {
  console.error(err)
  failures.push('the script itself failed')
  await app?.page.screenshot({ path: join(import.meta.dirname, '.output', 'schedules-failure.png') }).catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  for (const dir of [profile, work]) {
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

console.log(failures.length ? `\n${failures.length} failed: ${failures.join('; ')}` : '\nAll checks passed.')
process.exit(failures.length ? 1 : 0)
