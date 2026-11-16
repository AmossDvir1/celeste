import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import type { RunSummary, WorkflowDefinition, WorkflowNode } from '@shared/workflow'
import { MemoryStore } from '../testing/memory-store'
import { WorkflowRunner } from './runner'
import { ScheduleService } from './schedule-service'
import { Scheduler } from './scheduler'

/*
 * The runner, the scheduler and the schedule service together, as Core wires them: a schedule made on the card starts a real run with no
 * card at its time, and a change to the workflow stops it until the person approves again.
 */

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'celeste-scheduling-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const start: WorkflowNode = { id: 'start', type: 'start', name: 'Start', inputs: [{ name: 'who', type: 'text', default: 'world' }] }
const write = (content: string): WorkflowNode => ({ id: 'write', type: 'tool', name: 'Write the report', tool: { kind: 'file', op: 'write', path: 'report-{{run.date}}.md', content } })
const end: WorkflowNode = { id: 'end', type: 'end', name: 'End', output: 'done {{run.time}}' }
const chain = (...nodes: WorkflowNode[]): WorkflowDefinition => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id })) })

function world(def = chain(start, write('Hello {{inputs.who}}'), end), phoneProblem: string | null = null) {
  const store = new MemoryStore()
  const clock = { now: new Date(2026, 10, 16, 8, 0, 0).getTime() }
  const notices: string[] = []
  store.saveWorkflow({ id: 'w1', name: 'Report', description: '', version: 1, allowAssistant: false, definition: def, createdAt: 1, updatedAt: 1 })
  let scheduler!: Scheduler
  const pushed: CorePush[] = []
  const runner = new WorkflowRunner({
    store,
    push: (p) => {
      pushed.push(p)
      // The same hook Core has: every run is shown to the scheduler.
      if (p.type === 'run') scheduler.onRun(p.run)
    },
    agent: { run: async () => 'x' },
    mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) },
    phone: { problem: () => phoneProblem },
    now: () => clock.now
  })
  scheduler = new Scheduler({ store, runner, now: () => clock.now, notify: (n) => void notices.push(`${n.kind}: ${n.text}`) })
  const service = new ScheduleService(store, runner, { now: () => clock.now, dataDir: folder })
  const until = async (status: RunSummary['status']) => {
    for (let i = 0; i < 300; i++) {
      const run = store.listScheduleRuns(store.listSchedules()[0]?.id as string, 1)[0]
      if (run?.status === status) return run
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`No scheduled run became ${status}`)
  }
  const at = (h: number, m = 0, day = 17) => void (clock.now = new Date(2026, 10, day, h, m, 5).getTime())
  return { store, scheduler, service, runner, notices, until, at, pushed }
}

describe('scheduled workflows, end to end', () => {
  it('runs at its time with no card, with the date in its file, and again the next day', async () => {
    const w = world()
    const made = await w.service.api['schedules.save']({ workflowId: 'w1', spec: { kind: 'daily', time: '09:00' }, inputs: { who: 'Dana' }, folder, approved: true })
    expect(made.nextRunAt).toBe(new Date(2026, 10, 16, 9, 0, 0).getTime())

    w.at(8, 59, 16)
    await w.scheduler.tick()
    expect(w.store.listRuns(undefined, 5)).toEqual([])

    w.at(9, 0, 16)
    await w.scheduler.tick()
    const run = await w.until('completed')
    expect(run).toMatchObject({ startedBy: 'schedule', scheduleId: made.id, output: 'done 09:00' })
    expect(w.store.runEvents(run.id).map((e) => e.event.type)).toContain('approval.preapproved')
    expect(w.store.runEvents(run.id).map((e) => e.event.type)).not.toContain('approval.requested')
    expect(readFileSync(join(folder, 'report-2026-11-16.md'), 'utf8')).toBe('Hello Dana')

    w.at(9, 0, 17)
    await w.scheduler.tick()
    for (let i = 0; i < 200 && !existsSync(join(folder, 'report-2026-11-17.md')); i++) await new Promise((r) => setTimeout(r, 10))
    expect(readFileSync(join(folder, 'report-2026-11-17.md'), 'utf8')).toBe('Hello Dana')
    expect(w.store.listScheduleRuns(made.id, 10)).toHaveLength(2)
  })

  it('stops, and says so, when the workflow is changed after it was approved, and runs the new version only after it is approved again', async () => {
    const w = world()
    const made = await w.service.api['schedules.save']({ workflowId: 'w1', spec: { kind: 'daily', time: '09:00' }, inputs: {}, folder, approved: true })
    // The person edits the steps: a new version.
    w.store.saveWorkflow({ ...(w.store.getWorkflow('w1') as NonNullable<ReturnType<typeof w.store.getWorkflow>>), version: 2, definition: chain(start, write('Something else entirely'), end) })
    w.scheduler.onWorkflowSaved('w1')
    expect(w.service.api['schedules.list']()[0]).toMatchObject({ enabled: false, pausedReason: 'edited' })
    expect(w.notices[0]).toMatch(/^schedule-paused: Daily at 09:00: Paused because “Report” changed/)

    w.at(9, 0, 17)
    await w.scheduler.tick()
    expect(w.store.listRuns(undefined, 5)).toEqual([])
    expect(() => w.service.api['schedules.setEnabled'](made.id, true)).toThrow(/approve it again/)

    // Approving again on the card makes it run, and it runs the new version.
    await w.service.api['schedules.save']({ id: made.id, workflowId: 'w1', spec: { kind: 'daily', time: '09:00' }, inputs: {}, folder, approved: true })
    w.at(9, 0, 18)
    await w.scheduler.tick()
    const run = await w.until('completed')
    expect(run.version).toBe(2)
    expect(readFileSync(join(folder, 'report-2026-11-18.md'), 'utf8')).toBe('Something else entirely')
  })

  it('shows a run that could not start as a failed run in the history, with its sentence, and tells the person', async () => {
    const phoneStep: WorkflowNode = { id: 'phone', type: 'agent', name: 'Set the alarm', prompt: 'set an alarm', phone: {} }
    const w = world(chain(start, phoneStep, end), null)
    const made = await w.service.api['schedules.save']({ workflowId: 'w1', spec: { kind: 'daily', time: '09:00' }, inputs: {}, folder, approved: true })
    // The phone goes away after the schedule was made.
    ;(w.runner as unknown as { deps: { phone: { problem: () => string | null } } }).deps.phone.problem = () => 'the phone is not connected. Open Celeste on it.'
    w.at(9, 0, 16)
    await w.scheduler.tick()
    const [run] = w.store.listScheduleRuns(made.id, 5)
    expect(run).toMatchObject({ status: 'failed', startedBy: 'schedule', error: '“Set the alarm” uses the phone, but the phone is not connected. Open Celeste on it.' })
    expect(w.store.getSchedule(made.id)?.failStreak).toBe(1)
    expect(w.notices).toEqual([expect.stringMatching(/^run-failed: .*phone is not connected/)])
    expect(w.store.scheduleLog(made.id, 5)[0]?.kind).toBe('failed-to-start')
  })
})
