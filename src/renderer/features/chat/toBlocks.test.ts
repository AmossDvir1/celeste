import { describe, expect, it } from 'vitest'
import type { TimelineItem } from '@/stores/types'
import { toBlocks } from './Timeline'

const user = (id: string): TimelineItem => ({ kind: 'user', id, text: 'hi', attachments: [], at: 0 })
const answer = (id: string): TimelineItem => ({ kind: 'assistant', id, text: 'ok' })
const think = (id: string, done = true): TimelineItem => ({ kind: 'thinking', id, text: 'hm', startedAt: 0, ...(done ? { endedAt: 5 } : {}) })
const tool = (id: string, kind: 'read' | 'search' | 'shell' | 'edit' | 'web', status: 'running' | 'ok' = 'ok'): TimelineItem => ({ kind: 'tool', id, tool: kind, title: id, output: '', status, startedAt: 0 })

const shape = (items: TimelineItem[], mode: 'chat' | 'develop') =>
  toBlocks(items, mode).map((b) => (b.kind === 'group' ? `[${b.items.map((i) => i.id).join(' ')}]` : b.item.id))

describe('what a conversation shows, and what it folds', () => {
  const turn = [user('u'), think('t1'), tool('r1', 'read'), tool('r2', 'search'), think('t2'), tool('s1', 'shell'), tool('e1', 'edit'), think('t3'), answer('a')]

  it('Chat folds all thinking and every tool call into groups, and shows the question and the answer', () => {
    expect(shape(turn, 'chat')).toEqual(['u', '[t1 r1 r2 t2 s1 e1 t3]', 'a'])
  })

  it('Chat shows thinking that has no tool beside it as a group too, so it can be opened, and one still going', () => {
    expect(shape([user('u'), think('t1'), answer('a')], 'chat')).toEqual(['u', '[t1]', 'a'])
    expect(shape([user('u'), think('t1', false)], 'chat')).toEqual(['u', '[t1]'])
    // A thought that is still going is part of the group it will end in, so the group keeps its place.
    expect(shape([user('u'), think('t1'), tool('r1', 'read'), think('t2', false)], 'chat')).toEqual(['u', '[t1 r1 t2]'])
  })

  it('Develop folds only reading and searching, with the thinking between, and shows every other call on its own', () => {
    expect(shape(turn, 'develop')).toEqual(['u', '[t1 r1 r2 t2]', 's1', 'e1', 't3', 'a'])
  })

  it('Develop shows thinking while it streams, and thinking with no reading beside it, on its own', () => {
    expect(shape([user('u'), think('t1', false)], 'develop')).toEqual(['u', 't1'])
    expect(shape([user('u'), think('t1'), tool('s1', 'shell')], 'develop')).toEqual(['u', 't1', 's1'])
    expect(shape([user('u'), tool('r1', 'read', 'running')], 'develop')).toEqual(['u', '[r1]'])
  })

  it('names a group by the first thing in it, which stays put as the run grows', () => {
    const before = toBlocks([user('u'), think('t1'), tool('r1', 'read')], 'chat')
    const after = toBlocks([user('u'), think('t1'), tool('r1', 'read'), tool('r2', 'read'), tool('r3', 'search')], 'chat')
    expect(before[1]).toMatchObject({ kind: 'group', id: 't1' })
    expect(after[1]).toMatchObject({ kind: 'group', id: 't1' })
  })
})
