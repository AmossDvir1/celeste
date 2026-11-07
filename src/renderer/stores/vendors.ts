import { create } from 'zustand'
import type { VendorId } from '@shared/agent'

/*
 * Mock vendor connections. Connect plays the same steps the real flow will:
 * download the runtime (if missing), wait for the browser, then show Connected.
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
  connect: (id: VendorId, method?: ConnectMethod) => void
  cancel: (id: VendorId) => void
  saveKey: (id: VendorId) => void
  disconnect: (id: VendorId) => void
}

const timers = new Map<VendorId, ReturnType<typeof setTimeout>[]>()

function clearTimers(id: VendorId): void {
  timers.get(id)?.forEach(clearTimeout)
  timers.delete(id)
}
function later(id: VendorId, ms: number, fn: () => void): void {
  const t = setTimeout(fn, ms)
  timers.set(id, [...(timers.get(id) ?? []), t])
}

const ACCOUNT: Record<VendorId, string> = {
  copilot: 'amoss on GitHub',
  claude: 'Console · Amoss Labs',
  openai: 'ChatGPT Plus',
  gemini: 'API key ending 4f2a'
}

export const useVendors = create<VendorsState>((set, get) => {
  const patch = (id: VendorId, p: Partial<VendorState>) =>
    set((s) => ({ vendors: { ...s.vendors, [id]: { ...s.vendors[id], ...p } } }))

  return {
    vendors: {
      copilot: { status: 'connected', account: ACCOUNT.copilot, method: 'browser' },
      claude: { status: 'connected', account: ACCOUNT.claude, method: 'browser' },
      openai: { status: 'ready' },
      gemini: { status: 'not-installed' }
    },

    connect: (id, method = 'browser') => {
      clearTimers(id)
      const waitForBrowser = () => {
        patch(id, { status: 'waiting', progress: undefined })
        later(id, 2800, () => patch(id, { status: 'connected', account: ACCOUNT[id], method }))
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

    saveKey: (id) => {
      clearTimers(id)
      patch(id, { status: 'connected', account: ACCOUNT[id], method: 'key', progress: undefined })
    },

    disconnect: (id) => {
      clearTimers(id)
      patch(id, { status: 'ready', account: undefined, method: undefined })
    }
  }
})

export function connectedVendors(vendors: Record<VendorId, VendorState>): VendorId[] {
  return (Object.keys(vendors) as VendorId[]).filter((v) => vendors[v].status === 'connected')
}
