import { create } from 'zustand'
import type { CheckpointChanges } from '@shared/api'
import { core } from '@/api'

interface ChangesState {
  /**
   * What differs now from before each Develop session's first message: the net result, so a file the agent changed and then
   * changed back, or that a revert undid, is not in it. Absent until it has been looked at.
   */
  net: Record<string, CheckpointChanges | undefined>
  /** Looks at the folder again. Asked for when an answer ends, after a revert, and by the Refresh buttons. */
  refresh: (sessionId: string) => Promise<void>
}

const running = new Map<string, Promise<void>>()

export const useChanges = create<ChangesState>()((set) => {
  const look = (id: string): Promise<void> =>
    core.call('sessions.netChanges', id).then(
      (changes) => set((s) => ({ net: { ...s.net, [id]: changes } })),
      // A session that cannot be looked at (no git, a folder that moved) just keeps what it showed.
      () => undefined
    )
  return {
    net: {},
    refresh: (id) => {
      // A look that is already under way may have started before the change that is being asked about, so one more follows it.
      const before = running.get(id)
      const next = (before ?? Promise.resolve()).then(() => look(id))
      const tracked = next.finally(() => {
        if (running.get(id) === tracked) running.delete(id)
      })
      running.set(id, tracked)
      return tracked
    }
  }
})
