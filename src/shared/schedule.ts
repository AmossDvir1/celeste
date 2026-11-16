import type { PlannedAction } from './workflow'

/*
 * Scheduled workflows (docs/plans/SCHEDULING_PLAN.md). Pure: the types of a schedule and the arithmetic of when it runs next, with no
 * library. Times are worked out in the time zone stored with the schedule, with Intl, so a daylight-saving change or a journey cannot
 * silently move a "9:00".
 */

export type ScheduleSpec =
  /** Epoch milliseconds. */
  | { kind: 'once'; at: number }
  /** Integer minutes, at least 5 (30 when the workflow has an assistant step), at most 10080 (a week). */
  | { kind: 'every'; minutes: number }
  /** `time` is 'HH:MM', 24 hour. */
  | { kind: 'daily'; time: string; weekdaysOnly?: boolean }
  /** `days` are 0 (Sunday) to 6, not empty, no repeats. */
  | { kind: 'weekly'; time: string; days: number[] }
  /** 1 to 31. A day a short month does not have is that month's last day. */
  | { kind: 'monthly'; time: string; day: number }

/** When to tell the person about a scheduled run. */
export type NotifyWhen = 'problems' | 'always' | 'never'
/** Why a schedule is switched on but not running. */
export type PausedReason = 'edited' | 'failures' | 'all'

export const MIN_EVERY_MINUTES = 5
/** A schedule spends the person's quota with nobody watching, so one that has an assistant step may not run more often than this. */
export const MIN_EVERY_MINUTES_AGENT = 30
export const MAX_EVERY_MINUTES = 10_080
/** A late run is still run when it is late by no more than this, unless the schedule says otherwise. */
export const DEFAULT_GRACE_SEC = 7200
/** A run that waits for a person longer than this is cancelled, unless the schedule says otherwise. */
export const DEFAULT_WAIT_LIMIT_SEC = 1800
/** Failed runs in a row after which a schedule switches itself off. A constant, not a setting. */
export const MAX_FAIL_STREAK = 3

/** A schedule as stored. */
export interface ScheduleRow {
  /** 'sch-' plus a uuid. */
  id: string
  workflowId: string
  enabled: boolean
  spec: ScheduleSpec
  /** The IANA name of the computer's time zone when it was made. */
  timezone: string
  inputs: Record<string, string | number | boolean>
  folder: string
  /** What the person approved: the workflow's version, and a hash of the version, the inputs and the folder. Any change pauses the schedule. */
  approvedVersion: number
  approvedHash: string
  approvedAt: number
  graceSec: number
  waitLimitSec: number
  notify: NotifyWhen
  /** Null: nothing more to run (a 'once' that has run). */
  nextRunAt: number | null
  lastFireAt: number | null
  failStreak: number
  pausedReason?: PausedReason
  createdAt: number
  updatedAt: number
}

/** What the dialog's card is drawn from: what a run would do, when the next ones are, and what is wrong. */
export interface SchedulePreview {
  /** Everything a run will do, with the answers filled in. */
  actions: PlannedAction[]
  /** The next five times, in milliseconds. */
  next: number[]
  /** Sentences about what stops it being scheduled: a missing answer, a step that uses the computer, a time that is not valid. */
  problems: string[]
  agentSteps: number
  computerSteps: string[]
}

/** What the window sends to make or change a schedule. `approved` must be true: the card was shown and the person pressed the button. */
export interface ScheduleSaveInput {
  /** Present to change a schedule; it must approve again. */
  id?: string
  workflowId: string
  spec: ScheduleSpec
  inputs: Record<string, unknown>
  /** Left out: the workflow's private folder. */
  folder?: string
  timezone?: string
  graceSec?: number
  waitLimitSec?: number
  notify?: NotifyWhen
  approved: boolean
}

/** What the window and the phone are shown: the row without the hash, with its words and the last thing worth saying about it. */
export interface ScheduleSummary extends Omit<ScheduleRow, 'approvedHash'> {
  workflowName: string
  /** "Daily at 09:00". */
  describe: string
  /** The newest line of the schedule's log (missed, skipped, paused). */
  lastLog?: { at: number; kind: ScheduleLogKind; text: string }
  /** The newest run this schedule started. */
  lastRun?: { id: string; status: string; at: number }
}

export type ScheduleLogKind = 'missed' | 'skipped' | 'paused' | 'resumed' | 'failed-to-start'

export interface ScheduleLogEntry {
  id: number
  at: number
  kind: ScheduleLogKind
  text: string
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Sentences about what is wrong with a spec; empty when it is valid. */
export function validateSpec(spec: unknown, hasAgentStep: boolean): string[] {
  if (!isObject(spec)) return ['Say when it should run.']
  const problems: string[] = []
  const time = () => {
    if (typeof spec.time !== 'string' || !TIME.test(spec.time)) problems.push('The time must be like 09:00, on a 24 hour clock.')
  }
  switch (spec.kind) {
    case 'once':
      if (typeof spec.at !== 'number' || !Number.isFinite(spec.at)) problems.push('Choose a date and a time.')
      break
    case 'every': {
      const m = spec.minutes
      if (typeof m !== 'number' || !Number.isInteger(m)) {
        problems.push('Say how many minutes, as a whole number.')
        break
      }
      if (m < MIN_EVERY_MINUTES) problems.push(`It cannot run more often than every ${MIN_EVERY_MINUTES} minutes.`)
      else if (hasAgentStep && m < MIN_EVERY_MINUTES_AGENT) problems.push(`A workflow with an assistant step cannot run more often than every ${MIN_EVERY_MINUTES_AGENT} minutes, because each run spends your assistant allowance with nobody watching.`)
      if (m > MAX_EVERY_MINUTES) problems.push('It cannot be less often than every week this way. Choose weekly or monthly.')
      break
    }
    case 'daily':
      time()
      if (spec.weekdaysOnly !== undefined && typeof spec.weekdaysOnly !== 'boolean') problems.push('Weekdays only is yes or no.')
      break
    case 'weekly': {
      time()
      const days = spec.days
      if (!Array.isArray(days) || days.length === 0) problems.push('Choose at least one day of the week.')
      else if (days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) || new Set(days).size !== days.length) problems.push('The days must be different days of the week.')
      break
    }
    case 'monthly':
      time()
      if (typeof spec.day !== 'number' || !Number.isInteger(spec.day) || spec.day < 1 || spec.day > 31) problems.push('The day of the month must be from 1 to 31.')
      break
    default:
      problems.push('Choose how often it should run.')
  }
  return problems
}

// --- time zones ------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    formatters.set(timezone, f)
  }
  return f
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

interface Wall {
  y: number
  m: number
  d: number
  h: number
  mi: number
  dow: number
}

/** The date and time on a wall clock in `timezone` at an instant. */
function wallAt(t: number, timezone: string): Wall {
  const p: Record<string, string> = {}
  for (const part of formatter(timezone).formatToParts(new Date(t))) p[part.type] = part.value
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), dow: WEEKDAYS[p.weekday as string] ?? 0 }
}

/** How far the zone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(t: number, timezone: string): number {
  const w = wallAt(t, timezone)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000
}

const sameWall = (a: Wall, y: number, m: number, d: number, h: number, mi: number) => a.y === y && a.m === m && a.d === d && a.h === h && a.mi === mi

/**
 * The instant at which a wall clock in `timezone` shows this date and time. A time that does not exist (the clock skips an hour) is the
 * first minute after the gap. A time that happens twice is the first of them.
 */
export function instantOf(y: number, m: number, d: number, h: number, mi: number, timezone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  const before = offsetAt(guess - 36 * 3_600_000, timezone)
  const after = offsetAt(guess + 36 * 3_600_000, timezone)
  const candidates = [...new Set([guess - before, guess - after])].filter((t) => sameWall(wallAt(t, timezone), y, m, d, h, mi))
  if (candidates.length) return Math.min(...candidates)
  // In a gap: the first minute whose offset is the new one.
  let lo = guess - before - 36 * 3_600_000
  let hi = guess - after + 36 * 3_600_000
  // Invariant: the offset at `lo` is not `after`'s (or the gap is later), and at `hi` it is.
  lo = Math.floor(lo / 60_000) * 60_000
  hi = Math.floor(hi / 60_000) * 60_000
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000
    if (offsetAt(mid, timezone) === after) hi = mid
    else lo = mid
  }
  return hi
}

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()
const parseTime = (s: string): [number, number] => [Number(s.slice(0, 2)), Number(s.slice(3, 5))]

/** The calendar date `n` days after a date (no time zone in it: only the calendar). */
function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number; dow: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() }
}

/**
 * The first time after `after` that the schedule runs, or null when there is none (a 'once' in the past). Instants are in milliseconds.
 * `anchor` is where an 'every' schedule counts from (its last run, or when it was made), so a late tick does not shift the beat.
 */
export function nextRun(spec: ScheduleSpec, after: number, timezone: string, anchor?: number): number | null {
  switch (spec.kind) {
    case 'once':
      return spec.at > after ? spec.at : null
    case 'every': {
      const step = spec.minutes * 60_000
      const from = anchor ?? after
      if (from > after) return from
      return from + (Math.floor((after - from) / step) + 1) * step
    }
    case 'daily':
    case 'weekly': {
      const [h, mi] = parseTime(spec.time)
      const today = wallAt(after, timezone)
      // Eight days cover a week and a skipped day.
      for (let n = 0; n <= 8; n++) {
        const day = addDays(today.y, today.m, today.d, n)
        if (spec.kind === 'daily' ? spec.weekdaysOnly && (day.dow === 0 || day.dow === 6) : !spec.days.includes(day.dow)) continue
        const at = instantOf(day.y, day.m, day.d, h, mi, timezone)
        if (at > after) return at
      }
      return null
    }
    case 'monthly': {
      const [h, mi] = parseTime(spec.time)
      const today = wallAt(after, timezone)
      for (let n = 0; n <= 13; n++) {
        const y = today.y + Math.floor((today.m - 1 + n) / 12)
        const m = ((today.m - 1 + n) % 12) + 1
        const at = instantOf(y, m, Math.min(spec.day, daysIn(y, m)), h, mi, timezone)
        if (at > after) return at
      }
      return null
    }
  }
}

/** The next few times, for the dialog's "Next: …" line. */
export function nextRuns(spec: ScheduleSpec, after: number, timezone: string, count: number, anchor?: number): number[] {
  const out: number[] = []
  let at = after
  for (let i = 0; i < count; i++) {
    const next = nextRun(spec, at, timezone, anchor)
    if (next === null) break
    out.push(next)
    at = next
  }
  return out
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
const list = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/** "Daily at 09:00", "Every Monday and Friday at 18:30": what the schedule says in words. */
export function describeSpec(spec: ScheduleSpec, timezone?: string): string {
  switch (spec.kind) {
    case 'once': {
      const zone = timezone ? { timeZone: timezone } : {}
      const day = new Date(spec.at).toLocaleDateString('en-GB', { ...zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(',', '')
      const time = new Date(spec.at).toLocaleTimeString('en-GB', { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      return `Once, ${day} at ${time}`
    }
    case 'every':
      return spec.minutes % 60 === 0 && spec.minutes >= 60 ? `Every ${spec.minutes === 60 ? 'hour' : `${spec.minutes / 60} hours`}` : `Every ${spec.minutes} minutes`
    case 'daily':
      return spec.weekdaysOnly ? `Weekdays at ${spec.time}` : `Daily at ${spec.time}`
    case 'weekly':
      return `Every ${list([...spec.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d] as string))} at ${spec.time}`
    case 'monthly':
      return spec.day >= 31 ? `Monthly, on the last day, at ${spec.time}` : `Monthly, on the ${ordinal(spec.day)}, at ${spec.time}`
  }
}
