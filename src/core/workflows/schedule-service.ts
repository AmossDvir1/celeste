import { createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ScheduleApi } from '@shared/api'
import {
  DEFAULT_GRACE_SEC,
  DEFAULT_WAIT_LIMIT_SEC,
  describeSpec,
  nextRun,
  nextRuns,
  validateSpec,
  type NotifyWhen,
  type ScheduleRow,
  type ScheduleSpec,
  type ScheduleSummary
} from '@shared/schedule'
import { checkInputs } from '@shared/workflow'
import type { Store } from '../store'
import type { WorkflowRunner } from './runner'

/*
 * The schedules a person makes and changes (docs/plans/SCHEDULING_PLAN.md, 9.5). Saving one is the approval: it is refused unless the card
 * was shown, and what was approved (the workflow's version, the answers and the folder) is kept as a hash. A change to any of them pauses
 * the schedule, so editing a workflow can never make an old approval cover new steps. Starting runs is the scheduler's.
 */

const NOTIFY: NotifyWhen[] = ['problems', 'always', 'never']
const MIN_LIMIT_SEC = 60
const MAX_LIMIT_SEC = 86_400
/** How many next times the dialog shows. */
const PREVIEW_COUNT = 5

const asText = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${what}`)
  return v
}

/** What the person approved, as one hash: the version, the answers (in a fixed order) and the folder. */
export function approvalHash(version: number, inputs: Record<string, string | number | boolean>, folder: string): string {
  const sorted = Object.keys(inputs).sort().map((k) => [k, inputs[k]])
  return createHash('sha256').update(JSON.stringify([version, sorted, folder])).digest('hex')
}

/** The time zone this computer is in, by its name. */
export const computerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function validZone(zone: unknown): string {
  const name = typeof zone === 'string' && zone ? zone : computerTimeZone()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
  } catch {
    throw new Error('That time zone is not known.')
  }
  return name
}

export class ScheduleService {
  constructor(
    private readonly store: Store,
    private readonly runner: Pick<WorkflowRunner, 'preview'>,
    private readonly opts: {
      now?: () => number
      /** Something about the schedules changed: the window looks again. */
      changed?: () => void
      /** Where Celeste keeps its data: a schedule given no folder works in the workflow's private one under it. */
      dataDir?: string
      /** Whether the person paused every schedule. */
      paused?: () => boolean
    } = {}
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private require(id: unknown): ScheduleRow {
    const s = typeof id === 'string' ? this.store.getSchedule(id) : undefined
    if (!s) throw new Error('That schedule no longer exists.')
    return s
  }

  private summary(s: ScheduleRow): ScheduleSummary {
    const { approvedHash: _hash, ...rest } = s
    const wf = this.store.getWorkflow(s.workflowId)
    const lastRun = this.store.listScheduleRuns(s.id, 1)[0]
    const lastLog = this.store.scheduleLog(s.id, 1)[0]
    return {
      ...rest,
      // Every schedule shows "Paused: all" while the person has paused them all and has not paused this one.
      ...(s.enabled && this.opts.paused?.() ? { pausedReason: 'all' as const } : {}),
      workflowName: wf?.name ?? 'Workflow',
      describe: describeSpec(s.spec, s.timezone),
      ...(lastLog ? { lastLog: { at: lastLog.at, kind: lastLog.kind, text: lastLog.text } } : {}),
      ...(lastRun ? { lastRun: { id: lastRun.id, status: lastRun.status, at: lastRun.finishedAt ?? lastRun.startedAt } } : {})
    }
  }

  readonly api: ScheduleApi = {
    'schedules.list': (workflowId) => this.store.listSchedules(typeof workflowId === 'string' ? workflowId : undefined).map((s) => this.summary(s)),

    'schedules.preview': async (input) => {
      const workflowId = asText(input?.workflowId, 'workflow', 100)
      const zone = validZone(input?.timezone)
      const preview = await this.runner.preview(workflowId, input?.inputs ?? {})
      const problems = [...preview.problems]
      for (const name of preview.computerSteps) problems.push(`“${name}” uses the computer, which needs you there, so this workflow cannot be scheduled. Use Run now instead.`)
      problems.push(...validateSpec(input?.spec, preview.agentSteps > 0))
      const spec = input?.spec as ScheduleSpec
      const next = validateSpec(spec, preview.agentSteps > 0).length === 0 ? nextRuns(spec, this.now(), zone, PREVIEW_COUNT, spec.kind === 'every' ? this.now() : undefined) : []
      return { actions: preview.actions, next, problems, agentSteps: preview.agentSteps, computerSteps: preview.computerSteps }
    },

    'schedules.save': async (input) => {
      if (input?.approved !== true) throw new Error('Show what it will do, and ask, before a schedule is made.')
      const workflowId = asText(input.workflowId, 'workflow', 100)
      const wf = this.store.getWorkflow(workflowId)
      if (!wf) throw new Error('That workflow no longer exists.')
      const existing = input.id !== undefined ? this.require(input.id) : undefined
      if (existing && existing.workflowId !== workflowId) throw new Error('A schedule cannot move to another workflow.')
      const zone = validZone(input.timezone ?? existing?.timezone)

      const preview = await this.runner.preview(workflowId, input.inputs ?? {})
      if (preview.computerSteps.length) throw new Error(`“${preview.computerSteps[0]}” uses the computer, which needs you there, so this workflow cannot be scheduled. Use Run now instead.`)
      if (preview.problems.length) throw new Error(preview.problems[0])
      const problems = validateSpec(input.spec, preview.agentSteps > 0)
      if (problems.length) throw new Error(problems[0])
      const spec = input.spec

      const limit = (v: unknown, fallback: number, what: string): number => {
        if (v === undefined) return fallback
        if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_LIMIT_SEC || v > MAX_LIMIT_SEC) throw new Error(`${what} must be from 1 minute to 24 hours.`)
        return v
      }
      if (input.notify !== undefined && !NOTIFY.includes(input.notify)) throw new Error('Invalid notify')
      const notify: NotifyWhen = input.notify ?? existing?.notify ?? 'problems'

      // The answers as the workflow's Start step understands them (types and defaults), which is what runs.
      const checked = this.checkedInputs(workflowId, input.inputs ?? {})
      let folder = typeof input.folder === 'string' ? input.folder.trim() : (existing?.folder ?? '')
      if (folder.length > 500) throw new Error('Invalid folder')
      if (!folder && this.opts.dataDir) {
        folder = join(this.opts.dataDir, 'workflows', wf.id)
        mkdirSync(folder, { recursive: true })
      }
      let isDir = false
      try {
        isDir = statSync(folder).isDirectory()
      } catch {
        /* said below */
      }
      if (!isDir) throw new Error('Choose a folder for the runs to work in.')

      const now = this.now()
      const next = nextRun(spec, now, zone, spec.kind === 'every' ? now : undefined)
      if (next === null) throw new Error('That time has already passed.')
      const row: ScheduleRow = {
        id: existing?.id ?? `sch-${crypto.randomUUID()}`,
        workflowId,
        enabled: true,
        spec,
        timezone: zone,
        inputs: checked,
        folder,
        approvedVersion: wf.version,
        approvedHash: approvalHash(wf.version, checked, folder),
        approvedAt: now,
        graceSec: limit(input.graceSec, existing?.graceSec ?? DEFAULT_GRACE_SEC, 'How late it may run'),
        waitLimitSec: limit(input.waitLimitSec, existing?.waitLimitSec ?? DEFAULT_WAIT_LIMIT_SEC, 'How long it waits for you'),
        notify,
        nextRunAt: next,
        lastFireAt: existing?.lastFireAt ?? null,
        failStreak: 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      this.store.saveSchedule(row)
      if (existing?.pausedReason) this.store.appendScheduleLog(row.id, now, 'resumed', 'Approved again and switched on.')
      this.opts.changed?.()
      return this.summary(row)
    },

    'schedules.setEnabled': (id, on) => {
      const s = this.require(id)
      if (on !== true) {
        const off = { ...s, enabled: false, updatedAt: this.now() }
        this.store.saveSchedule(off)
        this.opts.changed?.()
        return this.summary(off)
      }
      const wf = this.store.getWorkflow(s.workflowId)
      // What was approved no longer matches: switching it on would run something the person has not seen.
      if (!wf || wf.version !== s.approvedVersion || s.pausedReason === 'edited') throw new Error('The workflow changed since you approved this. Open the schedule and approve it again.')
      const now = this.now()
      const next = nextRun(s.spec, now, s.timezone, s.spec.kind === 'every' ? now : undefined)
      if (next === null) throw new Error('That time has already passed. Open the schedule and choose another.')
      const { pausedReason: _reason, ...rest } = s
      const on1: ScheduleRow = { ...rest, enabled: true, failStreak: 0, nextRunAt: next, updatedAt: now }
      this.store.saveSchedule(on1)
      if (s.pausedReason) this.store.appendScheduleLog(s.id, now, 'resumed', 'Switched on again.')
      this.opts.changed?.()
      return this.summary(on1)
    },

    'schedules.remove': (id) => {
      this.require(id)
      this.store.deleteSchedule(id as string)
      this.opts.changed?.()
    },

    'schedules.log': (id) => this.store.scheduleLog(this.require(id).id, 200)
  }

  /** The answers checked and typed as the workflow's Start step wants them. Throws a sentence. */
  private checkedInputs(workflowId: string, given: Record<string, unknown>): ScheduleRow['inputs'] {
    const wf = this.store.getWorkflow(workflowId)
    const start = wf?.definition.nodes.find((n) => n.type === 'start')
    return checkInputs(start && start.type === 'start' ? start.inputs : [], given)
  }
}
