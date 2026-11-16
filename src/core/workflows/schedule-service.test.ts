import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScheduleApi } from '@shared/api'
import type { ScheduleSaveInput, ScheduleSpec } from '@shared/schedule'
import type { WorkflowDefinition, WorkflowNode } from '@shared/workflow'
import { toFile } from '@shared/workflow-file'
import { MemoryStore } from '../testing/memory-store'
import { WorkflowRunner } from './runner'
import { ScheduleService, approvalHash } from './schedule-service'

const NOW = Date.parse('2026-11-16T10:00:00Z')
let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'celeste-sched-svc-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const start = (inputs: { name: string; required?: boolean; default?: string | number; type?: 'text' | 'number' }[] = []): WorkflowNode => ({ id: 'start', type: 'start', name: 'Start', inputs: inputs.map((i) => ({ type: 'text' as const, ...i })) })
const shell: WorkflowNode = { id: 'run', type: 'tool', name: 'Back up', tool: { kind: 'shell', command: 'echo {{inputs.env}}' } }
const agent: WorkflowNode = { id: 'ask', type: 'agent', name: 'Summarize', prompt: 'summarize', approval: 'ask' }
const computer: WorkflowNode = { id: 'use', type: 'agent', name: 'Use the computer', prompt: 'x', computer: {} }
const chain = (...nodes: WorkflowNode[]): WorkflowDefinition => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id })) })
const end: WorkflowNode = { id: 'end', type: 'end', name: 'End' }

function world(def: WorkflowDefinition = chain(start([{ name: 'env', default: 'staging' }]), shell, end)) {
  const store = new MemoryStore()
  const clock = { now: NOW }
  let changes = 0
  store.saveWorkflow({ id: 'w1', name: 'Backup', description: '', version: 1, allowAssistant: false, definition: def, createdAt: 1, updatedAt: 1 })
  const runner = new WorkflowRunner({ store, push: () => undefined, agent: { run: async () => 'x' }, mcp: { find: async () => undefined, call: async () => ({ text: '', isError: false }) }, now: () => clock.now })
  const state = { paused: false }
  const service = new ScheduleService(store, runner, { now: () => clock.now, changed: () => void changes++, paused: () => state.paused, dataDir: folder })
  const api: ScheduleApi = service.api
  const input = (over: Partial<ScheduleSaveInput> = {}): ScheduleSaveInput => ({ workflowId: 'w1', spec: { kind: 'daily', time: '09:00' }, inputs: {}, folder, timezone: 'UTC', approved: true, ...over })
  return { store, clock, api, input, changes: () => changes, state }
}

describe('making a schedule', () => {
  it('is refused unless the card was shown and answered', async () => {
    const w = world()
    await expect(w.api['schedules.save'](w.input({ approved: false }))).rejects.toThrow(/before a schedule is made/)
    await expect(w.api['schedules.save']({ ...w.input(), approved: undefined as never })).rejects.toThrow(/before a schedule is made/)
    expect(w.store.listSchedules()).toEqual([])
  })

  it('keeps what the person approved, with the answers as the workflow wants them, and works out when it runs next', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input({ inputs: { env: 'prod' } }))
    expect(s).toMatchObject({ workflowId: 'w1', workflowName: 'Backup', enabled: true, timezone: 'UTC', inputs: { env: 'prod' }, folder, approvedVersion: 1, approvedAt: NOW, graceSec: 7200, waitLimitSec: 1800, notify: 'problems', failStreak: 0, describe: 'Daily at 09:00' })
    expect(s.nextRunAt).toBe(Date.parse('2026-11-17T09:00:00Z'))
    // The hash is stored and not given out.
    expect(s).not.toHaveProperty('approvedHash')
    expect(w.store.getSchedule(s.id)?.approvedHash).toBe(approvalHash(1, { env: 'prod' }, folder))
    expect(s.id).toMatch(/^sch-/)
    expect(w.changes()).toBe(1)
  })

  it('uses the workflow’s defaults for answers it was not given, and refuses a missing required answer', async () => {
    const w = world()
    expect((await w.api['schedules.save'](w.input())).inputs).toEqual({ env: 'staging' })
    const need = world(chain(start([{ name: 'env', required: true }]), shell, end))
    await expect(need.api['schedules.save'](need.input())).rejects.toThrow('“env” is needed.')
  })

  it('works in the workflow’s own private folder when none is chosen, and refuses a folder that is not one', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input({ folder: undefined }))
    expect(s.folder).toBe(join(folder, 'workflows', 'w1'))
    await expect(w.api['schedules.save'](w.input({ folder: join(folder, 'nope') }))).rejects.toThrow('Choose a folder')
  })

  it('refuses a workflow that uses the computer, which needs the person there', async () => {
    const w = world(chain(start(), computer, end))
    await expect(w.api['schedules.save'](w.input())).rejects.toThrow(/“Use the computer” uses the computer, which needs you there/)
    expect(w.store.listSchedules()).toEqual([])
  })

  it('keeps "every" to 30 minutes when the workflow has an assistant step, and 5 when it has none', async () => {
    const withAgent = world(chain(start(), agent, end))
    await expect(withAgent.api['schedules.save'](withAgent.input({ spec: { kind: 'every', minutes: 15 } }))).rejects.toThrow(/assistant step.*every 30 minutes/)
    expect((await withAgent.api['schedules.save'](withAgent.input({ spec: { kind: 'every', minutes: 30 } }))).describe).toBe('Every 30 minutes')
    const plain = world()
    expect((await plain.api['schedules.save'](plain.input({ spec: { kind: 'every', minutes: 15 } }))).nextRunAt).toBe(NOW + 15 * 60_000)
    await expect(plain.api['schedules.save'](plain.input({ spec: { kind: 'every', minutes: 2 } }))).rejects.toThrow(/every 5 minutes/)
  })

  it('refuses a spec that is not one, a time that has passed, and limits out of range', async () => {
    const w = world()
    await expect(w.api['schedules.save'](w.input({ spec: { kind: 'daily', time: '25:00' } }))).rejects.toThrow(/24 hour clock/)
    await expect(w.api['schedules.save'](w.input({ spec: { kind: 'once', at: NOW - 1000 } }))).rejects.toThrow('already passed')
    await expect(w.api['schedules.save'](w.input({ graceSec: 5 }))).rejects.toThrow(/1 minute to 24 hours/)
    await expect(w.api['schedules.save'](w.input({ waitLimitSec: 90_000 }))).rejects.toThrow(/1 minute to 24 hours/)
    await expect(w.api['schedules.save'](w.input({ notify: 'shout' as never }))).rejects.toThrow('Invalid notify')
    await expect(w.api['schedules.save'](w.input({ timezone: 'Mars/Olympus' }))).rejects.toThrow('time zone')
    await expect(w.api['schedules.save'](w.input({ workflowId: 'nope' }))).rejects.toThrow('no longer exists')
    expect(w.store.listSchedules()).toEqual([])
  })

  it('may have several for one workflow, with different answers', async () => {
    const w = world()
    await w.api['schedules.save'](w.input({ inputs: { env: 'staging' } }))
    await w.api['schedules.save'](w.input({ inputs: { env: 'prod' }, spec: { kind: 'weekly', time: '18:00', days: [5] } }))
    expect(w.api['schedules.list']('w1').map((s) => [s.inputs, s.describe])).toEqual([[{ env: 'staging' }, 'Daily at 09:00'], [{ env: 'prod' }, 'Every Friday at 18:00']])
    expect(w.api['schedules.list']('other')).toEqual([])
  })

  it('changing one needs approving again, keeps its place and its history, and clears a pause', async () => {
    const w = world()
    const first = await w.api['schedules.save'](w.input())
    w.store.saveSchedule({ ...(w.store.getSchedule(first.id) as never as Parameters<typeof w.store.saveSchedule>[0]), enabled: false, pausedReason: 'failures', failStreak: 3, lastFireAt: 77 })
    w.clock.now += 1000
    const second = await w.api['schedules.save'](w.input({ id: first.id, inputs: { env: 'prod' } }))
    expect(second).toMatchObject({ id: first.id, createdAt: first.createdAt, enabled: true, failStreak: 0, lastFireAt: 77, inputs: { env: 'prod' } })
    expect(second).not.toHaveProperty('pausedReason')
    expect(w.store.listSchedules()).toHaveLength(1)
    expect(w.store.scheduleLog(first.id, 5)[0]).toMatchObject({ kind: 'resumed' })
    await expect(w.api['schedules.save'](w.input({ id: 'sch-nope' }))).rejects.toThrow('no longer exists')
  })
})

describe('what the approval is bound to', () => {
  it('changes with the version, the answers and the folder, and not with the order the answers were written in', () => {
    const base = approvalHash(1, { a: 1, b: 'x' }, '/work')
    expect(approvalHash(1, { b: 'x', a: 1 }, '/work')).toBe(base)
    expect(approvalHash(2, { a: 1, b: 'x' }, '/work')).not.toBe(base)
    expect(approvalHash(1, { a: 2, b: 'x' }, '/work')).not.toBe(base)
    expect(approvalHash(1, { a: 1, b: 'x' }, '/other')).not.toBe(base)
  })
})

describe('switching a schedule off and on, and taking it away', () => {
  it('turns it off and on, working out the next time again, and takes it away with its log', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input())
    expect(w.api['schedules.setEnabled'](s.id, false)).toMatchObject({ enabled: false })
    w.clock.now = Date.parse('2026-11-18T12:00:00Z')
    expect(w.api['schedules.setEnabled'](s.id, true)).toMatchObject({ enabled: true, nextRunAt: Date.parse('2026-11-19T09:00:00Z') })
    w.store.appendScheduleLog(s.id, 1, 'missed', 'x')
    expect(w.api['schedules.log'](s.id)).toHaveLength(1)
    w.api['schedules.remove'](s.id)
    expect(w.api['schedules.list']()).toEqual([])
    expect(() => w.api['schedules.remove'](s.id)).toThrow('no longer exists')
    expect(() => w.api['schedules.log'](s.id)).toThrow('no longer exists')
  })

  it('refuses to switch it on when the workflow changed since the person approved it', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input())
    w.store.saveWorkflow({ ...(w.store.getWorkflow('w1') as NonNullable<ReturnType<typeof w.store.getWorkflow>>), version: 2 })
    w.api['schedules.setEnabled'](s.id, false)
    expect(() => w.api['schedules.setEnabled'](s.id, true)).toThrow(/approve it again/)
    expect(w.store.getSchedule(s.id)?.enabled).toBe(false)
  })

  it('switches a schedule that paused itself after failures back on, from the start of its count', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input())
    w.store.saveSchedule({ ...(w.store.getSchedule(s.id) as NonNullable<ReturnType<typeof w.store.getSchedule>>), enabled: false, pausedReason: 'failures', failStreak: 3 })
    const on = w.api['schedules.setEnabled'](s.id, true)
    expect(on).toMatchObject({ enabled: true, failStreak: 0 })
    expect(on).not.toHaveProperty('pausedReason')
    expect(w.store.scheduleLog(s.id, 5)[0]).toMatchObject({ kind: 'resumed' })
  })

  it('refuses to switch on a "once" whose time has passed', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input({ spec: { kind: 'once', at: NOW + 60_000 } }))
    w.api['schedules.setEnabled'](s.id, false)
    w.clock.now = NOW + 120_000
    expect(() => w.api['schedules.setEnabled'](s.id, true)).toThrow('already passed')
  })

  it('shows "Paused: all" on the schedules that are on while the person has paused them all', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input())
    expect(w.api['schedules.list']()[0]).not.toHaveProperty('pausedReason')
    w.state.paused = true
    expect(w.api['schedules.list']()[0]).toMatchObject({ pausedReason: 'all' })
    w.api['schedules.setEnabled'](s.id, false)
    expect(w.api['schedules.list']()[0]).not.toHaveProperty('pausedReason')
  })

  it('lists the last run and the last note of each', async () => {
    const w = world()
    const s = await w.api['schedules.save'](w.input())
    w.store.insertRun({ id: 'r1', workflowId: 'w1', workflowName: 'Backup', version: 1, status: 'failed', startedBy: 'schedule', scheduleId: s.id, inputs: {}, folder, startedAt: 100, finishedAt: 150 })
    w.store.appendScheduleLog(s.id, 200, 'skipped', 'Skipped: the last run was still going.')
    expect(w.api['schedules.list']()[0]).toMatchObject({ lastRun: { id: 'r1', status: 'failed', at: 150 }, lastLog: { kind: 'skipped', at: 200 } })
  })
})

describe('showing the card before anything is made', () => {
  it('gives what a run would do, the next five times, and no problems for a good one', async () => {
    const w = world()
    const p = await w.api['schedules.preview']({ workflowId: 'w1', inputs: { env: 'prod' }, spec: { kind: 'daily', time: '09:00' }, timezone: 'UTC' })
    expect(p.problems).toEqual([])
    expect(p.actions).toEqual([expect.objectContaining({ kind: 'shell', text: 'echo prod' })])
    expect(p.next.map((t) => new Date(t).toISOString())).toEqual(['2026-11-17T09:00:00.000Z', '2026-11-18T09:00:00.000Z', '2026-11-19T09:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-11-21T09:00:00.000Z'])
    expect(p.agentSteps).toBe(0)
  })

  it('says what is wrong in sentences, and gives no times for a spec that is not valid', async () => {
    const w = world(chain(start(), agent, computer, end))
    const spec: ScheduleSpec = { kind: 'every', minutes: 10 }
    const p = await w.api['schedules.preview']({ workflowId: 'w1', inputs: {}, spec, timezone: 'UTC' })
    expect(p.agentSteps).toBe(2)
    expect(p.computerSteps).toEqual(['Use the computer'])
    expect(p.problems.some((x) => /uses the computer/.test(x))).toBe(true)
    expect(p.problems.some((x) => /assistant step/.test(x))).toBe(true)
    expect(p.next).toEqual([])
    expect((await w.api['schedules.preview']({ workflowId: 'nope', inputs: {}, spec, timezone: 'UTC' })).problems[0]).toMatch(/no longer exists/)
  })

  it('makes nothing', async () => {
    const w = world()
    await w.api['schedules.preview']({ workflowId: 'w1', inputs: {}, spec: { kind: 'daily', time: '09:00' } })
    expect(w.store.listSchedules()).toEqual([])
    expect(w.store.listRuns(undefined, 10)).toEqual([])
  })
})

describe('sharing a workflow', () => {
  it('leaves the schedules out of an exported file: a shared file never arrives with a standing instruction', async () => {
    const w = world()
    await w.api['schedules.save'](w.input())
    const wf = w.store.getWorkflow('w1')
    const file = toFile(wf?.name ?? '', wf?.description ?? '', wf?.definition as WorkflowDefinition)
    expect(Object.keys(JSON.parse(file.text) as object).sort()).toEqual(['definition', 'description', 'format', 'name', 'version'])
    expect(file.text).not.toMatch(/schedule|nextRunAt|approved/i)
  })
})
