import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleRow } from '@shared/schedule'
import type { RunSummary, WorkflowDefinition } from '@shared/workflow'
import { SqliteStore } from './sqlite-store'
import type { Store, WorkflowRow } from './store'
import { MemoryStore } from './testing/memory-store'

const definition: WorkflowDefinition = {
  nodes: [
    { id: 'start', type: 'start', name: 'Start', inputs: [] },
    { id: 'end', type: 'end', name: 'End' }
  ],
  edges: [{ from: 'start', to: 'end' }]
}
const workflow = (id: string): WorkflowRow => ({ id, name: `Workflow ${id}`, description: '', version: 1, allowAssistant: false, definition, createdAt: 1, updatedAt: 1 })
const schedule = (id: string, workflowId: string, over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id,
  workflowId,
  enabled: true,
  spec: { kind: 'daily', time: '09:00' },
  timezone: 'Asia/Jerusalem',
  inputs: { env: 'staging', days: 3, loud: true },
  folder: 'D:/work',
  approvedVersion: 1,
  approvedHash: 'abc',
  approvedAt: 5,
  graceSec: 7200,
  waitLimitSec: 1800,
  notify: 'problems',
  nextRunAt: 1000,
  lastFireAt: null,
  failStreak: 0,
  createdAt: 10,
  updatedAt: 10,
  ...over
})
const run = (id: string, workflowId: string, over: Partial<RunSummary> = {}): RunSummary => ({ id, workflowId, workflowName: 'W', version: 1, status: 'completed', startedBy: 'you', inputs: {}, folder: 'D:/work', startedAt: 100, ...over })

const dirs: string[] = []
const opened: Store[] = []
afterEach(() => {
  while (opened.length) opened.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const stores: [string, () => Store][] = [
  ['the in-memory store', () => new MemoryStore()],
  [
    'the SQLite store',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'celeste-sched-'))
      dirs.push(dir)
      const s = new SqliteStore(join(dir, 'a.db'))
      opened.push(s)
      return s
    }
  ]
]

describe.each(stores)('schedules in %s', (_name, make) => {
  it('keeps a schedule with everything the person approved, and gives back exactly that', () => {
    const s = make()
    s.saveWorkflow(workflow('w1'))
    const row = schedule('sch-1', 'w1', { spec: { kind: 'weekly', time: '18:30', days: [1, 5] }, lastFireAt: 500, failStreak: 2, pausedReason: 'edited', enabled: false, nextRunAt: null })
    s.saveSchedule(row)
    expect(s.getSchedule('sch-1')).toEqual(row)
    expect(s.getSchedule('nope')).toBeUndefined()
  })

  it('replaces a schedule it already has, and lists them by workflow in the order they were made', () => {
    const s = make()
    s.saveWorkflow(workflow('w1'))
    s.saveWorkflow(workflow('w2'))
    s.saveSchedule(schedule('sch-1', 'w1', { createdAt: 10 }))
    s.saveSchedule(schedule('sch-2', 'w2', { createdAt: 20 }))
    s.saveSchedule(schedule('sch-3', 'w1', { createdAt: 30 }))
    s.saveSchedule(schedule('sch-1', 'w1', { createdAt: 10, nextRunAt: 2000, failStreak: 1 }))
    expect(s.listSchedules().map((x) => x.id)).toEqual(['sch-1', 'sch-2', 'sch-3'])
    expect(s.listSchedules('w1').map((x) => x.id)).toEqual(['sch-1', 'sch-3'])
    expect(s.getSchedule('sch-1')).toMatchObject({ nextRunAt: 2000, failStreak: 1 })
  })

  it('finds the schedules that are on and due, earliest first, and none that are off, finished or in the future', () => {
    const s = make()
    s.saveWorkflow(workflow('w1'))
    s.saveSchedule(schedule('late', 'w1', { nextRunAt: 900 }))
    s.saveSchedule(schedule('early', 'w1', { nextRunAt: 100 }))
    s.saveSchedule(schedule('now', 'w1', { nextRunAt: 1000 }))
    s.saveSchedule(schedule('future', 'w1', { nextRunAt: 1001 }))
    s.saveSchedule(schedule('off', 'w1', { enabled: false, nextRunAt: 50 }))
    s.saveSchedule(schedule('done', 'w1', { nextRunAt: null }))
    expect(s.dueSchedules(1000).map((x) => x.id)).toEqual(['early', 'late', 'now'])
    expect(s.dueSchedules(99)).toEqual([])
  })

  it('goes with its workflow, and takes its log with it, but not another workflow’s schedules', () => {
    const s = make()
    s.saveWorkflow(workflow('w1'))
    s.saveWorkflow(workflow('w2'))
    s.saveSchedule(schedule('sch-1', 'w1'))
    s.saveSchedule(schedule('sch-2', 'w2'))
    s.appendScheduleLog('sch-1', 1, 'missed', 'late')
    s.deleteWorkflow('w1')
    expect(s.getSchedule('sch-1')).toBeUndefined()
    expect(s.scheduleLog('sch-1', 10)).toEqual([])
    expect(s.listSchedules().map((x) => x.id)).toEqual(['sch-2'])
  })

  it('deletes one schedule and its log', () => {
    const s = make()
    s.saveWorkflow(workflow('w1'))
    s.saveSchedule(schedule('sch-1', 'w1'))
    s.appendScheduleLog('sch-1', 1, 'skipped', 'x')
    s.deleteSchedule('sch-1')
    expect(s.listSchedules()).toEqual([])
    expect(s.scheduleLog('sch-1', 10)).toEqual([])
  })

  it('logs what a schedule skipped, newest first, and keeps the newest 200', () => {
    const s = make()
    s.saveWorkflow(workflow('w1'))
    s.saveSchedule(schedule('sch-1', 'w1'))
    s.saveSchedule(schedule('sch-2', 'w1'))
    for (let i = 1; i <= 205; i++) s.appendScheduleLog('sch-1', i, 'skipped', `n${i}`)
    s.appendScheduleLog('sch-2', 1, 'paused', 'edited')
    const log = s.scheduleLog('sch-1', 500)
    expect(log).toHaveLength(200)
    expect(log[0]).toMatchObject({ at: 205, kind: 'skipped', text: 'n205' })
    expect(log[199]?.text).toBe('n6')
    expect(s.scheduleLog('sch-1', 3).map((e) => e.text)).toEqual(['n205', 'n204', 'n203'])
    expect(s.scheduleLog('sch-2', 10).map((e) => e.kind)).toEqual(['paused'])
  })

  it('records which schedule started a run, and lists a schedule’s runs newest first', () => {
    const s = make()
    s.saveWorkflow(workflow('w1'))
    s.saveSchedule(schedule('sch-1', 'w1'))
    s.insertRun(run('r1', 'w1', { startedBy: 'schedule', scheduleId: 'sch-1', startedAt: 100 }))
    s.insertRun(run('r2', 'w1', { startedAt: 150 }))
    s.insertRun(run('r3', 'w1', { startedBy: 'schedule', scheduleId: 'sch-1', startedAt: 200 }))
    expect(s.getRun('r1')).toMatchObject({ startedBy: 'schedule', scheduleId: 'sch-1' })
    expect(s.getRun('r2')).not.toHaveProperty('scheduleId')
    expect(s.listScheduleRuns('sch-1', 10).map((r) => r.id)).toEqual(['r3', 'r1'])
    expect(s.listScheduleRuns('sch-1', 1).map((r) => r.id)).toEqual(['r3'])
    expect(s.listScheduleRuns('other', 10)).toEqual([])
  })
})

describe('the schedule tables arrive in migration 6', () => {
  it('adds them to a database from before, with its workflows and runs untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'celeste-sched-mig-'))
    dirs.push(dir)
    const path = join(dir, 'old.db')
    const real = (await vi.importActual<typeof import('./migrations')>('./migrations')).MIGRATIONS
    expect(real.length).toBeGreaterThanOrEqual(6)

    // A database as the last release made it: migrations 1 to 5 only.
    vi.resetModules()
    vi.doMock('./migrations', () => ({ MIGRATIONS: real.slice(0, 5) }))
    new (await import('./sqlite-store')).SqliteStore(path).close()
    // Written with SQL of its own, as the old Celeste wrote it: the store of today would put a column there that the old schema lacks.
    const raw = new DatabaseSync(path)
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'workflow_schedules'").get()).toBeUndefined()
    raw.prepare('INSERT INTO workflows (id, name, description, version, allow_assistant, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('w1', 'Workflow w1', '', 1, 0, JSON.stringify(definition), 1, 1)
    raw.prepare('INSERT INTO workflow_runs (id, workflow_id, workflow_name, version, status, started_by, inputs_json, folder, started_at, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('r1', 'w1', 'W', 1, 'completed', 'you', '{}', 'D:/work', 100, 'kept')
    raw.close()

    vi.resetModules()
    vi.doMock('./migrations', () => ({ MIGRATIONS: real }))
    const upgraded = new (await import('./sqlite-store')).SqliteStore(path)
    opened.push(upgraded)
    expect(upgraded.getRun('r1')).toMatchObject({ id: 'r1', output: 'kept' })
    expect(upgraded.getRun('r1')).not.toHaveProperty('scheduleId')
    expect(upgraded.getWorkflow('w1')?.name).toBe('Workflow w1')
    upgraded.saveSchedule(schedule('sch-1', 'w1'))
    expect(upgraded.listSchedules()).toHaveLength(1)
    vi.doUnmock('./migrations')
  })
})
