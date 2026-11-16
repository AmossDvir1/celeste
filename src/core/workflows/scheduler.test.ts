import { describe, expect, it } from 'vitest'
import { nextRun, type ScheduleRow, type ScheduleSpec } from '@shared/schedule'
import type { RunSummary, WorkflowDefinition } from '@shared/workflow'
import type { WorkflowRow } from '../store'
import { MemoryStore } from '../testing/memory-store'
import { Scheduler, type ScheduleNotice } from './scheduler'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.parse('2026-11-16T09:00:00Z')

const definition: WorkflowDefinition = {
  nodes: [
    { id: 'start', type: 'start', name: 'Start', inputs: [] },
    { id: 'end', type: 'end', name: 'End' }
  ],
  edges: [{ from: 'start', to: 'end' }]
}

interface World {
  store: MemoryStore
  scheduler: Scheduler
  clock: { now: number }
  started: { workflowId: string; version?: number; startedBy: string; scheduleId?: string; inputs: Record<string, unknown>; folder: string; preApproved?: { scheduleId: string } }[]
  cancelled: { runId: string; reason?: string }[]
  notices: ScheduleNotice[]
  changes: () => number
  paused: { on: boolean }
  /** Makes the next start fail with this sentence, as `checkReady` does. */
  failToStart: (sentence: string | undefined) => void
  /** A run of a schedule, as the runner would have made it. */
  finish: (runId: string, status: RunSummary['status'], error?: string) => void
  /** Another scheduler on the same data, as after a restart. */
  restart: () => Scheduler
}

function world(over: { workflowVersion?: number; maxConcurrent?: number } = {}): World {
  const store = new MemoryStore()
  const clock = { now: T0 }
  const started: World['started'] = []
  const cancelled: World['cancelled'] = []
  const notices: ScheduleNotice[] = []
  const paused = { on: false }
  let changes = 0
  let failure: string | undefined
  let n = 0
  store.saveWorkflow({ id: 'w1', name: 'Backup', description: '', version: over.workflowVersion ?? 1, allowAssistant: false, definition, createdAt: 1, updatedAt: 1 })

  let scheduler!: Scheduler
  const runner = {
    start: async (req: World['started'][number]) => {
      if (failure) throw new Error(failure)
      started.push(req)
      const run: RunSummary = { id: `run-${++n}`, workflowId: req.workflowId, workflowName: 'Backup', version: req.version ?? 1, status: 'running', startedBy: 'schedule', inputs: {}, scheduleId: req.preApproved?.scheduleId as string, folder: req.folder, startedAt: clock.now }
      store.insertRun(run)
      scheduler.onRun(run)
      return run
    },
    recordFailedStart: (req: World['started'][number], error: string) => {
      const run: RunSummary = { id: `run-${++n}`, workflowId: req.workflowId, workflowName: 'Backup', version: req.version ?? 1, status: 'failed', startedBy: 'schedule', inputs: {}, scheduleId: req.preApproved?.scheduleId as string, folder: req.folder, startedAt: clock.now, finishedAt: clock.now, error }
      store.insertRun(run)
      // The runner's push comes back to the scheduler like any run's.
      scheduler.onRun(run)
      return run
    },
    cancel: async (runId: string, reason?: string) => {
      cancelled.push({ runId, ...(reason ? { reason } : {}) })
      const run = store.getRun(runId) as RunSummary
      store.patchRun(runId, { status: 'cancelled', ...(reason ? { error: reason } : {}), finishedAt: clock.now })
      scheduler.onRun({ ...run, status: 'cancelled', ...(reason ? { error: reason } : {}) })
    }
  }
  const make = () =>
    new Scheduler({
      store,
      runner: runner as never,
      now: () => clock.now,
      paused: () => paused.on,
      notify: (x) => notices.push(x),
      changed: () => void changes++,
      ...(over.maxConcurrent ? { maxConcurrent: over.maxConcurrent } : {})
    })
  scheduler = make()
  return {
    store,
    scheduler,
    clock,
    started,
    cancelled,
    notices,
    changes: () => changes,
    paused,
    failToStart: (s) => void (failure = s),
    finish: (runId, status, error) => {
      const run = store.getRun(runId) as RunSummary
      store.patchRun(runId, { status, ...(error ? { error } : {}), finishedAt: clock.now })
      scheduler.onRun({ ...run, status, ...(error ? { error } : {}), finishedAt: clock.now })
    },
    restart: () => {
      scheduler = make()
      return scheduler
    }
  }
}

const daily: ScheduleSpec = { kind: 'daily', time: '09:00' }
function schedule(w: World, over: Partial<ScheduleRow> = {}): ScheduleRow {
  const row: ScheduleRow = {
    id: over.id ?? 'sch-1',
    workflowId: 'w1',
    enabled: true,
    spec: daily,
    timezone: 'UTC',
    inputs: { env: 'staging' },
    folder: 'D:/work',
    approvedVersion: 1,
    approvedHash: 'h',
    approvedAt: T0 - 24 * HOUR,
    graceSec: 7200,
    waitLimitSec: 1800,
    notify: 'problems',
    nextRunAt: T0,
    lastFireAt: null,
    failStreak: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
  w.store.saveSchedule(row)
  return row
}

describe('a schedule firing', () => {
  it('starts a run with no card, for the approved version, in its folder with its answers, and not again', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 5_000
    await w.scheduler.tick()
    expect(w.started).toEqual([{ workflowId: 'w1', version: 1, startedBy: 'schedule', inputs: { env: 'staging' }, folder: 'D:/work', preApproved: { scheduleId: 'sch-1' } }])
    await w.scheduler.tick()
    w.clock.now = T0 + 20_000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
  })

  it('saves the next time, and when it fired, before the run starts, so a crash in between cannot fire it twice', async () => {
    const w = world()
    schedule(w)
    let seen: ScheduleRow | undefined
    w.clock.now = T0 + 1000
    // The run's start is the first thing that can fail; by then the schedule is already moved on.
    ;(w.scheduler as unknown as { deps: { runner: { start: (r: unknown) => Promise<unknown> } } }).deps.runner.start = async () => {
      seen = w.store.getSchedule('sch-1')
      throw new Error('crash')
    }
    await w.scheduler.tick()
    expect(seen).toMatchObject({ nextRunAt: Date.parse('2026-11-17T09:00:00Z'), lastFireAt: T0 + 1000 })
  })

  it('does nothing before the time, and nothing for a schedule that is off', async () => {
    const w = world()
    schedule(w)
    schedule(w, { id: 'off', enabled: false })
    w.clock.now = T0 - 1
    await w.scheduler.tick()
    w.clock.now = T0 + 1000
    w.store.saveSchedule({ ...(w.store.getSchedule('sch-1') as ScheduleRow), enabled: false })
    await w.scheduler.tick()
    expect(w.started).toEqual([])
  })

  it('moves on to the next day’s time, and does not run the same slot twice after a restart', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.store.getSchedule('sch-1')?.nextRunAt).toBe(Date.parse('2026-11-17T09:00:00Z'))
    const again = w.restart()
    await again.tick()
    w.clock.now = T0 + 2000
    await again.tick()
    expect(w.started).toHaveLength(1)
  })

  it('runs a late tick, counted from the slot, so an "every" schedule keeps its beat', async () => {
    const w = world()
    schedule(w, { spec: { kind: 'every', minutes: 15 }, nextRunAt: T0 })
    w.clock.now = T0 + 10 * MIN
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
    // The next slot is the quarter hour after the one that was due, not ten minutes after the late tick.
    expect(w.store.getSchedule('sch-1')?.nextRunAt).toBe(T0 + 15 * MIN)
  })

  it('runs a missed one once if it is late by no more than the grace period', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 90 * MIN
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
    expect(w.store.scheduleLog('sch-1', 5)).toEqual([])
  })

  it('does not run one that is later than that, says it was missed, and moves on', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 3 * HOUR
    await w.scheduler.tick()
    expect(w.started).toEqual([])
    const [log] = w.store.scheduleLog('sch-1', 5)
    expect(log).toMatchObject({ kind: 'missed' })
    expect(log?.text).toMatch(/late.*120 minutes|120 minutes it may be late/)
    expect(w.store.getSchedule('sch-1')?.nextRunAt).toBe(Date.parse('2026-11-17T09:00:00Z'))
  })

  it('never runs once for every slot it missed: a night asleep is at most one run', async () => {
    const w = world()
    schedule(w, { spec: { kind: 'every', minutes: 15 }, nextRunAt: T0, graceSec: 7200 })
    w.clock.now = T0 + 8 * HOUR
    await w.scheduler.tick()
    expect(w.started).toHaveLength(0)
    expect(w.store.getSchedule('sch-1')?.nextRunAt).toBe(T0 + 8 * HOUR + 15 * MIN)
    w.clock.now = T0 + 8 * HOUR + 15 * MIN + 1000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
  })

  it('skips a time when the last run is still going, and says so', async () => {
    const w = world()
    schedule(w, { spec: { kind: 'every', minutes: 15 }, nextRunAt: T0 })
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
    w.clock.now = T0 + 15 * MIN + 1000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
    expect(w.store.scheduleLog('sch-1', 5)[0]).toMatchObject({ kind: 'skipped', text: 'Skipped: the last run was still going.' })
    // When it has ended, the next time runs.
    w.finish('run-1', 'completed')
    w.clock.now = T0 + 30 * MIN + 1000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(2)
  })

  it('runs a "once" schedule, then it is finished and off', async () => {
    const w = world()
    schedule(w, { spec: { kind: 'once', at: T0 }, nextRunAt: T0 })
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
    expect(w.store.getSchedule('sch-1')).toMatchObject({ enabled: false, nextRunAt: null })
    w.clock.now = T0 + 24 * HOUR
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
  })

  it('starts nothing while every schedule is paused, and starts what is still within its grace when they are resumed', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 1000
    w.paused.on = true
    await w.scheduler.tick()
    expect(w.started).toEqual([])
    expect(w.store.getSchedule('sch-1')?.nextRunAt).toBe(T0)
    w.clock.now = T0 + 20 * MIN
    w.paused.on = false
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
  })

  it('does not look twice at once: a slow start is not started again by the next tick', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 1000
    let release: () => void = () => undefined
    ;(w.scheduler as unknown as { deps: { runner: { start: (r: unknown) => Promise<unknown> } } }).deps.runner.start = () =>
      new Promise((resolve) => {
        w.started.push({} as never)
        release = () => resolve({})
      })
    const first = w.scheduler.tick()
    await w.scheduler.tick()
    release()
    await first
    expect(w.started).toHaveLength(1)
  })

  it('looks every half minute once started, and when told the computer woke up', async () => {
    const w = world()
    schedule(w)
    let beat: (() => void) | undefined
    let stopped = false
    const s = new Scheduler({
      store: w.store,
      runner: { start: async (r: never) => (w.started.push(r), { id: 'x' } as never), recordFailedStart: (() => undefined) as never, cancel: (async () => undefined) as never },
      now: () => w.clock.now,
      every: (fn, ms) => {
        expect(ms).toBe(30_000)
        beat = fn
        return () => void (stopped = true)
      }
    })
    w.clock.now = T0 + 1000
    s.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(w.started).toHaveLength(1)
    s.start()
    expect(beat).toBeDefined()
    s.stop()
    expect(stopped).toBe(true)
  })
})

describe('a schedule whose workflow changed, or is gone', () => {
  it('is paused, with a note and a notice, when its time comes and the version is no longer the one approved', async () => {
    const w = world({ workflowVersion: 2 })
    schedule(w)
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.started).toEqual([])
    expect(w.store.getSchedule('sch-1')).toMatchObject({ enabled: false, pausedReason: 'edited' })
    expect(w.store.scheduleLog('sch-1', 5)[0]).toMatchObject({ kind: 'paused' })
    expect(w.notices).toEqual([expect.objectContaining({ kind: 'schedule-paused', scheduleId: 'sch-1', workflowName: 'Backup', text: expect.stringContaining('Daily at 09:00') })])
  })

  it('is paused at the edit, not at its next time', () => {
    const w = world()
    schedule(w)
    schedule(w, { id: 'other', approvedVersion: 2 })
    w.store.saveWorkflow({ ...(w.store.getWorkflow('w1') as WorkflowRow), version: 2 })
    w.scheduler.onWorkflowSaved('w1')
    expect(w.store.getSchedule('sch-1')).toMatchObject({ enabled: false, pausedReason: 'edited' })
    // One that was approved for the new version is left alone.
    expect(w.store.getSchedule('other')).toMatchObject({ enabled: true })
    expect(w.notices).toHaveLength(1)
  })

  it('goes with a workflow that is deleted, so there is nothing to run', async () => {
    const w = world()
    schedule(w)
    w.store.deleteWorkflow('w1')
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.started).toEqual([])
    expect(w.store.listSchedules()).toEqual([])
  })
})

describe('a run that cannot start, and runs that fail', () => {
  it('is kept as a failed run with the sentence, counted as a failure, and told about', async () => {
    const w = world()
    schedule(w)
    w.failToStart('“Phone” uses the phone, but the phone is not connected.')
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.started).toEqual([])
    const run = w.store.listScheduleRuns('sch-1', 5)[0]
    expect(run).toMatchObject({ status: 'failed', error: '“Phone” uses the phone, but the phone is not connected.' })
    expect(w.store.getSchedule('sch-1')?.failStreak).toBe(1)
    expect(w.store.scheduleLog('sch-1', 5)[0]).toMatchObject({ kind: 'failed-to-start' })
    expect(w.notices).toEqual([expect.objectContaining({ kind: 'run-failed', runId: run?.id, text: expect.stringContaining('not connected') })])
  })

  it('pauses itself after three failures in a row, and says so', async () => {
    const w = world()
    schedule(w, { spec: { kind: 'every', minutes: 15 }, nextRunAt: T0 })
    for (let i = 1; i <= 3; i++) {
      w.clock.now = T0 + (i - 1) * 15 * MIN + 1000
      await w.scheduler.tick()
      w.finish(`run-${i}`, 'failed', 'exit code 1')
    }
    expect(w.started).toHaveLength(3)
    expect(w.store.getSchedule('sch-1')).toMatchObject({ enabled: false, pausedReason: 'failures', failStreak: 3 })
    expect(w.notices.filter((x) => x.kind === 'schedule-paused')).toHaveLength(1)
    expect(w.notices.filter((x) => x.kind === 'run-failed')).toHaveLength(3)
    w.clock.now = T0 + 5 * 15 * MIN
    await w.scheduler.tick()
    expect(w.started).toHaveLength(3)
  })

  it('starts counting again after a run that works', async () => {
    const w = world()
    schedule(w, { spec: { kind: 'every', minutes: 15 }, nextRunAt: T0 })
    const outcomes: RunSummary['status'][] = ['failed', 'failed', 'completed', 'failed', 'failed']
    for (const [i, status] of outcomes.entries()) {
      w.clock.now = T0 + i * 15 * MIN + 1000
      await w.scheduler.tick()
      w.finish(`run-${i + 1}`, status, status === 'failed' ? 'bad' : undefined)
    }
    expect(w.store.getSchedule('sch-1')).toMatchObject({ enabled: true, failStreak: 2 })
  })

  it('does not count a run the person cancelled, and tells nobody about it', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    w.finish('run-1', 'cancelled')
    expect(w.store.getSchedule('sch-1')?.failStreak).toBe(0)
    expect(w.notices).toEqual([])
  })

  it('tells about every run that ends well only when asked to, and never when told never', async () => {
    const always = world()
    schedule(always, { notify: 'always' })
    always.clock.now = T0 + 1000
    await always.scheduler.tick()
    always.finish('run-1', 'completed')
    expect(always.notices).toEqual([expect.objectContaining({ kind: 'run-finished', runId: 'run-1' })])

    const problems = world()
    schedule(problems)
    problems.clock.now = T0 + 1000
    await problems.scheduler.tick()
    problems.finish('run-1', 'completed')
    expect(problems.notices).toEqual([])

    const never = world()
    schedule(never, { notify: 'never' })
    never.failToStart('no')
    never.clock.now = T0 + 1000
    await never.scheduler.tick()
    expect(never.notices).toEqual([])
    expect(never.store.getSchedule('sch-1')?.failStreak).toBe(1)
  })
})

describe('a run that waits for a person', () => {
  it('is cancelled with a reason when nobody answers within the schedule’s limit, which counts as a failure', async () => {
    const w = world()
    schedule(w, { waitLimitSec: 1800 })
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    const run = w.store.getRun('run-1') as RunSummary
    w.store.patchRun('run-1', { status: 'waiting' })
    w.scheduler.onRun({ ...run, status: 'waiting' })
    w.clock.now += 29 * MIN
    await w.scheduler.tick()
    expect(w.cancelled).toEqual([])
    w.clock.now += 2 * MIN
    await w.scheduler.tick()
    expect(w.cancelled).toEqual([{ runId: 'run-1', reason: 'Nobody answered in 30 minutes.' }])
    expect(w.store.getSchedule('sch-1')?.failStreak).toBe(1)
    expect(w.notices[0]).toMatchObject({ kind: 'run-failed', text: 'Nobody answered in 30 minutes.' })
  })

  it('is left alone when it is answered in time and goes on', async () => {
    const w = world()
    schedule(w)
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    const run = w.store.getRun('run-1') as RunSummary
    w.scheduler.onRun({ ...run, status: 'waiting' })
    w.scheduler.onRun({ ...run, status: 'running' })
    w.clock.now += 3 * HOUR
    await w.scheduler.tick()
    expect(w.cancelled).toEqual([])
  })
})

describe('how many run at once', () => {
  it('lets three scheduled runs go and keeps the next one due until there is room', async () => {
    const w = world({ maxConcurrent: 3 })
    for (const id of ['a', 'b', 'c', 'd']) schedule(w, { id, nextRunAt: T0 })
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(3)
    expect(w.store.getSchedule('d')?.nextRunAt).toBe(T0)
    w.clock.now += 30_000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(3)
    w.finish('run-1', 'completed')
    w.clock.now += 30_000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(4)
    expect(w.started[3]?.preApproved?.scheduleId).toBe('d')
  })

  it('counts only runs a schedule started', async () => {
    const w = world()
    for (let i = 0; i < 5; i++) w.store.insertRun({ id: `manual-${i}`, workflowId: 'w1', workflowName: 'Backup', version: 1, status: 'running', startedBy: 'you', inputs: {}, folder: 'x', startedAt: T0 })
    schedule(w)
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.started).toHaveLength(1)
  })
})

describe('nextRun and the scheduler agree', () => {
  it('moves a weekly schedule to the next chosen day', async () => {
    const w = world()
    const spec: ScheduleSpec = { kind: 'weekly', time: '09:00', days: [1, 3] }
    schedule(w, { spec, nextRunAt: T0 })
    w.clock.now = T0 + 1000
    await w.scheduler.tick()
    expect(w.store.getSchedule('sch-1')?.nextRunAt).toBe(nextRun(spec, T0 + 1000, 'UTC'))
    expect(new Date(w.store.getSchedule('sch-1')?.nextRunAt as number).toISOString()).toBe('2026-11-18T09:00:00.000Z')
  })
})
