import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from './types'

const call = vi.hoisted(() => vi.fn(() => Promise.resolve({})))
vi.mock('@/api', () => ({ core: { call } }))

const { useSessions } = await import('./sessions')

const session = (over: Partial<Session> = {}): Session => ({ id: 's1', title: 'Chat', pinnedAt: null, ...over } as Session)

describe('sessions.pin', () => {
  beforeEach(() => {
    call.mockClear()
    useSessions.setState({ sessions: { s1: session() } })
  })

  it('pins optimistically and tells the core', () => {
    const before = Date.now()
    useSessions.getState().pin('s1', true)
    const pinnedAt = useSessions.getState().sessions.s1?.pinnedAt
    expect(pinnedAt).toBeGreaterThanOrEqual(before)
    expect(call).toHaveBeenCalledWith('sessions.update', 's1', { pinned: true })
  })

  it('keeps the original pin time when pinning again', () => {
    useSessions.setState({ sessions: { s1: session({ pinnedAt: 1000 }) } })
    useSessions.getState().pin('s1', true)
    expect(useSessions.getState().sessions.s1?.pinnedAt).toBe(1000)
  })

  it('unpins by clearing the time', () => {
    useSessions.setState({ sessions: { s1: session({ pinnedAt: 1000 }) } })
    useSessions.getState().pin('s1', false)
    expect(useSessions.getState().sessions.s1?.pinnedAt).toBeNull()
    expect(call).toHaveBeenCalledWith('sessions.update', 's1', { pinned: false })
  })

  it('does nothing for an unknown session', () => {
    useSessions.getState().pin('missing', true)
    expect(call).not.toHaveBeenCalled()
  })
})
