import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import type { LogEvent, SessionStatus, StoredEvent } from '@shared/api'
import { nextStatus } from '@shared/status'
import { createMockSession } from '@core/testing/engine'
import { foldEvents, reduceEvent } from './reduce'
import type { Session } from './types'

const blank = (over: Partial<Session> = {}): Session => ({
  id: 's',
  vendor: 'copilot',
  mode: 'chat',
  title: 'T',
  model: 'copilot-auto',
  effort: null,
  approval: 'auto',
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  lastSeq: 0,
  items: [],
  activity: null,
  loaded: true,
  foldedSeq: 0,
  queue: { items: [], paused: false },
  ...over
})

const log = (...events: [number, LogEvent][]): StoredEvent[] => events.map(([at, event], i) => ({ seq: i + 1, at, event }))

describe('replaying a log', () => {
  it('rebuilds how long the assistant thought and how long a tool ran from the recorded times', () => {
    const s = foldEvents(
      blank(),
      log(
        [1000, { type: 'user.message', text: 'hi', attachments: [] }],
        [1100, { type: 'turn.started', turnId: 't' }],
        [1200, { type: 'thinking.delta', text: 'Hmm' }],
        [5200, { type: 'tool.started', id: 'x', kind: 'shell', title: 'npm test' }],
        [9200, { type: 'tool.completed', id: 'x', ok: true }],
        [9300, { type: 'message.delta', text: 'Done.' }],
        [9400, { type: 'turn.completed', turnId: 't' }]
      )
    )
    const thinking = s.items.find((i) => i.kind === 'thinking')
    const tool = s.items.find((i) => i.kind === 'tool')
    expect(thinking && thinking.kind === 'thinking' && (thinking.endedAt as number) - thinking.startedAt).toBe(4000)
    expect(tool && tool.kind === 'tool' && (tool.endedAt as number) - tool.startedAt).toBe(4000)
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'assistant'])
    expect(s).toMatchObject({ status: 'idle', activity: null, foldedSeq: 7, lastSeq: 7, updatedAt: 9400 })
  })

  it('moves a session in the list only for the person’s message and the end of a turn, never for tokens', () => {
    const fold = (s: Session, at: number, event: LogEvent, seq: number) => foldEvents(s, [{ seq, at, event }])
    let s = blank({ updatedAt: 500 })
    s = fold(s, 1000, { type: 'user.message', text: 'hi', attachments: [] }, 1)
    expect(s.updatedAt).toBe(1000)
    s = fold(s, 1100, { type: 'turn.started', turnId: 't' }, 2)
    s = fold(s, 1200, { type: 'thinking.delta', text: 'hm' }, 3)
    s = fold(s, 1300, { type: 'message.delta', text: 'a' }, 4)
    s = fold(s, 1400, { type: 'tool.started', id: 'x', kind: 'shell', title: 'ls' }, 5)
    s = fold(s, 1500, { type: 'tool.completed', id: 'x', ok: true }, 6)
    s = fold(s, 1600, { type: 'message.delta', text: 'b' }, 7)
    expect(s.updatedAt).toBe(1000)
    s = fold(s, 1700, { type: 'turn.completed', turnId: 't' }, 8)
    expect(s.updatedAt).toBe(1700)
  })

  it('skips what it has already seen, so a log and live events can overlap safely', () => {
    const events = log(
      [1, { type: 'user.message', text: 'a', attachments: [] }],
      [2, { type: 'turn.started', turnId: 't' }],
      [3, { type: 'message.delta', text: 'x' }]
    )
    const once = foldEvents(blank(), events)
    const twice = foldEvents(once, events)
    expect(twice).toBe(once)
    const more = foldEvents(once, [...events, { seq: 4, at: 4, event: { type: 'message.delta', text: 'y' } }])
    expect(more.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'xy' })
  })

  it('shows what you answered on approval and question cards', () => {
    const s = foldEvents(
      blank(),
      log(
        [1, { type: 'approval.requested', requestId: 'r', kind: 'edit', title: 'Edit files' }],
        [2, { type: 'approval.resolved', requestId: 'r', allow: true }],
        [3, { type: 'ask_user.requested', requestId: 'q', questions: [] }],
        [4, { type: 'ask.answered', requestId: 'q', answers: { Scope: 'Staging' } }]
      )
    )
    expect(s.items[0]).toMatchObject({ kind: 'approval', status: 'allowed' })
    expect(s.items[1]).toMatchObject({ kind: 'ask', status: 'answered', answers: { Scope: 'Staging' } })
  })

  it('closes a question nobody answered when the turn is stopped, so it does not keep asking', () => {
    const s = foldEvents(
      blank(),
      log(
        [1, { type: 'ask_user.requested', requestId: 'q', questions: [{ header: 'Scope', question: 'Which scope?', options: [], multiSelect: false }] }],
        [2, { type: 'ask_user.requested', requestId: 'q2', questions: [] }],
        [3, { type: 'ask.answered', requestId: 'q2', answers: {} }],
        [4, { type: 'turn.interrupted', turnId: 't' }]
      )
    )
    expect(s.items[0]).toMatchObject({ kind: 'ask', requestId: 'q', status: 'skipped' })
    // One that was answered stays as it was.
    expect(s.items[1]).toMatchObject({ kind: 'ask', requestId: 'q2', status: 'answered' })
    expect(s.status).toBe('idle')
  })

  it('keeps the words of a question that can be answered for now or for good, and none on one that cannot', () => {
    const choices = { allow: 'Allow for this chat', always: 'Always allow shop.test' }
    const s = foldEvents(
      blank(),
      log(
        [1, { type: 'approval.requested', requestId: 'tool-a', kind: 'web', title: 'Let the assistant use shop.test', choices }],
        [2, { type: 'approval.requested', requestId: 'r', kind: 'edit', title: 'Edit files' }]
      )
    )
    expect(s.items[0]).toMatchObject({ kind: 'approval', status: 'pending', choices })
    expect(s.items[1]).not.toHaveProperty('choices')
  })

  it('closes a card nobody answered when the response is stopped, so it does not keep asking', () => {
    const s = foldEvents(
      blank(),
      log(
        [1, { type: 'approval.requested', requestId: 'tool-a', kind: 'other', title: 'Save “Backup”' }],
        [2, { type: 'approval.requested', requestId: 'r', kind: 'edit', title: 'Edit files' }],
        [3, { type: 'approval.resolved', requestId: 'r', allow: true }],
        [4, { type: 'turn.interrupted', turnId: 't' }]
      )
    )
    expect(s.items.filter((i) => i.kind === 'approval').map((i) => (i.kind === 'approval' ? i.status : ''))).toEqual(['denied', 'allowed'])
  })

  it('keeps a proposal on its card, and tells Try again from a no', () => {
    const proposal = { kind: 'workflow' as const, payload: { name: 'Backup', description: '', steps: [], inputs: [], notes: [] }, accept: 'Save', retry: 'Try again' }
    const s = foldEvents(
      blank(),
      log(
        [1, { type: 'approval.requested', requestId: 'tool-a', kind: 'other', title: 'Save “Backup”', detail: 'Backup: Zip', proposal }],
        [2, { type: 'approval.requested', requestId: 'tool-b', kind: 'other', title: 'Save “Backup”', detail: 'Backup: Zip', proposal }],
        [3, { type: 'approval.requested', requestId: 'tool-c', kind: 'other', title: 'Save “Backup”', detail: 'Backup: Zip', proposal }],
        [4, { type: 'approval.resolved', requestId: 'tool-a', allow: false, again: true }],
        [5, { type: 'approval.resolved', requestId: 'tool-b', allow: false }]
      )
    )
    expect(s.items[0]).toMatchObject({ kind: 'approval', status: 'retried', proposal })
    expect(s.items[1]).toMatchObject({ kind: 'approval', status: 'denied', proposal })
    expect(s.items[2]).toMatchObject({ kind: 'approval', status: 'pending', proposal })
  })

  it('tells you that a turn was cut off by a restart, and stops its spinners', () => {
    const s = foldEvents(
      blank(),
      log(
        [1, { type: 'turn.started', turnId: 't' }],
        [2, { type: 'thinking.delta', text: 'working' }],
        [3, { type: 'tool.started', id: 'x', kind: 'shell', title: 'build' }],
        [4, { type: 'turn.abandoned' }]
      )
    )
    const tool = s.items.find((i) => i.kind === 'tool')
    expect(tool && tool.kind === 'tool' && tool.status).toBe('failed')
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice' })
    expect(s).toMatchObject({ status: 'idle', activity: null })
  })
})

describe('the status Core keeps for the sidebar', () => {
  const samples: LogEvent[] = [
    { type: 'user.message', text: 'x', attachments: [] },
    { type: 'turn.started', turnId: 't' },
    { type: 'thinking.delta', text: 'x' },
    { type: 'message.delta', text: 'x' },
    { type: 'tool.started', id: 't', kind: 'read', title: 'Read a' },
    { type: 'tool.output', id: 't', text: 'x' },
    { type: 'tool.completed', id: 't', ok: true },
    { type: 'approval.requested', requestId: 'r', kind: 'edit', title: 'e' },
    { type: 'approval.resolved', requestId: 'r', allow: false },
    { type: 'ask_user.requested', requestId: 'q', questions: [] },
    { type: 'ask.answered', requestId: 'q', answers: {} },
    { type: 'usage.updated', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'turn.completed', turnId: 't' },
    { type: 'turn.interrupted', turnId: 't' },
    { type: 'turn.failed', turnId: 't', error: { code: 'unknown', message: 'x', retryable: false } },
    { type: 'turn.abandoned' },
    { type: 'child.started', childId: 'c', title: 'T', vendor: 'claude', model: 'm', task: 't', folder: 'same', wait: true },
    { type: 'child.finished', childId: 'c', title: 'T', status: 'done', delivered: 'tool' },
    { type: 'child.spawned', parentId: 'p', parentTitle: 'P' },
    { type: 'user.message', text: 'x', attachments: [], from: 'moon' },
    { type: 'moons.turn', seat: 0, step: 'build' },
    { type: 'moons.handed', from: 0, to: 1, what: '2 files' },
    { type: 'moons.said', seat: 1, id: 'm1', text: 'x', finding: true },
    { type: 'moons.fixed', ids: ['m1'] },
    { type: 'moons.plan', id: 'p1', say: 'x', steps: ['a'] },
    { type: 'moons.agreed', id: 'p1' },
    { type: 'moons.compared', both: [], first: [], second: [] },
    { type: 'moons.ended', why: 'agreed' }
  ]

  it('draws nothing for what Celeste tells the pen on behalf of the other moon', () => {
    const s = foldEvents(blank(), [{ seq: 1, at: 1000, event: { type: 'user.message', text: 'Fix these notes', attachments: [], from: 'moon' } }])
    expect(s.items).toEqual([])
  })

  it('agrees with the window for every kind of event, from every starting status', () => {
    for (const prev of ['idle', 'working', 'waiting'] as SessionStatus[]) {
      for (const event of samples) {
        // Start from a state the event makes sense in.
        const start = blank({ status: prev, items: [{ kind: 'tool', id: 't', tool: 'read', title: 'Read a', output: '', status: 'running', startedAt: 0 }] })
        expect(reduceEvent(start, event, 10).status, `${prev} + ${event.type}`).toBe(nextStatus(prev, event))
      }
    }
  })
})

describe('the scripted assistant, end to end', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('produces a log that replays into the finished conversation', async () => {
    const agent = createMockSession({ mode: 'develop', getApproval: () => 'auto' })
    const events: AgentEvent[] = []
    void (async () => {
      for await (const e of agent.events) events.push(e)
    })()
    agent.send({ text: 'Add input validation to the login form', attachments: [] })
    for (let i = 0; i < 400 && !events.some((e) => e.type === 'turn.completed'); i++) await vi.advanceTimersByTimeAsync(250)
    expect(events.at(-1)?.type).toBe('turn.completed')

    const stored = events.map((event, i): StoredEvent => ({ seq: i + 1, at: 1_000 + i * 50, event }))
    const s = foldEvents(blank({ mode: 'develop' }), stored)
    expect(s.status).toBe('idle')
    expect(s.items.some((i) => i.kind === 'tool' && i.tool === 'edit' && i.diff?.length)).toBe(true)
    expect(s.items.at(-1)?.kind).toBe('assistant')
    // Replaying one event at a time, as live pushes do, ends in exactly the same place.
    const live = stored.reduce((acc, e) => foldEvents(acc, [e]), blank({ mode: 'develop' }))
    expect(live.items.map((i) => i.kind)).toEqual(s.items.map((i) => i.kind))
    expect(live.status).toBe(s.status)
    await agent.close()
  })
})

describe('checkpoints in the log', () => {
  const ID = 'a'.repeat(40)
  const files = [{ path: 'a.txt', status: 'modified' as const, added: 2, removed: 1 }]

  it('puts a checkpoint on the message it came right after, and what the turn changed under it', () => {
    const s = foldEvents(
      blank({ mode: 'develop' }),
      log(
        [1000, { type: 'user.message', text: 'one', attachments: [] }],
        [1010, { type: 'checkpoint.created', id: ID }],
        [1020, { type: 'turn.completed', turnId: 't' }],
        [1030, { type: 'checkpoint.summary', id: ID, files, more: 3 }],
        [2000, { type: 'user.message', text: 'two', attachments: [] }]
      )
    )
    const [one, two] = s.items
    expect(one).toMatchObject({ kind: 'user', text: 'one', checkpoint: { id: ID, files, more: 3 } })
    expect(two).toMatchObject({ kind: 'user', text: 'two' })
    expect((two as { checkpoint?: unknown }).checkpoint).toBeUndefined()
  })

  it('shows a skipped checkpoint as a notice, and a revert as its own item with what to undo it with', () => {
    const s = foldEvents(
      blank({ mode: 'develop' }),
      log(
        [1000, { type: 'user.message', text: 'one', attachments: [] }],
        [1010, { type: 'checkpoint.skipped', reason: 'Git was not found.' }],
        [2000, { type: 'checkpoint.reverted', id: ID, restored: 2, removed: 1, undoId: 'b'.repeat(40) }]
      )
    )
    expect(s.items[1]).toMatchObject({ kind: 'notice' })
    expect((s.items[1] as { text: string }).text).toMatch(/cannot be reverted. Git was not found/)
    expect(s.items[2]).toMatchObject({ kind: 'reverted', restored: 2, removed: 1, undoId: 'b'.repeat(40) })
  })

  it('ignores an event it does not know, so a newer computer cannot blank a chat in an older app', () => {
    const future = { type: 'something.from.a.newer.version', value: 1 } as unknown as LogEvent
    const before = foldEvents(blank(), log([1000, { type: 'user.message', text: 'hello', attachments: [] }], [1010, { type: 'message.delta', text: 'Hi' }]))
    expect(reduceEvent(before, future, 1)).toBe(before)
    // In the middle of a log: what came before and after is kept, and the position moves on past it.
    const s = foldEvents(blank(), log([1000, { type: 'user.message', text: 'hello', attachments: [] }], [1010, future], [1020, { type: 'message.delta', text: 'Hi' }], [1030, { type: 'turn.completed', turnId: 't' }]))
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'assistant'])
    expect(s.status).toBe('idle')
    expect(s.foldedSeq).toBe(4)
    expect(s.lastSeq).toBe(4)
  })

  it('shows a vendor at its limit as one line with when it comes back, and holds the queue it was told to', () => {
    const at = new Date(2026, 10, 17, 12, 0).getTime()
    const s = foldEvents(
      blank(),
      log(
        [at, { type: 'queue.added', id: 'a', text: 'two', attachments: [] }],
        [at + 1, { type: 'limit.hit', vendor: 'claude', resetsAt: at + 2 * 3_600_000, window: '5-hour session' }],
        [at + 2, { type: 'queue.waiting', until: at + 2 * 3_600_000 }]
      )
    )
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice' })
    expect((s.items.at(-1) as { text: string }).text).toContain('Claude is at its limit (5-hour session). It comes back in 2 h')
    expect(s.queue).toMatchObject({ paused: true, waitUntil: at + 2 * 3_600_000 })
  })

  it('shows what the assistant changed in Celeste as one line, and leaves the status alone', () => {
    const s = foldEvents(blank(), log([1000, { type: 'user.message', text: 'dark please', attachments: [] }], [1010, { type: 'app.changed', text: 'The theme was changed to dark.' }]))
    expect(s.items[1]).toMatchObject({ kind: 'notice', text: 'The theme was changed to dark.' })
    for (const status of ['idle', 'working', 'waiting'] as SessionStatus[]) expect(nextStatus(status, { type: 'app.changed', text: 'x' })).toBe(status)
  })

  it('does not change the session’s status, which the sidebar keeps from the same events', () => {
    const events: LogEvent[] = [
      { type: 'checkpoint.created', id: ID },
      { type: 'checkpoint.summary', id: ID, files: [], more: 0 },
      { type: 'checkpoint.skipped', reason: 'x' },
      { type: 'checkpoint.reverted', id: ID, restored: 0, removed: 0, undoId: ID }
    ]
    for (const status of ['idle', 'working', 'waiting'] as SessionStatus[]) {
      for (const e of events) expect(nextStatus(status, e)).toBe(status)
      expect(reduceEvent(blank({ status, activity: null }), events[1] as LogEvent, 1).status).toBe(status)
    }
  })

  it('ignores a summary for a checkpoint it has never seen', () => {
    const s = foldEvents(blank(), log([1000, { type: 'checkpoint.summary', id: ID, files, more: 0 }]))
    expect(s.items).toEqual([])
  })
})

describe('workflows started from a conversation', () => {
  it('shows one card where it started, and the end of the run adds nothing of its own', () => {
    const s = foldEvents(
      blank(),
      log(
        [1000, { type: 'workflow.started', runId: 'r1', workflowId: 'w1', name: 'Test the app' }],
        [2000, { type: 'workflow.finished', runId: 'r1', name: 'Test the app', status: 'completed', output: 'done' }]
      )
    )
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ kind: 'workflow', runId: 'r1', workflowId: 'w1', name: 'Test the app' })
  })
})

describe('files a chat made', () => {
  it('shows them as one entry after the answer, with how many more were not listed', () => {
    const made = [{ path: 'report.csv', size: 4, status: 'added' as const }]
    const s = foldEvents(
      blank(),
      log(
        [1000, { type: 'message.delta', text: 'Done.' }],
        [1100, { type: 'turn.completed', turnId: 't' }],
        [1200, { type: 'files.produced', files: made, more: 2 }]
      )
    )
    expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'files'])
    expect(s.items[1]).toMatchObject({ kind: 'files', files: made, more: 2 })
  })
})

describe('files added to a message', () => {
  it('keeps the paths on the message, and nothing when there are none', () => {
    const s = foldEvents(
      blank({ mode: 'develop' }),
      log(
        [1000, { type: 'user.message', text: 'look at these', attachments: [], context: [{ path: 'src/a.ts', kind: 'file' }, { path: 'docs', kind: 'dir' }] }],
        [2000, { type: 'user.message', text: 'and nothing here', attachments: [] }]
      )
    )
    expect(s.items[0]).toMatchObject({ kind: 'user', context: [{ path: 'src/a.ts', kind: 'file' }, { path: 'docs', kind: 'dir' }] })
    expect((s.items[1] as { context?: unknown }).context).toBeUndefined()
  })
})

describe('the prompt queue in the log', () => {
  it('lists waiting messages in order, with edits, and drops one when it is sent or removed', () => {
    const s = foldEvents(
      blank(),
      log(
        [1, { type: 'queue.added', id: 'a', text: 'first', attachments: [] }],
        [2, { type: 'queue.added', id: 'b', text: 'second', attachments: [], model: 'm' }],
        [3, { type: 'queue.added', id: 'c', text: 'third', attachments: [] }],
        [4, { type: 'queue.edited', id: 'b', text: 'second, edited' }],
        [5, { type: 'queue.sent', id: 'a' }],
        [6, { type: 'queue.removed', id: 'c' }]
      )
    )
    expect(s.queue).toEqual({ paused: false, items: [{ id: 'b', text: 'second, edited', attachments: [], model: 'm' }] })
  })

  it('holds the queue when paused and forgets that once it is empty', () => {
    const add: [number, LogEvent] = [1, { type: 'queue.added', id: 'a', text: 'x', attachments: [] }]
    expect(foldEvents(blank(), log(add, [2, { type: 'queue.paused' }])).queue.paused).toBe(true)
    expect(foldEvents(blank(), log(add, [2, { type: 'queue.paused' }], [3, { type: 'queue.resumed' }])).queue.paused).toBe(false)
    expect(foldEvents(blank(), log(add, [2, { type: 'queue.paused' }], [3, { type: 'queue.sent', id: 'a' }])).queue).toEqual({ paused: false, items: [] })
  })
})

describe('commands that go on after the turn', () => {
  it('shows a card that follows the command to its end, and the answer of the turn that follows', () => {
    const s = foldEvents(
      blank(),
      log(
        [1000, { type: 'user.message', text: 'run the tests', attachments: [] }],
        [1100, { type: 'turn.started', turnId: 't' }],
        [1200, { type: 'background.started', taskId: 'b1', title: 'Run the tests', command: 'npm test' }],
        [1300, { type: 'turn.completed', turnId: 't' }],
        [6300, { type: 'turn.started', turnId: 'bg-1' }],
        [6310, { type: 'background.finished', taskId: 'b1', status: 'completed', summary: 'Completed (exit code 0)' }],
        [6400, { type: 'message.delta', text: 'The tests passed.' }],
        [6500, { type: 'turn.completed', turnId: 'bg-1' }]
      )
    )
    const card = s.items.find((i) => i.kind === 'background')
    expect(card).toMatchObject({ taskId: 'b1', title: 'Run the tests', command: 'npm test', status: 'completed', summary: 'Completed (exit code 0)', startedAt: 1200, endedAt: 6310 })
    expect(s.items.filter((i) => i.kind === 'background')).toHaveLength(1)
    expect(s.items.some((i) => i.kind === 'assistant' && i.text === 'The tests passed.')).toBe(true)
    expect(s.status).toBe('idle')
  })

  it('does not change what the chat is doing, and does not add a card twice', () => {
    const working = blank({ status: 'working' })
    const started = reduceEvent(working, { type: 'background.started', taskId: 'b1', title: 'x' }, 1)
    expect(started.status).toBe('working')
    expect(reduceEvent(started, { type: 'background.started', taskId: 'b1', title: 'x' }, 2).items).toHaveLength(1)
    expect(nextStatus('idle', { type: 'background.finished', taskId: 'b1', status: 'completed', summary: 'x' })).toBe('idle')
  })

  it('keeps where the output is, from the event that names it or from the end', () => {
    const started = reduceEvent(blank(), { type: 'background.started', taskId: 'b1', title: 'x' }, 1)
    const named = reduceEvent(started, { type: 'background.output', taskId: 'b1', outputFile: '/a/tasks/b1.output' }, 2)
    expect(named.items[0]).toMatchObject({ kind: 'background', outputFile: '/a/tasks/b1.output', status: 'running' })
    const ended = reduceEvent(named, { type: 'background.finished', taskId: 'b1', status: 'completed', summary: 'done' }, 3)
    expect(ended.items[0]).toMatchObject({ status: 'completed', outputFile: '/a/tasks/b1.output' })
    expect(reduceEvent(blank(), { type: 'background.finished', taskId: 'z', status: 'failed', summary: 's', outputFile: '/a/tasks/z.output' }, 1).items[0]).toMatchObject({ outputFile: '/a/tasks/z.output' })
  })

  it('makes a card from the end alone when the start was not seen', () => {
    const s = reduceEvent(blank(), { type: 'background.finished', taskId: 'z', status: 'failed', summary: 'Failed with exit code 1' }, 5)
    expect(s.items[0]).toMatchObject({ kind: 'background', taskId: 'z', status: 'failed', title: 'Failed with exit code 1' })
  })
})

describe('helpers (docs/plans/SUB_AGENTS_PLAN.md)', () => {
  const started = (over: Partial<Extract<LogEvent, { type: 'child.started' }>> = {}): LogEvent => ({ type: 'child.started', childId: 'c1', title: 'Reader', vendor: 'claude', model: 'claude:sonnet', task: 'Read the logs', folder: 'same', wait: true, ...over })
  const finished = (over: Partial<Extract<LogEvent, { type: 'child.finished' }>> = {}): LogEvent => ({ type: 'child.finished', childId: 'c1', title: 'Reader', status: 'done', result: 'Found it.', delivered: 'tool', ...over })

  it('shows one card for a helper, which the end of its work fills in, and a status that does not move', () => {
    const s = foldEvents(blank({ status: 'working' }), log([1000, started()], [2000, finished()]))
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ kind: 'helper', childId: 'c1', title: 'Reader', vendor: 'claude', model: 'claude:sonnet', folder: 'same', tasks: ['Read the logs'], wait: true, startedAt: 1000, finished: { status: 'done', result: 'Found it.', delivered: 'tool', endedAt: 2000 } })
    expect(s.status).toBe('working')
    expect(s.activity).toBeNull()
  })

  it('gives a helper that is asked for more work a line on the same card, open again', () => {
    const s = foldEvents(blank(), log([1000, started()], [2000, finished()], [3000, started({ task: 'And the cache', again: true, wait: false })]))
    expect(s.items).toHaveLength(1)
    const card = s.items[0] as Extract<Session['items'][number], { kind: 'helper' }>
    expect(card.tasks).toEqual(['Read the logs', 'And the cache'])
    expect(card.finished).toBeUndefined()
    expect(card).toMatchObject({ wait: false, startedAt: 3000 })
    // Two helpers are two cards.
    const two = foldEvents(s, log([4000, started({ childId: 'c2', title: 'Writer' })]).map((e) => ({ ...e, seq: 10 })))
    expect(two.items.map((i) => i.kind)).toEqual(['helper', 'helper'])
  })

  it('says the assistant was told once a message follows an answer that came as a note, and not before', () => {
    const before = foldEvents(blank(), log([1000, started({ wait: false })], [2000, finished({ delivered: 'note' })]))
    expect((before.items[0] as { told?: boolean }).told).toBeUndefined()
    const woken = foldEvents(before, [{ seq: 3, at: 3000, event: { type: 'user.message', text: 'Helpers finished: “Reader”.', attachments: [], from: 'celeste' } }])
    expect((woken.items[0] as { told?: boolean }).told).toBe(true)
    // The wake is one quiet line, not a message of the person's.
    expect(woken.items.map((i) => i.kind)).toEqual(['helper', 'notice'])
    expect((woken.items[1] as { text: string }).text).toBe('Helpers finished: “Reader”. The assistant was told.')
    // An answer the tool call returned needs no such line.
    const byTool = foldEvents(blank(), log([1000, started()], [2000, finished()], [3000, { type: 'user.message', text: 'Thanks', attachments: [] }]))
    expect((byTool.items[0] as { told?: boolean }).told).toBeUndefined()
    // A person's message tells it too, and an answer handed over later by the tool takes the note's place.
    const person = foldEvents(before, [{ seq: 3, at: 3000, event: { type: 'user.message', text: 'And now?', attachments: [] } }])
    expect((person.items[0] as { told?: boolean }).told).toBe(true)
    const replaced = foldEvents(before, [{ seq: 3, at: 3000, event: finished({ delivered: 'tool' }) }])
    expect((replaced.items[0] as { finished: { delivered: string } }).finished.delivered).toBe('tool')
  })

  it('draws a helper’s first message as the parent’s, and its top as a banner', () => {
    const s = foldEvents(
      blank(),
      log([1000, { type: 'child.spawned', parentId: 'p1', parentTitle: 'Plan the launch' }], [1010, { type: 'user.message', text: 'Read the logs', attachments: [], from: 'parent' }], [1020, { type: 'user.message', text: 'Also the cache', attachments: [] }])
    )
    expect(s.items.map((i) => i.kind)).toEqual(['spawned', 'user', 'user'])
    expect(s.items[0]).toMatchObject({ kind: 'spawned', parentId: 'p1', parentTitle: 'Plan the launch' })
    expect(s.items[1]).toMatchObject({ kind: 'user', from: 'parent', text: 'Read the logs' })
    expect(s.items[2]).not.toHaveProperty('from')
  })

  it('a card for a helper that ended without being seen start is not made from the end alone', () => {
    // The end of work for a helper whose start was never seen changes nothing: there is no card to fill in.
    const s = foldEvents(blank(), log([1000, finished({ childId: 'ghost' })]))
    expect(s.items).toEqual([])
  })
})

describe('Two Moons in the log', () => {
  const moons = { pattern: 'build' as const, childId: 'c1' }
  const said = (id: string, seat: 0 | 1, text: string, more: Partial<Extract<LogEvent, { type: 'moons.said' }>> = {}): LogEvent => ({ type: 'moons.said', seat, id, text, ...more })
  const kinds = (s: Session) => s.items.map((i) => i.kind)

  it('names the moon and what it does, and remembers whose turn it is until the run ends', () => {
    let s = foldEvents(blank({ moons }), log([1000, { type: 'moons.turn', seat: 1, step: 'review' }]))
    expect(s.status).toBe('working')
    expect(s.activity).toEqual({ label: 'Reviewer is checking the change', working: true })
    expect(s.moonsTurn).toEqual({ seat: 1, step: 'review' })
    s = foldEvents(s, [{ seq: 2, at: 2000, event: { type: 'moons.ended', why: 'agreed' } }])
    expect(s).toMatchObject({ status: 'idle', activity: null })
    expect(s.moonsTurn).toBeUndefined()
    // Without the pattern it still works, with a plain line.
    expect(reduceEvent(blank(), { type: 'moons.turn', seat: 0, step: 'build' }, 1).activity?.label).toBe('Working together')
  })

  it('names two moons of one role by their numbers', () => {
    const s = reduceEvent(blank({ moons: { pattern: 'reviews', childId: 'c1' } }), { type: 'moons.turn', seat: 1, step: 'review' }, 1)
    expect(s.activity?.label).toBe('Reviewer 2 is checking the change')
  })

  it('draws a hand-over, and joins consecutive messages into one block', () => {
    const s = foldEvents(
      blank({ moons }),
      log(
        [1000, { type: 'moons.handed', from: 0, to: 1, what: '2 files' }],
        [1100, said('a', 1, 'The loop never ends.', { finding: true, file: 'src/a.ts', line: 4, code: 'while (true)' })],
        [1200, said('b', 1, 'Nothing checks the empty list.', { finding: true })],
        [1300, said('c', 0, 'I will look at both.')]
      )
    )
    expect(kinds(s)).toEqual(['moonsHand', 'moonsTalk'])
    const talk = s.items[1]
    expect(talk.kind === 'moonsTalk' && talk.messages.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(talk.kind === 'moonsTalk' && talk.messages[0]).toEqual({ id: 'a', seat: 1, text: 'The loop never ends.', file: 'src/a.ts', line: 4, code: 'while (true)', finding: true, at: 1100 })
  })

  it('closes a block when anything else is drawn, and marks fixed notes in an earlier block', () => {
    const s = foldEvents(
      blank({ moons }),
      log(
        [1000, said('a', 1, 'Note one', { finding: true })],
        [1100, { type: 'message.delta', text: 'Fixing.' }],
        [1200, said('b', 0, 'Done')],
        [1300, { type: 'moons.fixed', ids: ['a'] }]
      )
    )
    expect(kinds(s)).toEqual(['moonsTalk', 'assistant', 'moonsTalk'])
    const first = s.items[0]
    const second = s.items[2]
    expect(first.kind === 'moonsTalk' && first.messages[0].fixed).toBe(true)
    expect(second.kind === 'moonsTalk' && second.messages[0].fixed).toBeUndefined()
  })

  it('leaves an item alone when a fix does not concern it, so its card is not drawn again', () => {
    const before = foldEvents(blank({ moons }), log([1000, said('a', 1, 'x', { finding: true })]))
    const after = reduceEvent(before, { type: 'moons.fixed', ids: ['zzz'] }, 2)
    expect(after.items[0]).toBe(before.items[0])
  })

  it('shows the plan and marks it agreed', () => {
    const s = foldEvents(blank({ moons }), log([1000, { type: 'moons.plan', id: 'p1', say: 'Here it is.', steps: ['One', 'Two'] }]))
    expect(s.items[0]).toMatchObject({ kind: 'moonsPlan', planId: 'p1', say: 'Here it is.', steps: ['One', 'Two'] })
    expect(s.items[0]).not.toHaveProperty('agreed')
    const agreed = foldEvents(s, [{ seq: 2, at: 2000, event: { type: 'moons.agreed', id: 'p1' } }])
    expect(agreed.items[0]).toMatchObject({ agreed: true })
    // Another plan's agreement changes nothing.
    expect(reduceEvent(s, { type: 'moons.agreed', id: 'other' }, 3).items[0]).toEqual(s.items[0])
  })

  it('shows what two reviews found, also that neither found anything', () => {
    const f = { text: 'Off by one', file: 'a.ts', line: 3 }
    const s = foldEvents(blank(), log([1000, { type: 'moons.compared', both: [f], first: [], second: [{ text: 'Typo' }] }]))
    expect(s.items[0]).toMatchObject({ kind: 'moonsCompare', both: [f], first: [], second: [{ text: 'Typo' }] })
    expect(foldEvents(blank(), log([1000, { type: 'moons.compared', both: [], first: [], second: [] }])).items).toMatchObject([{ kind: 'moonsCompare', both: [], first: [], second: [] }])
  })

  it('draws a line for the ends that need one, and none for a good or empty end', () => {
    const end = (e: Extract<LogEvent, { type: 'moons.ended' }>) => foldEvents(blank({ moons }), log([1000, e])).items
    expect(end({ type: 'moons.ended', why: 'agreed' })).toEqual([])
    expect(end({ type: 'moons.ended', why: 'nothing' })).toEqual([])
    expect(end({ type: 'moons.ended', why: 'agreed', note: 'It did not fail.' })[0]).toMatchObject({ kind: 'moonsEnded', why: 'agreed', note: 'It did not fail.' })
    expect(end({ type: 'moons.ended', why: 'rounds', left: 2 })[0]).toMatchObject({ kind: 'moonsEnded', why: 'rounds', left: 2 })
    for (const why of ['declined', 'stopped', 'failed', 'unread'] as const) expect(end({ type: 'moons.ended', why })[0]).toMatchObject({ kind: 'moonsEnded', why })
  })

  it('lets go of a card nobody answered when the run ends, as Stop does', () => {
    const s = foldEvents(
      blank({ moons }),
      log(
        [1000, { type: 'moons.plan', id: 'p1', say: 'x', steps: ['a'] }],
        [1100, { type: 'approval.requested', requestId: 'r', kind: 'other', title: 'Build it this way' }],
        [1200, { type: 'moons.ended', why: 'stopped' }]
      )
    )
    expect(s.items.find((i) => i.kind === 'approval')).toMatchObject({ status: 'denied' })
    expect(s.status).toBe('idle')
  })

  it('forgets whose turn it was when Celeste was closed', () => {
    const s = foldEvents(blank({ moons }), log([1000, { type: 'moons.turn', seat: 0, step: 'build' }], [1100, { type: 'turn.abandoned' }]))
    expect(s.moonsTurn).toBeUndefined()
    expect(s.status).toBe('idle')
  })

  it('ends in the same place when replayed all at once or one event at a time, and ignores a repeat', () => {
    const events = log(
      [1000, { type: 'user.message', text: 'Build it', attachments: [] }],
      [1100, { type: 'moons.turn', seat: 0, step: 'build' }],
      [1200, { type: 'moons.handed', from: 0, to: 1, what: '1 file' }],
      [1300, { type: 'moons.turn', seat: 1, step: 'review' }],
      [1400, said('a', 1, 'Bug', { finding: true })],
      [1500, { type: 'moons.fixed', ids: ['a'] }],
      [1600, { type: 'moons.ended', why: 'rounds', left: 1 }]
    )
    const strip = (s: Session) => ({ ...s, items: s.items.map(({ id: _id, ...rest }) => rest) })
    const whole = foldEvents(blank({ moons }), events)
    const live = events.reduce((acc, e) => foldEvents(acc, [e]), blank({ moons }))
    expect(strip(live)).toEqual(strip(whole))
    expect(foldEvents(whole, events)).toBe(whole)
    // The same message arriving twice is shown once.
    expect(kinds(reduceEvent(whole, said('a', 1, 'Bug'), 9))).toEqual(kinds(whole))
  })

  it('does not change a chat that has no moons', () => {
    const events = log([1000, { type: 'user.message', text: 'hi', attachments: [] }], [1100, { type: 'turn.started', turnId: 't' }], [1200, { type: 'message.delta', text: 'Hello' }], [1300, { type: 'turn.completed', turnId: 't' }], [1400, { type: 'turn.abandoned' }])
    const s = foldEvents(blank(), events)
    expect('moonsTurn' in s).toBe(false)
    expect(kinds(s)).toEqual(['user', 'assistant', 'notice'])
  })
})
