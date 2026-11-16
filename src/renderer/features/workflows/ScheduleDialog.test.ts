import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SchedulePreview, ScheduleSpec, ScheduleSummary } from '@shared/schedule'
import { ScheduleCard } from './ScheduleDialog'
import { stateOf } from './SchedulesList'
import { atText, emptyForm, formFromSpec, specFromForm, withValue } from './scheduleForm'

const preview: SchedulePreview = {
  actions: [
    { nodeId: 'a', nodeName: 'Zip the folder', kind: 'shell', text: 'zip -r notes.zip notes' },
    { nodeId: 'b', nodeName: 'Summarise', kind: 'agent', text: 'Summarise the changes' }
  ],
  next: [],
  problems: [],
  agentSteps: 1,
  computerSteps: []
}

describe('the schedule card', () => {
  it('says what every run will do, how often, and that nobody will be asked again', () => {
    const html = renderToStaticMarkup(createElement(ScheduleCard, { preview, spec: 'Daily at 09:00', name: 'Nightly backup' })).replace(/&quot;/g, '"')
    expect(html).toContain('Daily at 09:00, Celeste will do this for “Nightly backup”, without asking again.')
    for (const text of ['Zip the folder', 'zip -r notes.zip notes', 'Summarise the changes']) expect(html).toContain(text)
    expect(html).toContain('1 assistant step')
    expect(html).toContain('while nobody is watching')
  })

  it('does not mention assistant steps when there are none, and says so when there is nothing to do', () => {
    const html = renderToStaticMarkup(createElement(ScheduleCard, { preview: { ...preview, actions: [], agentSteps: 0 }, spec: 'Daily at 09:00', name: 'X' }))
    expect(html).not.toContain('assistant step')
    expect(html).toContain('nothing to do yet')
  })
})

describe('the answers of the form, as a schedule', () => {
  it('reads each kind', () => {
    const f = emptyForm()
    expect(specFromForm({ ...f, kind: 'daily', time: '07:30' })).toEqual({ kind: 'daily', time: '07:30' })
    expect(specFromForm({ ...f, kind: 'daily', time: '07:30', weekdaysOnly: true })).toEqual({ kind: 'daily', time: '07:30', weekdaysOnly: true })
    expect(specFromForm({ ...f, kind: 'weekly', time: '18:00', days: [5, 1] })).toEqual({ kind: 'weekly', time: '18:00', days: [1, 5] })
    expect(specFromForm({ ...f, kind: 'monthly', time: '08:00', day: '31' })).toEqual({ kind: 'monthly', time: '08:00', day: 31 })
    expect(specFromForm({ ...f, kind: 'every', every: '2', unit: 'hours' })).toEqual({ kind: 'every', minutes: 120 })
    expect(specFromForm({ ...f, kind: 'every', every: '45', unit: 'minutes' })).toEqual({ kind: 'every', minutes: 45 })
  })

  it('reads a date and time in the computer’s zone, and gives the same one back', () => {
    const at = new Date(2027, 0, 15, 9, 5).getTime()
    expect(atText(at)).toBe('2027-01-15T09:05')
    expect(specFromForm({ ...emptyForm(), kind: 'once', at: '2027-01-15T09:05' })).toEqual({ kind: 'once', at })
  })

  it('says nothing yet for what is not finished, so nothing is asked of Core', () => {
    const f = emptyForm()
    expect(specFromForm({ ...f, kind: 'once', at: '' })).toBeNull()
    expect(specFromForm({ ...f, kind: 'every', every: '' })).toBeNull()
    expect(specFromForm({ ...f, kind: 'every', every: 'soon' })).toBeNull()
    expect(specFromForm({ ...f, kind: 'every', every: '0' })).toBeNull()
    expect(specFromForm({ ...f, kind: 'every', every: '99999', unit: 'hours' })).toBeNull()
    expect(specFromForm({ ...f, kind: 'weekly', days: [] })).toBeNull()
    expect(specFromForm({ ...f, kind: 'daily', time: '' })).toBeNull()
    expect(specFromForm({ ...f, kind: 'monthly', day: '0' })).toBeNull()
  })

  it('opens a schedule that exists with its own answers', () => {
    const specs: ScheduleSpec[] = [
      { kind: 'daily', time: '09:00', weekdaysOnly: true },
      { kind: 'weekly', time: '18:30', days: [1, 3] },
      { kind: 'monthly', time: '06:00', day: 31 },
      { kind: 'every', minutes: 90 },
      { kind: 'every', minutes: 180 },
      { kind: 'once', at: new Date(2027, 5, 1, 12, 0).getTime() }
    ]
    for (const spec of specs) expect(specFromForm(formFromSpec(spec))).toEqual(spec)
  })

  it('keeps a limit an older version stored among the choices', () => {
    expect(withValue([{ sec: 600, label: '10 minutes' }], 600)).toHaveLength(1)
    expect(withValue([{ sec: 600, label: '10 minutes' }], 5400).map((c) => c.label)).toEqual(['10 minutes', '90 minutes'])
  })
})

const schedule = (over: Partial<ScheduleSummary>): ScheduleSummary => ({
  id: 'sch-1',
  workflowId: 'w1',
  enabled: true,
  spec: { kind: 'daily', time: '09:00' },
  timezone: 'UTC',
  inputs: {},
  folder: '',
  approvedVersion: 1,
  approvedAt: 0,
  graceSec: 7200,
  waitLimitSec: 1800,
  notify: 'problems',
  nextRunAt: new Date(2027, 0, 15, 9, 0).getTime(),
  lastFireAt: null,
  failStreak: 0,
  createdAt: 0,
  updatedAt: 0,
  workflowName: 'Backup',
  describe: 'Daily at 09:00',
  ...over
})

describe('what the list says about a schedule', () => {
  it('shows the next time for one that is on', () => {
    expect(stateOf(schedule({}))).toEqual({ line: expect.stringContaining('Next: Fri 15 Jan 2027, 09:00') })
  })

  it('says when it needs the person, and why', () => {
    expect(stateOf(schedule({ enabled: false, pausedReason: 'edited' })).badge?.text).toBe('Needs your OK again')
    expect(stateOf(schedule({ enabled: false, pausedReason: 'failures' })).line).toContain('failed 3 times')
    expect(stateOf(schedule({ pausedReason: 'all' })).badge?.text).toBe('Paused: all')
  })

  it('tells a switched-off schedule from a "once" that has run', () => {
    expect(stateOf(schedule({ enabled: false })).badge?.text).toBe('Off')
    expect(stateOf(schedule({ enabled: false, nextRunAt: null, spec: { kind: 'once', at: 1 }, lastFireAt: 5 })).badge?.text).toBe('Done')
  })
})
