import { describe, expect, it } from 'vitest'
import { foldRun, stateOf } from './workflow-run'
import type { RunEvent } from './workflow'

const run = (...events: RunEvent[]) => foldRun(events)

describe('what a run looks like from its events', () => {
  it('lights steps as they start and finish, and keeps what they produced', () => {
    const v = run(
      { type: 'run.started', inputs: {} },
      { type: 'node.started', nodeId: 'start', attempt: 1 },
      { type: 'node.completed', nodeId: 'start', output: '' },
      { type: 'node.started', nodeId: 'a', attempt: 1 },
      { type: 'node.output', nodeId: 'a', text: 'ignored: the finished output is what is kept' }
    )
    expect(stateOf(v, 'start')).toBe('done')
    expect(stateOf(v, 'a')).toBe('running')
    expect(stateOf(v, 'b')).toBe('pending')
    expect(v.finished).toBeUndefined()
  })

  it('shows a step being tried again, and clears that when the new try starts', () => {
    const retrying = run({ type: 'node.started', nodeId: 'a', attempt: 1 }, { type: 'node.retrying', nodeId: 'a', attempt: 2, error: 'No answer.' })
    expect(retrying.nodes['a']).toMatchObject({ state: 'running', attempt: 2, retrying: 'No answer.' })
    const again = run({ type: 'node.started', nodeId: 'a', attempt: 1 }, { type: 'node.retrying', nodeId: 'a', attempt: 2, error: 'x' }, { type: 'node.started', nodeId: 'a', attempt: 2 })
    expect(again.nodes['a']?.retrying).toBeUndefined()
  })

  it('tells a step that failed from one that was skipped, with the reason', () => {
    const v = run({ type: 'node.skipped', nodeId: 'a', error: 'Exit code 1.' }, { type: 'node.failed', nodeId: 'b', error: 'Boom.' }, { type: 'run.failed', error: '“b” failed: Boom.' })
    expect(v.nodes['a']).toMatchObject({ state: 'skipped', error: 'Exit code 1.' })
    expect(v.nodes['b']).toMatchObject({ state: 'failed', error: 'Boom.' })
    expect(v).toMatchObject({ finished: 'failed', error: '“b” failed: Boom.' })
  })

  it('waits on the approval card until it is answered, and remembers a no', () => {
    const actions = [{ nodeId: 'a', nodeName: 'A', kind: 'shell' as const, text: 'ls' }]
    const asking = run({ type: 'approval.requested', requestId: 'r1', actions })
    expect(asking.waiting).toEqual({ kind: 'approval', requestId: 'r1', actions })
    const no = run({ type: 'approval.requested', requestId: 'r1', actions }, { type: 'approval.resolved', requestId: 'r1', allow: false }, { type: 'run.cancelled' })
    expect(no).toMatchObject({ waiting: undefined, declined: true, finished: 'cancelled' })
    const yes = run({ type: 'approval.requested', requestId: 'r1', actions }, { type: 'approval.resolved', requestId: 'r1', allow: true })
    expect(yes).toMatchObject({ waiting: undefined, declined: false })
  })

  it('waits on the assistant’s own requests and questions', () => {
    const q = [{ header: 'H', question: 'Q?', multiSelect: false, options: [] }]
    expect(run({ type: 'agent.approval', nodeId: 'a', requestId: 'x', title: 'Run it', detail: 'ls' }).waiting).toEqual({ kind: 'agent-approval', requestId: 'x', nodeId: 'a', title: 'Run it', detail: 'ls' })
    expect(run({ type: 'agent.ask', nodeId: 'a', requestId: 'y', questions: q }).waiting).toMatchObject({ kind: 'ask', requestId: 'y' })
    expect(run({ type: 'agent.ask', nodeId: 'a', requestId: 'y', questions: q }, { type: 'agent.ask.answered', nodeId: 'a', requestId: 'y' }).waiting).toBeUndefined()
    expect(run({ type: 'agent.approval', nodeId: 'a', requestId: 'x', title: 'T' }, { type: 'agent.approval.resolved', nodeId: 'a', requestId: 'x', allow: true }).waiting).toBeUndefined()
  })

  it('ends with the result, or stops waiting when cancelled', () => {
    expect(run({ type: 'run.completed', output: 'All done' })).toMatchObject({ finished: 'completed', output: 'All done' })
    expect(run({ type: 'agent.ask', nodeId: 'a', requestId: 'y', questions: [] }, { type: 'run.cancelled' })).toMatchObject({ finished: 'cancelled', waiting: undefined })
  })

  it('reads stored events as well as plain ones', () => {
    expect(foldRun([{ seq: 1, at: 1, event: { type: 'run.completed', output: 'x' } }]).output).toBe('x')
  })
})
