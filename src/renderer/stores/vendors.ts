import { create } from 'zustand'
import type { VendorId } from '@shared/agent'
import type { VendorRecord, VendorRecords } from '@shared/api'
import { core, secrets } from '@/api'
import { useUi } from './ui'

/*
 * Vendor connections. Which vendors are connected is saved, and a pasted API key goes to the secret store
 * (see src/main/secrets.ts), but the Connect button's steps are still a mock until the real adapters arrive:
 * it plays the steps the real flow will (download the runtime if missing, wait for the browser, then Connected).
 */
export type VendorStatus = 'not-installed' | 'ready' | 'downloading' | 'waiting' | 'connected'
export type ConnectMethod = 'browser' | 'key'

export interface VendorState {
  status: VendorStatus
  progress?: number
  account?: string
  method?: ConnectMethod
}

interface VendorsState {
  vendors: Record<VendorId, VendorState>
  /** Applies the saved connections. A key connection whose key has gone missing is dropped. */
  init: (records: VendorRecords) => Promise<void>
  connect: (id: VendorId, method?: ConnectMethod) => void
  cancel: (id: VendorId) => void
  /** Stores the key securely, then marks the vendor connected. False if it could not be stored. */
  saveKey: (id: VendorId, key: string) => Promise<boolean>
  disconnect: (id: VendorId) => Promise<void>
}

const secretName = (id: VendorId) => `vendor.${id}.key`

/** Where a vendor starts when nothing is saved for it. */
const idle = (id: VendorId): VendorState => ({ status: id === 'gemini' ? 'not-installed' : 'ready' })

const store = (id: VendorId, record: VendorRecord | null): Promise<void> =>
  core.call('vendors.set', id, record).catch(() => useUi.getState().pushToast({ text: 'Could not save that connection.' }))

const timers = new Map<VendorId, ReturnType<typeof setTimeout>[]>()

function clearTimers(id: VendorId): void {
  timers.get(id)?.forEach(clearTimeout)
  timers.delete(id)
}
function later(id: VendorId, ms: number, fn: () => void): void {
  const t = setTimeout(fn, ms)
  timers.set(id, [...(timers.get(id) ?? []), t])
}

// What the mock browser sign-in reports. The real flow reads the account from the vendor.
const ACCOUNT: Record<VendorId, string> = {
  copilot: 'amoss on GitHub',
  claude: 'Console · Amoss Labs',
  openai: 'ChatGPT Plus',
  gemini: 'Google account'
}

export const useVendors = create<VendorsState>((set, get) => {
  const patch = (id: VendorId, p: Partial<VendorState>) =>
    set((s) => ({ vendors: { ...s.vendors, [id]: { ...s.vendors[id], ...p } } }))

  return {
    vendors: { copilot: idle('copilot'), claude: idle('claude'), openai: idle('openai'), gemini: idle('gemini') },

    init: async (records) => {
      const next = { copilot: idle('copilot'), claude: idle('claude'), openai: idle('openai'), gemini: idle('gemini') } as Record<VendorId, VendorState>
      for (const id of Object.keys(next) as VendorId[]) {
        const record = records[id]
        if (!record) continue
        if (record.method === 'key' && !(await secrets.has(secretName(id)).catch(() => false))) {
          void store(id, null)
          continue
        }
        next[id] = { status: 'connected', account: record.account, method: record.method }
      }
      set({ vendors: next })
    },

    connect: (id, method = 'browser') => {
      clearTimers(id)
      const waitForBrowser = () => {
        patch(id, { status: 'waiting', progress: undefined })
        later(id, 2800, () => {
          patch(id, { status: 'connected', account: ACCOUNT[id], method })
          void store(id, { account: ACCOUNT[id], method })
        })
      }
      if (get().vendors[id].status === 'not-installed') {
        patch(id, { status: 'downloading', progress: 0 })
        for (let i = 1; i <= 10; i++) {
          later(id, i * 220, () => patch(id, { progress: i / 10 }))
        }
        later(id, 2400, waitForBrowser)
      } else {
        waitForBrowser()
      }
    },

    cancel: (id) => {
      clearTimers(id)
      patch(id, { status: id === 'gemini' ? 'not-installed' : 'ready', progress: undefined })
    },

    saveKey: async (id, key) => {
      clearTimers(id)
      const value = key.trim()
      if (!value) return false
      try {
        await secrets.set(secretName(id), value)
      } catch {
        useUi.getState().pushToast({ text: 'This computer cannot store the key securely, so Celeste did not keep it.' })
        return false
      }
      const account = `API key ending ${value.slice(-4)}`
      patch(id, { status: 'connected', account, method: 'key', progress: undefined })
      await store(id, { account, method: 'key' })
      return true
    },

    disconnect: async (id) => {
      clearTimers(id)
      const wasKey = get().vendors[id].method === 'key'
      patch(id, { status: 'ready', account: undefined, method: undefined })
      await store(id, null)
      if (wasKey) await secrets.remove(secretName(id)).catch(() => undefined)
    }
  }
})

export function connectedVendors(vendors: Record<VendorId, VendorState>): VendorId[] {
  return (Object.keys(vendors) as VendorId[]).filter((v) => vendors[v].status === 'connected')
}
