import { MAX_FAIL_STREAK, describeSpec, nextRun, type ScheduleRow } from '@shared/schedule'
import type { RunSummary } from '@shared/workflow'
import type { Store } from '../store'
import type { WorkflowRunner } from './runner'

/*
 * Starts the workflows people scheduled (docs/plans/SCHEDULING_PLAN.md, 4.3 and 9.4). It checks the wall clock every 30 seconds against
 * each schedule's stored next time, which stays right after the computer sleeps, where one exact timer would not. The clock and the timer
 * are injected, so the tests wait for nothing.
 *
 * A schedule is a saved approval: it starts runs with no card, but only the version the person approved. The next time is saved before a
 * run starts, so a crash cannot fire it twice. A run that is late by more than the grace period is not run (and never once for every
 * slot that was missed), one that overlaps the last is skipped, and three failures in a row switch the schedule off.
 */

const TICK_MS = 30_000
/** How many scheduled runs may go at once. */
const MAX_CONCURRENT = 3

/** Something to tell the person (the computer's notification, and the phone's). */
export interface ScheduleNotice {
  kind: 'run-failed' | 'run-finished' | 'schedule-paused'
  scheduleId: string
  runId?: string
  workflowName: string
  title: string
  text: string
}

export interface SchedulerDeps {
  store: Store
  runner: Pick<WorkflowRunner, 'start' | 'cancel' | 'recordFailedStart'>
  now?: () => number
  tickMs?: number
  /** Whether the person paused every schedule (the tray's menu). Nothing new starts while it is. */
  paused?: () => boolean
  notify?: (notice: ScheduleNotice) => void
  /** A schedule changed: the window looks again. */
  changed?: () => void
  /** Runs `fn` every `ms` and returns how to stop it. Tests give their own. */
  every?: (fn: () => void, ms: number) => () => void
  maxConcurrent?: number
}

const sentence = (err: unknown) => (err instanceof Error ? err.message : String(err))
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))

const defaultEvery = (fn: () => void, ms: number): (() => void) => {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

export class Scheduler {
  private stopTimer: (() => void) | undefined
  /** When each scheduled run began to wait for a person, so one that nobody answers is cancelled. */
  private readonly waitingSince = new Map<string, number>()
  private ticking = false

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Looks now and then every half minute. */
  start(): void {
    if (this.stopTimer) return
    this.stopTimer = (this.deps.every ?? defaultEvery)(() => void this.tick(), this.deps.tickMs ?? TICK_MS)
    void this.tick()
  }

  stop(): void {
    this.stopTimer?.()
    this.stopTimer = undefined
  }

  /** Starts what is due. Also called when the computer wakes up. */
  async tick(): Promise<void> {
    // A slow start must not be started again by the next tick.
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      await this.stopWaiting(now)
      if (this.deps.paused?.()) return
      for (const due of this.deps.store.dueSchedules(now)) await this.fire(due, now)
    } catch (err) {
      console.error('[core] the scheduler could not look at the schedules', err)
    } finally {
      this.ticking = false
    }
  }

  private running(): RunSummary[] {
    return this.deps.store.listRuns(undefined, 300).filter((r) => r.startedBy === 'schedule' && (r.status === 'running' || r.status === 'waiting'))
  }

  private save(row: ScheduleRow, patch: Partial<ScheduleRow>): ScheduleRow {
    const next = { ...row, ...patch, updatedAt: this.now() }
    this.deps.store.saveSchedule(next)
    return next
  }

  private log(s: ScheduleRow, kind: Parameters<Store['appendScheduleLog']>[2], text: string): void {
    this.deps.store.appendScheduleLog(s.id, this.now(), kind, text)
  }

  private async fire(s: ScheduleRow, now: number): Promise<void> {
    const { store, runner } = this.deps
    const wf = store.getWorkflow(s.workflowId)
    // Gone with its workflow (the delete cascades), so there is nothing to run.
    if (!wf) return
    if (wf.version !== s.approvedVersion) {
      this.pause(s, 'edited', `Paused because “${wf.name}” changed. Approve it again to carry on.`)
      return
    }
    // Full: it stays due, and the next tick tries again.
    if (this.running().length >= (this.deps.maxConcurrent ?? MAX_CONCURRENT)) return

    const slot = s.nextRunAt ?? now
    const late = now - slot
    // Saved before anything starts, so a crash in between cannot fire it twice. An 'every' schedule counts from its slot, not from now.
    const next = nextRun(s.spec, now, s.timezone, slot)
    const fired = this.save(s, { nextRunAt: next, lastFireAt: now, ...(next === null ? { enabled: false } : {}) })
    this.deps.changed?.()

    if (late > s.graceSec * 1000) {
      this.log(fired, 'missed', `Missed: it was due ${minutes(late)} minutes ago, longer than the ${minutes(s.graceSec * 1000)} minutes it may be late, so it did not run.`)
      return
    }
    if (store.listScheduleRuns(s.id, 5).some((r) => r.status === 'running' || r.status === 'waiting')) {
      this.log(fired, 'skipped', 'Skipped: the last run was still going.')
      return
    }

    const request = { workflowId: s.workflowId, inputs: s.inputs, startedBy: 'schedule' as const, folder: s.folder, version: s.approvedVersion, preApproved: { scheduleId: s.id } }
    try {
      await runner.start(request)
    } catch (err) {
      // Could not start (the phone is not connected, a tool server is off): a failed run with the sentence, so it shows in the history.
      // Its push comes back through `onRun` like any run's, which counts the failure and tells the person.
      const run = runner.recordFailedStart(request, sentence(err))
      this.log(fired, 'failed-to-start', run.error ?? 'It could not start.')
    }
  }

  private pause(s: ScheduleRow, reason: 'edited' | 'failures', text: string): ScheduleRow {
    const paused = this.save(s, { enabled: false, pausedReason: reason })
    this.log(paused, 'paused', text)
    this.deps.changed?.()
    const name = this.deps.store.getWorkflow(s.workflowId)?.name ?? 'A workflow'
    this.deps.notify?.({ kind: 'schedule-paused', scheduleId: s.id, workflowName: name, title: name, text: `${describeSpec(s.spec, s.timezone)}: ${text}` })
    return paused
  }

  /** The workflow was saved: a schedule whose approved version is no longer the newest is paused at once, not at its next time. */
  onWorkflowSaved(workflowId: string): void {
    const wf = this.deps.store.getWorkflow(workflowId)
    if (!wf) return
    for (const s of this.deps.store.listSchedules(workflowId)) {
      if (s.enabled && s.approvedVersion !== wf.version) this.pause(s, 'edited', `Paused because “${wf.name}” changed. Approve it again to carry on.`)
    }
  }

  /** What Core hears about every run: tracks the ones that wait for a person, and counts how a schedule's runs end. */
  onRun(run: RunSummary): void {
    if (!run.scheduleId) return
    if (run.status === 'waiting') {
      if (!this.waitingSince.has(run.id)) this.waitingSince.set(run.id, this.now())
      return
    }
    this.waitingSince.delete(run.id)
    if (run.status === 'running') return
    this.finished(run)
  }

  private finished(run: RunSummary): void {
    const s = run.scheduleId ? this.deps.store.getSchedule(run.scheduleId) : undefined
    if (!s) return
    // Cancelled by Celeste (nobody answered) has a reason and counts as a failure; cancelled by the person does not count at all.
    const failed = run.status === 'failed' || (run.status === 'cancelled' && !!run.error)
    const streak = run.status === 'completed' ? 0 : failed ? s.failStreak + 1 : s.failStreak
    let row = streak === s.failStreak ? s : this.save(s, { failStreak: streak })
    if (row !== s) this.deps.changed?.()
    const name = run.workflowName
    if (failed && this.deps.notify && s.notify !== 'never') {
      this.deps.notify({ kind: 'run-failed', scheduleId: s.id, runId: run.id, workflowName: name, title: `${name} failed`, text: run.error ?? 'It did not finish.' })
    } else if (run.status === 'completed' && s.notify === 'always') {
      this.deps.notify?.({ kind: 'run-finished', scheduleId: s.id, runId: run.id, workflowName: name, title: `${name} finished`, text: run.output?.trim().slice(0, 200) || 'It finished.' })
    }
    if (failed && streak >= MAX_FAIL_STREAK && row.enabled) {
      row = this.pause(row, 'failures', `Failed ${MAX_FAIL_STREAK} times in a row, so it was paused.`)
    }
  }

  /** Cancels the scheduled runs that have waited for a person longer than their schedule allows. */
  private async stopWaiting(now: number): Promise<void> {
    for (const [runId, since] of [...this.waitingSince]) {
      const run = this.deps.store.getRun(runId)
      const s = run?.scheduleId ? this.deps.store.getSchedule(run.scheduleId) : undefined
      if (!run || run.status !== 'waiting' || !s) {
        this.waitingSince.delete(runId)
        continue
      }
      if (now - since < s.waitLimitSec * 1000) continue
      this.waitingSince.delete(runId)
      await this.deps.runner.cancel(runId, `Nobody answered in ${minutes(s.waitLimitSec * 1000)} minutes.`)
    }
  }
}
