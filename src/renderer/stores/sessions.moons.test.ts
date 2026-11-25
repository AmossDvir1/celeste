import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './types'

const call = vi.hoisted(() => vi.fn((_method: string, ..._args: unknown[]): Promise<unknown> => Promise.resolve({})))
vi.mock('@/api', () => ({ core: { call } }))

const { useSessions } = await import('./sessions')
const { useUi } = await import('./ui')

const summary = (over: Record<string, unknown> = {}) => ({ id: 'p1', vendor: 'claude', mode: 'chat', title: 'T', model: 'claude:opus', effort: null, approval: 'auto', status: 'idle', createdAt: 1, updatedAt: 1, lastSeq: 0, ...over })
const session = (over: Partial<Session> = {}): Session => ({ ...summary(), items: [], activity: null, loaded: false, foldedSeq: 0, queue: { items: [], paused: false }, ...over }) as unknown as Session

describe('a chat with two moons', () => {
  beforeEach(() => {
    call.mockReset()
    call.mockImplementation((method) => {
      if (method === 'sessions.create') return Promise.resolve(summary({ moons: { pattern: 'build', childId: 'c1' } }))
      if (method === 'sessions.get') return Promise.resolve(null)
      return Promise.resolve({})
    })
    useSessions.setState({ sessions: {}, active: { chat: null, develop: null } })
  })

  it('sends the second moon with the chat, forgets it on the home screen, and loads its log', async () => {
    useSessions.setState({ sessions: { c1: session({ id: 'c1', parentId: 'p1' }) } })
    useUi.getState().setDraft({ moons: { pattern: 'build', model: 'claude:sonnet', effort: null } })
    const ok = await useSessions.getState().send('chat', { text: 'Make a thing', attachments: [] })
    expect(ok).toBe(true)
    const create = call.mock.calls.find((c) => c[0] === 'sessions.create')
    expect(create?.[1]).toMatchObject({ moons: { pattern: 'build', vendor: 'claude', model: 'claude:sonnet', effort: null } })
    expect(useUi.getState().draft.moons).toBeNull()
    expect(call).toHaveBeenCalledWith('sessions.get', 'c1')
  })

  it('sends no moons for an ordinary chat', async () => {
    useUi.getState().setDraft({ moons: null })
    call.mockImplementation((method) => Promise.resolve(method === 'sessions.create' ? summary() : {}))
    await useSessions.getState().send('chat', { text: 'Hello', attachments: [] })
    const create = call.mock.calls.find((c) => c[0] === 'sessions.create')
    expect(create?.[1]).not.toHaveProperty('moons')
  })

  it('opening such a chat loads the second moon too, once', () => {
    useSessions.setState({ sessions: { p1: session({ moons: { pattern: 'build', childId: 'c1' } } as Partial<Session>), c1: session({ id: 'c1', parentId: 'p1' }) } })
    useSessions.getState().open('p1')
    expect(call).toHaveBeenCalledWith('sessions.get', 'p1')
    expect(call).toHaveBeenCalledWith('sessions.get', 'c1')
    useSessions.getState().ensureLoaded('missing')
    expect(call).toHaveBeenCalledTimes(2)
  })
})
