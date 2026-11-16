import { describe, expect, it } from 'vitest'
import { describeSpec, instantOf, nextRun, nextRuns, validateSpec, type ScheduleSpec } from './schedule'

const z = (iso: string) => Date.parse(iso)
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString().replace('.000Z', 'Z'))

const JERUSALEM = 'Asia/Jerusalem' // UTC+2, UTC+3 in summer: clocks go forward 2026-03-27 and back 2026-10-25
const NEW_YORK = 'America/New_York' // UTC-5, UTC-4 in summer: forward 2026-03-08, back 2026-11-01

describe('when a daily schedule runs next', () => {
  it('is the next 9:00 on the wall clock of the schedule’s own zone', () => {
    const daily: ScheduleSpec = { kind: 'daily', time: '09:00' }
    // 10:00 in Jerusalem (winter): today's 9:00 has gone, so tomorrow's.
    expect(iso(nextRun(daily, z('2026-11-16T08:00:00Z'), JERUSALEM))).toBe('2026-11-17T07:00:00Z')
    // 08:00 in Jerusalem: today's.
    expect(iso(nextRun(daily, z('2026-11-16T06:00:00Z'), JERUSALEM))).toBe('2026-11-16T07:00:00Z')
    // Strictly after: at 9:00 exactly it is tomorrow's.
    expect(iso(nextRun(daily, z('2026-11-16T07:00:00Z'), JERUSALEM))).toBe('2026-11-17T07:00:00Z')
  })

  it('is a different instant in a different zone, and keeps the wall time across a clock change', () => {
    const daily: ScheduleSpec = { kind: 'daily', time: '09:00' }
    const after = z('2026-11-16T00:00:00Z')
    expect(iso(nextRun(daily, after, JERUSALEM))).toBe('2026-11-16T07:00:00Z')
    expect(iso(nextRun(daily, after, NEW_YORK))).toBe('2026-11-16T14:00:00Z')
    // New York: 9:00 is 14:00 UTC before the clocks go forward and 13:00 after.
    expect(iso(nextRun(daily, z('2026-03-07T00:00:00Z'), NEW_YORK))).toBe('2026-03-07T14:00:00Z')
    expect(iso(nextRun(daily, z('2026-03-08T00:00:00Z'), NEW_YORK))).toBe('2026-03-08T13:00:00Z')
  })

  it('skips weekends when it is for weekdays only', () => {
    const weekdays: ScheduleSpec = { kind: 'daily', time: '09:00', weekdaysOnly: true }
    expect(iso(nextRun(weekdays, z('2026-11-20T10:00:00Z'), 'UTC'))).toBe('2026-11-23T09:00:00Z')
    expect(iso(nextRun(weekdays, z('2026-11-21T10:00:00Z'), 'UTC'))).toBe('2026-11-23T09:00:00Z')
  })

  it('runs a time the clock skips at the first minute after the gap', () => {
    const night: ScheduleSpec = { kind: 'daily', time: '02:30' }
    // Jerusalem, 2026-03-27: 02:00 becomes 03:00, so 02:30 does not exist. 03:00 there is 00:00 UTC.
    expect(iso(nextRun(night, z('2026-03-26T12:00:00Z'), JERUSALEM))).toBe('2026-03-27T00:00:00Z')
    // New York, 2026-03-08: 03:00 EDT is 07:00 UTC.
    expect(iso(nextRun(night, z('2026-03-07T12:00:00Z'), NEW_YORK))).toBe('2026-03-08T07:00:00Z')
    // The day after is an ordinary 02:30.
    expect(iso(nextRun(night, z('2026-03-27T00:00:00Z'), JERUSALEM))).toBe('2026-03-27T23:30:00Z')
  })

  it('runs a time that happens twice once, the first time', () => {
    const night: ScheduleSpec = { kind: 'daily', time: '01:30' }
    // Jerusalem, 2026-10-25: 01:30 comes at 22:30 UTC (summer time) and again at 23:30 UTC (winter time).
    const first = nextRun(night, z('2026-10-24T12:00:00Z'), JERUSALEM) as number
    expect(iso(first)).toBe('2026-10-24T22:30:00Z')
    // Not again an hour later: the next one is the next day's 01:30 (23:30 UTC on the 25th).
    expect(iso(nextRun(night, first, JERUSALEM))).toBe('2026-10-25T23:30:00Z')
    // New York, 2026-11-01: the first 01:30 is 05:30 UTC.
    const ny = nextRun(night, z('2026-10-31T12:00:00Z'), NEW_YORK) as number
    expect(iso(ny)).toBe('2026-11-01T05:30:00Z')
    expect(iso(nextRun(night, ny, NEW_YORK))).toBe('2026-11-02T06:30:00Z')
  })

  it('finds the instant of a wall time, the gap’s end, and the first of a repeated one', () => {
    expect(iso(instantOf(2026, 11, 16, 9, 0, JERUSALEM))).toBe('2026-11-16T07:00:00Z')
    expect(iso(instantOf(2026, 3, 27, 2, 30, JERUSALEM))).toBe('2026-03-27T00:00:00Z')
    expect(iso(instantOf(2026, 10, 25, 1, 30, JERUSALEM))).toBe('2026-10-24T22:30:00Z')
  })
})

describe('when a weekly, monthly, once or repeating schedule runs next', () => {
  it('weekly: the next chosen day at the time', () => {
    const weekly: ScheduleSpec = { kind: 'weekly', time: '18:30', days: [5, 1] }
    // Monday 2026-11-16 at 19:00 UTC: Monday's 18:30 has gone, so Friday.
    expect(iso(nextRun(weekly, z('2026-11-16T19:00:00Z'), 'UTC'))).toBe('2026-11-20T18:30:00Z')
    expect(iso(nextRun(weekly, z('2026-11-20T19:00:00Z'), 'UTC'))).toBe('2026-11-23T18:30:00Z')
    // One day only: a week on.
    expect(iso(nextRun({ kind: 'weekly', time: '18:30', days: [1] }, z('2026-11-16T19:00:00Z'), 'UTC'))).toBe('2026-11-23T18:30:00Z')
  })

  it('monthly: the 31st is the last day of a shorter month, and a leap day is there when there is one', () => {
    const last: ScheduleSpec = { kind: 'monthly', time: '09:00', day: 31 }
    const runs = nextRuns(last, z('2026-01-31T10:00:00Z'), 'UTC', 5).map(iso)
    expect(runs).toEqual(['2026-02-28T09:00:00Z', '2026-03-31T09:00:00Z', '2026-04-30T09:00:00Z', '2026-05-31T09:00:00Z', '2026-06-30T09:00:00Z'])
    // 2028 is a leap year.
    expect(iso(nextRun(last, z('2028-02-01T00:00:00Z'), 'UTC'))).toBe('2028-02-29T09:00:00Z')
    // The 29th in a year that has no 29 February is the 28th.
    expect(iso(nextRun({ kind: 'monthly', time: '09:00', day: 29 }, z('2026-02-01T00:00:00Z'), 'UTC'))).toBe('2026-02-28T09:00:00Z')
    expect(iso(nextRun({ kind: 'monthly', time: '09:00', day: 15 }, z('2026-12-20T00:00:00Z'), 'UTC'))).toBe('2027-01-15T09:00:00Z')
  })

  it('once: its time while it is ahead, and nothing after', () => {
    const once: ScheduleSpec = { kind: 'once', at: z('2026-11-17T14:00:00Z') }
    expect(iso(nextRun(once, z('2026-11-16T00:00:00Z'), 'UTC'))).toBe('2026-11-17T14:00:00Z')
    expect(nextRun(once, z('2026-11-17T14:00:00Z'), 'UTC')).toBeNull()
    expect(nextRun(once, z('2026-11-18T00:00:00Z'), 'UTC')).toBeNull()
  })

  it('every: counts from where it was last, so a late tick does not move the beat', () => {
    const every: ScheduleSpec = { kind: 'every', minutes: 15 }
    const anchor = z('2026-11-16T10:00:00Z')
    expect(iso(nextRun(every, z('2026-11-16T10:07:00Z'), 'UTC', anchor))).toBe('2026-11-16T10:15:00Z')
    // A tick that came 10 minutes late is still on the quarter hours.
    expect(iso(nextRun(every, z('2026-11-16T10:25:00Z'), 'UTC', anchor))).toBe('2026-11-16T10:30:00Z')
    // After a long sleep, one run now, then back on the beat.
    expect(iso(nextRun(every, z('2026-11-16T14:41:00Z'), 'UTC', anchor))).toBe('2026-11-16T14:45:00Z')
    // With nothing to count from, a step from now.
    expect(iso(nextRun(every, z('2026-11-16T10:07:00Z'), 'UTC'))).toBe('2026-11-16T10:22:00Z')
  })

  it('lists the next few', () => {
    expect(nextRuns({ kind: 'daily', time: '09:00' }, z('2026-11-16T10:00:00Z'), 'UTC', 3).map(iso)).toEqual(['2026-11-17T09:00:00Z', '2026-11-18T09:00:00Z', '2026-11-19T09:00:00Z'])
    expect(nextRuns({ kind: 'once', at: z('2026-11-17T00:00:00Z') }, z('2026-11-16T00:00:00Z'), 'UTC', 5)).toHaveLength(1)
  })
})

describe('checking a spec', () => {
  const ok = (spec: unknown, agent = false) => validateSpec(spec, agent)

  it('accepts each kind when it is right', () => {
    expect(ok({ kind: 'once', at: 1 })).toEqual([])
    expect(ok({ kind: 'every', minutes: 5 })).toEqual([])
    expect(ok({ kind: 'daily', time: '00:00' })).toEqual([])
    expect(ok({ kind: 'daily', time: '23:59', weekdaysOnly: true })).toEqual([])
    expect(ok({ kind: 'weekly', time: '09:00', days: [0, 6] })).toEqual([])
    expect(ok({ kind: 'monthly', time: '09:00', day: 31 })).toEqual([])
  })

  it('keeps "every" to at least 5 minutes, and 30 with an assistant step, and at most a week', () => {
    expect(ok({ kind: 'every', minutes: 4 })[0]).toMatch(/every 5 minutes/)
    expect(ok({ kind: 'every', minutes: 29 }, true)[0]).toMatch(/assistant step.*every 30 minutes/)
    expect(ok({ kind: 'every', minutes: 30 }, true)).toEqual([])
    expect(ok({ kind: 'every', minutes: 29 }, false)).toEqual([])
    expect(ok({ kind: 'every', minutes: 10_081 })[0]).toMatch(/weekly or monthly/)
    expect(ok({ kind: 'every', minutes: 7.5 })).toHaveLength(1)
  })

  it('refuses a time that is not a time, days that are not days, and anything else', () => {
    for (const time of ['9:00', '24:00', '09:60', '', 'noon', 900]) expect(ok({ kind: 'daily', time })).toHaveLength(1)
    expect(ok({ kind: 'weekly', time: '09:00', days: [] })[0]).toMatch(/at least one day/)
    expect(ok({ kind: 'weekly', time: '09:00', days: [1, 1] })[0]).toMatch(/different days/)
    expect(ok({ kind: 'weekly', time: '09:00', days: [7] })[0]).toMatch(/different days/)
    expect(ok({ kind: 'monthly', time: '09:00', day: 0 })[0]).toMatch(/1 to 31/)
    expect(ok({ kind: 'monthly', time: '09:00', day: 32 })[0]).toMatch(/1 to 31/)
    expect(ok({ kind: 'once', at: 'tomorrow' })[0]).toMatch(/date and a time/)
    expect(ok({ kind: 'cron', expr: '* * * * *' })[0]).toMatch(/how often/)
    expect(ok(null)[0]).toMatch(/when/)
    expect(ok('daily')[0]).toMatch(/when/)
  })
})

describe('saying a schedule in words', () => {
  it('uses plain words for each kind', () => {
    expect(describeSpec({ kind: 'daily', time: '09:00' })).toBe('Daily at 09:00')
    expect(describeSpec({ kind: 'daily', time: '09:00', weekdaysOnly: true })).toBe('Weekdays at 09:00')
    expect(describeSpec({ kind: 'weekly', time: '18:30', days: [5, 1] })).toBe('Every Monday and Friday at 18:30')
    expect(describeSpec({ kind: 'weekly', time: '07:00', days: [1, 3, 5] })).toBe('Every Monday, Wednesday and Friday at 07:00')
    expect(describeSpec({ kind: 'every', minutes: 15 })).toBe('Every 15 minutes')
    expect(describeSpec({ kind: 'every', minutes: 60 })).toBe('Every hour')
    expect(describeSpec({ kind: 'every', minutes: 120 })).toBe('Every 2 hours')
    expect(describeSpec({ kind: 'every', minutes: 90 })).toBe('Every 90 minutes')
    expect(describeSpec({ kind: 'monthly', time: '09:00', day: 1 })).toBe('Monthly, on the 1st, at 09:00')
    expect(describeSpec({ kind: 'monthly', time: '09:00', day: 22 })).toBe('Monthly, on the 22nd, at 09:00')
    expect(describeSpec({ kind: 'monthly', time: '09:00', day: 11 })).toBe('Monthly, on the 11th, at 09:00')
    expect(describeSpec({ kind: 'monthly', time: '09:00', day: 31 })).toBe('Monthly, on the last day, at 09:00')
    expect(describeSpec({ kind: 'once', at: z('2026-11-17T14:00:00Z') }, 'UTC')).toBe('Once, Tue 17 Nov 2026 at 14:00')
  })
})
