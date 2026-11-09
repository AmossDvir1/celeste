import { create } from 'zustand'
import type { CorePush } from '@shared/api'
import type { PhonePairRequest, PhoneStatus } from '@shared/phone'
import { core } from '@/api'
import { useUi } from './ui'

interface PhoneState {
  status: PhoneStatus | null
  /** A phone asking to connect, shown wherever the person is. */
  pairing: PhonePairRequest | null
  refresh: () => Promise<void>
  setEnabled: (on: boolean) => Promise<void>
  remove: (phoneId: string) => Promise<void>
  answer: (allow: boolean) => Promise<void>
  applyPush: (push: CorePush) => void
}

function report(err: unknown): void {
  useUi.getState().pushToast({ text: err instanceof Error ? err.message : 'Something went wrong.' })
}

export const usePhone = create<PhoneState>((set, get) => ({
  status: null,
  pairing: null,

  refresh: async () => {
    try {
      const status = await core.call('phone.status')
      set({ status, pairing: status.pending })
    } catch {
      // Core is not there (a plain browser): Settings shows nothing to switch on.
    }
  },

  setEnabled: async (on) => {
    try {
      set({ status: await core.call('phone.setEnabled', on) })
    } catch (err) {
      report(err)
    }
  },

  remove: async (phoneId) => {
    try {
      set({ status: await core.call('phone.remove', phoneId) })
      useUi.getState().pushToast({ text: 'Phone removed. It has to connect again to use Celeste.' })
    } catch (err) {
      report(err)
    }
  },

  answer: async (allow) => {
    const p = get().pairing
    if (!p) return
    set({ pairing: null })
    try {
      set({ status: await core.call('phone.answer', p.pairId, allow) })
      if (allow) useUi.getState().pushToast({ text: `${p.name} is connected.` })
    } catch (err) {
      report(err)
    }
  },

  applyPush: (push) => {
    if (push.type === 'phone') void get().refresh()
    if (push.type === 'phonePairing') set({ pairing: push.request })
  }
}))
