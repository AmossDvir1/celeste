import { create } from 'zustand'
import type { VendorId } from '@shared/agent'
import type { CorePush } from '@shared/api'
import type { VendorUsage } from '@shared/usage'
import { core } from '@/api'

/** How much of each connected vendor's allowance is used (docs/QUEUE_AND_USAGE_PLAN.md, Part 2). Core keeps the last answer and asks the vendors; this only shows it. */
interface UsageState {
  items: VendorUsage[]
  /** A reading is under way, so the refresh button can say so. */
  refreshing: boolean
  /** What Core already knows, at once. */
  load: () => Promise<void>
  /** Asks Core to read again (one vendor, or all). Quietly keeps what is shown when it cannot. */
  refresh: (vendor?: VendorId) => Promise<void>
  applyPush: (push: CorePush) => void
}

export const useUsage = create<UsageState>((set, get) => ({
  items: [],
  refreshing: false,

  load: async () => {
    try {
      set({ items: await core.call('usage.get') })
    } catch {
      /* the strip simply stays empty */
    }
  },

  refresh: async (vendor) => {
    if (get().refreshing) return
    set({ refreshing: true })
    try {
      set({ items: await core.call('usage.refresh', vendor) })
    } catch {
      /* what is shown stays */
    } finally {
      set({ refreshing: false })
    }
  },

  applyPush: (push) => {
    if (push.type === 'usage') void get().load()
  }
}))
