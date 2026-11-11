import { describe, expect, it } from 'vitest'
import type { LogEvent, StoredEvent } from '@shared/api'
import { coalesceEvents } from '@shared/coalesce'
import { foldEvents } from './reduce'

const log = (...events: LogEvent[]): StoredEvent[] => events.map((event, i) => ({ seq: i + 1, at: 1000 + i * 10, event }))

describe('folding runs of tokens in a log', () => {
  const events = log(
    { type: 'user.message', text: 'hi', attachments: [] },
    { type: 'turn.started', turnId: 't' },
    { type: 'thinking.delta', text: 'a' },
    { type: 'thinking.delta', text: 'b' },
    { type: 'tool.started', id: 'x', kind: 'shell', title: 'ls' },
    { type: 'tool.output', id: 'x', text: '1' },
    { type: 'tool.output', id: 'x', text: '2' },
    { type: 'tool.output', id: 'y', text: '3' },
    { type: 'tool.completed', id: 'x', ok: true },
    { type: 'message.delta', text: 'He' },
    { type: 'message.delta', text: 'llo' },
    { type: 'message.delta', text: '!' },
    { type: 'turn.completed', turnId: 't' }
  )

  it('joins neighbours that continue the same text, keeping the last number and the first time', () => {
    const folded = coalesceEvents(events)
    expect(folded.map((e) => e.event.type)).toEqual(['user.message', 'turn.started', 'thinking.delta', 'tool.started', 'tool.output', 'tool.output', 'tool.completed', 'message.delta', 'turn.completed'])
    expect(folded[2]).toMatchObject({ seq: 4, at: 1020, event: { type: 'thinking.delta', text: 'ab' } })
    // Output of another tool is not joined to this one's.
    expect(folded[4]).toMatchObject({ seq: 7, event: { text: '12' } })
    expect(folded[5]).toMatchObject({ seq: 8, event: { id: 'y', text: '3' } })
    expect(folded[7]).toMatchObject({ seq: 12, at: 1090, event: { text: 'Hello!' } })
  })

  it('replays into the very same conversation, and leaves its input alone', () => {
    const before = JSON.stringify(events)
    const a = foldEvents(blank(), events)
    const b = foldEvents(blank(), coalesceEvents(events))
    expect(JSON.stringify(events)).toBe(before)
    const bare = (items: { id: string }[]) => items.map(({ id: _id, ...rest }) => rest)
    expect(bare(b.items)).toEqual(bare(a.items))
    expect(b).toMatchObject({ status: a.status, foldedSeq: 13, lastSeq: 13, updatedAt: a.updatedAt })
  })
})

function blank() {
  return {
    id: 's', vendor: 'copilot' as const, mode: 'chat' as const, title: 'T', model: 'm', effort: null, approval: 'auto' as const, status: 'idle' as const,
    createdAt: 0, updatedAt: 0, lastSeq: 0, items: [], activity: null, loaded: true, foldedSeq: 0, queue: { items: [], paused: false }
  }
}
