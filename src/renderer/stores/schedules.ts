import { create } from 'zustand'
import type { CorePush } from '@shared/api'
import type { ScheduleLogEntry, SchedulePreview, ScheduleSaveInput, ScheduleSpec, ScheduleSummary } from '@shared/schedule'
import { core } from '@/api'
import { useUi } from './ui'

/** The schedules (docs/plans/SCHEDULING_PLAN.md): Core keeps them and decides when they run; this only shows them and sends the person's changes. */
interface SchedulesState {
  list: ScheduleSummary[]
  /** Every schedule is paused (from the tray or the button on the list). */
  paused: boolean
  loaded: boolean
  refresh: () => Promise<void>
  applyPush: (push: CorePush) => void
  preview: (input: { workflowId: string; inputs: Record<string, unknown>; spec: ScheduleSpec; timezone?: string }) => Promise<SchedulePreview | null>
  /** Makes a schedule, or changes one (with `id`). Always an approval: the dialog showed the card. Returns it, or null with the reason said. */
  save: (input: Omit<ScheduleSaveInput, 'approved'>) => Promise<ScheduleSummary | null>
  setEnabled: (id: string, on: boolean) => Promise<void>
  pauseAll: (on: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  log: (id: string) => Promise<ScheduleLogEntry[]>
}

const say = (text: string) => useUi.getState().pushToast({ text })
const sentence = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export const useSchedules = create<SchedulesState>()((set, get) => ({
  list: [],
  paused: false,
  loaded: false,

  refresh: async () => {
    try {
      const [list, paused] = await Promise.all([core.call('schedules.list'), core.call('schedules.paused')])
      set({ list, paused, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  // A run's push too: a schedule shows how its last run went.
  applyPush: (push) => {
    if (push.type === 'schedules' || push.type === 'run') void get().refresh()
  },

  preview: async (input) => {
    try {
      return await core.call('schedules.preview', input)
    } catch {
      return null
    }
  },

  save: async (input) => {
    try {
      const saved = await core.call('schedules.save', { ...input, approved: true })
      await get().refresh()
      return saved
    } catch (err) {
      say(sentence(err, 'Could not save the schedule.'))
      return null
    }
  },

  setEnabled: async (id, on) => {
    try {
      await core.call('schedules.setEnabled', id, on)
      await get().refresh()
    } catch (err) {
      say(sentence(err, 'Could not change the schedule.'))
      await get().refresh()
    }
  },

  pauseAll: async (on) => {
    try {
      await core.call('schedules.pauseAll', on)
      await get().refresh()
    } catch (err) {
      say(sentence(err, 'Could not change that.'))
    }
  },

  remove: async (id) => {
    try {
      await core.call('schedules.remove', id)
      await get().refresh()
      say('Deleted the schedule.')
    } catch (err) {
      say(sentence(err, 'Could not delete the schedule.'))
    }
  },

  log: async (id) => {
    try {
      return await core.call('schedules.log', id)
    } catch {
      return []
    }
  }
}))
