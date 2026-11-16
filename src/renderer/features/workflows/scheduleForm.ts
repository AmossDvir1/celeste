import { MAX_EVERY_MINUTES, type NotifyWhen, type ScheduleSpec } from '@shared/schedule'

/** What the schedule dialog holds while it is open: everything as the person typed it, so a half-finished answer is not lost. */
export interface WhenForm {
  kind: ScheduleSpec['kind']
  /** For 'once': what a date and time field holds, 'YYYY-MM-DDTHH:MM', in the computer's zone. */
  at: string
  /** For 'every'. */
  every: string
  unit: 'minutes' | 'hours'
  /** For 'daily', 'weekly' and 'monthly': 'HH:MM'. */
  time: string
  weekdaysOnly: boolean
  /** Days of the week, 0 (Sunday) to 6. */
  days: number[]
  /** Day of the month, as typed. 31 is the last day. */
  day: string
}

export const KIND_LABEL: Record<ScheduleSpec['kind'], string> = { once: 'Once', every: 'Every so often', daily: 'Every day', weekly: 'On some days of the week', monthly: 'Once a month' }
export const KINDS = Object.keys(KIND_LABEL) as ScheduleSpec['kind'][]

const pad = (n: number) => String(n).padStart(2, '0')

/** A date and time field's text for an instant, in the computer's zone. */
export const atText = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Mon 17 Nov, 09:00": when something is, for a line of text. */
export const atWords = (ms: number): string => {
  const d = new Date(ms)
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })
  return `${day.replace(',', '')}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** An hour from now, rounded up to the next five minutes: a good first answer for "once". */
export function soon(now = Date.now()): string {
  return atText(Math.ceil((now + 3_600_000) / 300_000) * 300_000)
}

export function emptyForm(now = Date.now()): WhenForm {
  return { kind: 'daily', at: soon(now), every: '1', unit: 'hours', time: '09:00', weekdaysOnly: false, days: [1], day: '1' }
}

/** The form for a schedule that exists, to change it. */
export function formFromSpec(spec: ScheduleSpec, now = Date.now()): WhenForm {
  const f = emptyForm(now)
  switch (spec.kind) {
    case 'once':
      return { ...f, kind: 'once', at: atText(spec.at) }
    case 'every':
      return spec.minutes % 60 === 0 ? { ...f, kind: 'every', every: String(spec.minutes / 60), unit: 'hours' } : { ...f, kind: 'every', every: String(spec.minutes), unit: 'minutes' }
    case 'daily':
      return { ...f, kind: 'daily', time: spec.time, weekdaysOnly: spec.weekdaysOnly === true }
    case 'weekly':
      return { ...f, kind: 'weekly', time: spec.time, days: [...spec.days] }
    case 'monthly':
      return { ...f, kind: 'monthly', time: spec.time, day: String(spec.day) }
  }
}

/**
 * The schedule the form says, or null while it says nothing yet (no date, a number that is not one). Whether the schedule is allowed is
 * for Core to say: this only reads what was typed.
 */
export function specFromForm(f: WhenForm): ScheduleSpec | null {
  switch (f.kind) {
    case 'once': {
      const at = new Date(f.at).getTime()
      return f.at && Number.isFinite(at) ? { kind: 'once', at } : null
    }
    case 'every': {
      const n = Number(f.every)
      if (!f.every.trim() || !Number.isFinite(n) || n <= 0) return null
      const minutes = Math.round(f.unit === 'hours' ? n * 60 : n)
      return minutes > MAX_EVERY_MINUTES ? null : { kind: 'every', minutes }
    }
    case 'daily':
      return f.time ? { kind: 'daily', time: f.time, ...(f.weekdaysOnly ? { weekdaysOnly: true } : {}) } : null
    case 'weekly':
      return f.time && f.days.length ? { kind: 'weekly', time: f.time, days: [...f.days].sort((a, b) => a - b) } : null
    case 'monthly': {
      const day = Number(f.day)
      return f.time && Number.isInteger(day) && day >= 1 && day <= 31 ? { kind: 'monthly', time: f.time, day } : null
    }
  }
}

/** How late a run may still start, as the choices the dialog offers (seconds). */
export const LATE_CHOICES: { sec: number; label: string }[] = [
  { sec: 900, label: '15 minutes' },
  { sec: 3600, label: 'an hour' },
  { sec: 7200, label: '2 hours' },
  { sec: 21_600, label: '6 hours' },
  { sec: 86_400, label: 'a day' }
]
/** How long a run waits for an answer before it is stopped (seconds). */
export const WAIT_CHOICES: { sec: number; label: string }[] = [
  { sec: 600, label: '10 minutes' },
  { sec: 1800, label: '30 minutes' },
  { sec: 3600, label: 'an hour' },
  { sec: 7200, label: '2 hours' }
]
export const NOTIFY_CHOICES: { value: NotifyWhen; label: string }[] = [
  { value: 'problems', label: 'When it fails or needs me' },
  { value: 'always', label: 'Also when it finishes' },
  { value: 'never', label: 'Only when it needs me' }
]

/** The choices with the current value among them, so a value an older version stored still shows. */
export function withValue(choices: { sec: number; label: string }[], sec: number): { sec: number; label: string }[] {
  if (choices.some((c) => c.sec === sec)) return choices
  const label = sec % 3600 === 0 ? `${sec / 3600} hours` : `${Math.round(sec / 60)} minutes`
  return [...choices, { sec, label }].sort((a, b) => a.sec - b.sec)
}
