import { describe, expect, it } from 'vitest'
import type { CorePush } from '@shared/api'
import type { SessionSummary } from '@shared/api'
import type { RunSummary } from '@shared/workflow'
import { Attention, type AttentionMessage } from './attention'

const session = (id: string, status: SessionSummary['status']): CorePush => ({
  type: 'summary',
  session: { id, vendor: 'claude', mode: 'chat', title: id, model: 'm', effort: null, approval: 'ask', status, createdAt: 1, updatedAt: 1, lastSeq: 0 }
})
const run = (id: string, status: RunSummary['status']): CorePush => ({
  type: 'run',
  run: { id, workflowId: 'wf', workflowName: 'Backup', version: 1, status, startedBy: 'you', inputs: {}, folder: '/f', startedAt: 1 }
})
const approval = (sessionId: string): CorePush => ({
  type: 'event',
  sessionId,
  stored: { seq: 1, at: 1, event: { type: 'approval.requested', requestId: 'req-1', kind: 'shell', title: 'Run npm test', detail: 'in /app' } }
})

function setup() {
  const out: AttentionMessage[] = []
  const a = new Attention((m) => out.push(m), (id) => (id === 'c1' ? 'Fix the tests' : undefined))
  return { a, out }
}

describe('Attention', () => {
  it('counts chats that are working or waiting, and says so only when the counts change', () => {
    const { a, out } = setup()
    a.observe(session('c1', 'working'))
    a.observe(session('c1', 'working'))
    a.observe(session('c2', 'waiting'))
    a.observe(session('c1', 'idle'))
    expect(out).toEqual([
      { type: 'attention', working: 1, waiting: 0 },
      { type: 'attention', working: 1, waiting: 1 },
      { type: 'attention', working: 0, waiting: 1 }
    ])
  })

  it('forgets a chat that was removed', () => {
    const { a, out } = setup()
    a.observe(session('c1', 'working'))
    a.observe({ type: 'removed', id: 'c1' })
    expect(out[out.length - 1]).toEqual({ type: 'attention', working: 0, waiting: 0 })
  })

  it('names the chat and what it asks when an approval is requested', () => {
    const { a, out } = setup()
    a.observe(approval('c1'))
    expect(out).toEqual([{ type: 'needs-you', id: 'req-1', kind: 'chat', target: 'c1', title: 'Fix the tests', text: 'Run npm test: in /app' }])
  })

  it('asks for a question the assistant put to the person', () => {
    const { a, out } = setup()
    a.observe({ type: 'event', sessionId: 'unknown', stored: { seq: 1, at: 1, event: { type: 'ask_user.requested', requestId: 'q-1', questions: [{ question: 'Which folder?', options: [] }] as never } } })
    expect(out[0]).toMatchObject({ type: 'needs-you', title: 'Celeste', text: 'Which folder?' })
  })

  it('counts workflow runs, and notices a run only when it starts to wait', () => {
    const { a, out } = setup()
    a.observe(run('r1', 'running'))
    a.observe(run('r1', 'waiting'))
    a.observe(run('r1', 'waiting'))
    a.observe(run('r1', 'completed'))
    expect(out.filter((m) => m.type === 'needs-you')).toHaveLength(1)
    expect(out.filter((m) => m.type === 'needs-you')[0]).toMatchObject({ kind: 'run', target: 'r1', title: 'Backup' })
    expect(out.filter((m) => m.type === 'attention')).toEqual([
      { type: 'attention', working: 1, waiting: 0 },
      { type: 'attention', working: 0, waiting: 1 },
      { type: 'attention', working: 0, waiting: 0 }
    ])
  })

  it('counts a command the assistant started in the background, whatever the chat is doing, until it ends', () => {
    const { a, out } = setup()
    const event = (e: CorePush & { type: 'event' }) => e
    const started: CorePush = event({ type: 'event', sessionId: 'c1', stored: { seq: 1, at: 1, event: { type: 'background.started', taskId: 'b1', title: 'Run the tests' } } })
    const finished = (status: 'completed' | 'failed' | 'stopped'): CorePush => ({ type: 'event', sessionId: 'c1', stored: { seq: 2, at: 2, event: { type: 'background.finished', taskId: 'b1', status, summary: 'Completed (exit code 0)' } } })
    a.observe(started)
    expect(out).toEqual([{ type: 'attention', working: 1, waiting: 0 }])
    a.observe(session('c1', 'idle'))
    expect(out).toHaveLength(1)
    a.observe(finished('completed'))
    expect(out.slice(1)).toEqual([
      { type: 'finished', id: 'bg-c1-b1', target: 'c1', title: 'Fix the tests', text: 'Completed (exit code 0)' },
      { type: 'attention', working: 0, waiting: 0 }
    ])
  })

  it('does not announce a command the person stopped, or one it never saw start, and forgets a removed chat', () => {
    const { a, out } = setup()
    const started = (session: string, taskId: string): CorePush => ({ type: 'event', sessionId: session, stored: { seq: 1, at: 1, event: { type: 'background.started', taskId, title: 't' } } })
    const finished = (session: string, taskId: string, status: 'completed' | 'stopped'): CorePush => ({ type: 'event', sessionId: session, stored: { seq: 2, at: 2, event: { type: 'background.finished', taskId, status, summary: 's' } } })
    a.observe(started('c1', 'b1'))
    a.observe(finished('c1', 'b1', 'stopped'))
    a.observe(finished('c1', 'never', 'completed'))
    expect(out.filter((m) => m.type === 'finished')).toEqual([])
    a.observe(started('c2', 'b2'))
    a.observe({ type: 'removed', id: 'c2' })
    expect(out[out.length - 1]).toEqual({ type: 'attention', working: 0, waiting: 0 })
  })

  it('ignores pushes that do not matter', () => {
    const { a, out } = setup()
    a.observe({ type: 'phone' })
    expect(out).toEqual([])
  })
})
