import { create } from 'zustand'
import type { VendorId } from '@shared/agent'
import type { CorePush, SignInStep, VendorRecord, VendorRecords } from '@shared/api'
import { core, secrets } from '@/api'
import { useModels } from './models'
import { useUi } from './ui'

/*
 * Vendor connections. Which vendors are connected is saved, and a pasted API key goes to the secret store
 * (see src/main/secrets.ts). Copilot connects for real: Core downloads its program if needed, then walks GitHub's
 * sign-in and reports each step. The other vendors still play the steps their real flow will have (download,
 * wait for the browser, Connected) until their adapters arrive in Phase 5.
 */
export type VendorStatus = 'not-installed' | 'ready' | 'downloading' | 'waiting' | 'connected'
export type ConnectMethod = 'browser' | 'key'

export interface VendorState {
  status: VendorStatus
  progress?: number
  account?: string
  method?: ConnectMethod
  /** What the person has to do, while waiting: open a link, or type a code on GitHub. */
  step?: SignInStep
  /** Why the last attempt did not work. Cleared by the next one. */
  error?: string
}

interface VendorsState {
  vendors: Record<VendorId, VendorState>
  /** Applies the saved connections. A key connection whose key has gone missing is dropped. */
  init: (records: VendorRecords) => Promise<void>
  connect: (id: VendorId, method?: ConnectMethod) => void
  /** Real vendors: signs in with a code to type on GitHub, for when the browser step does not work. */
  connectWithCode: (id: VendorId) => void
  cancel: (id: VendorId) => void
  applyPush: (push: CorePush) => void
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

/** Opens a sign-in page in the person's browser. The app sends https addresses on to it. */
export function openExternal(url: string): void {
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    /* the card has a button for it */
  }
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

  /** The steps a real connection will have, played on a timer, for vendors that have no adapter yet. */
  function scripted(id: VendorId, method: ConnectMethod): void {
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
  }

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
      // A saved Copilot connection is checked against the sign-in on this computer, which can have ended since.
      if (next.copilot.status === 'connected' && next.copilot.method === 'browser') {
        void core.call('vendor.status', 'copilot').then((c) => {
          if (c.state === 'signed-in') patch('copilot', { account: c.account })
          else if (c.state !== 'unsupported' && get().vendors.copilot.status === 'connected') {
            patch('copilot', { status: c.state === 'runtime-missing' ? 'not-installed' : 'ready', account: undefined, method: undefined })
            void store('copilot', null)
          }
        }, () => undefined)
      }
    },

    applyPush: (push) => {
      if (push.type !== 'vendor') return
      const id = push.vendor
      const p = push.progress
      if (get().vendors[id].status !== 'waiting' && get().vendors[id].status !== 'downloading') return // cancelled meanwhile
      if (p.state === 'downloading') patch(id, { status: 'downloading', progress: p.progress, error: undefined })
      else if (p.state === 'step') {
        patch(id, { status: 'waiting', progress: undefined, step: p.step })
        // The browser or the verification page opens by itself. The card keeps a button for when it does not.
        openExternal(p.step.url)
      } else if (p.state === 'done') {
        patch(id, { status: 'connected', account: p.account, method: 'browser', step: undefined, progress: undefined, error: undefined })
        void store(id, { account: p.account, method: 'browser' })
        void useModels.getState().refresh()
      } else patch(id, { status: 'ready', step: undefined, progress: undefined, error: p.message })
    },

    connectWithCode: (id) => {
      patch(id, { status: 'waiting', step: undefined, error: undefined })
      void core.call('vendor.signIn', id, 'code').catch((err: unknown) => patch(id, { status: 'ready', error: err instanceof Error ? err.message : String(err) }))
    },

    connect: (id, method = 'browser') => {
      clearTimers(id)
      patch(id, { error: undefined, step: undefined })
      // Ask Core first: a real vendor signs in for real, anything else plays the scripted steps below.
      if (method === 'browser') {
        patch(id, { status: 'waiting', progress: undefined })
        void core.call('vendor.status', id).then(
          (c) => {
            if (get().vendors[id].status !== 'waiting') return // cancelled meanwhile
            if (c.state !== 'unsupported') {
              void core.call('vendor.signIn', id, 'web').catch((err: unknown) => patch(id, { status: 'ready', error: err instanceof Error ? err.message : String(err) }))
              return
            }
            patch(id, { status: idle(id).status })
            scripted(id, method)
          },
          () => {
            patch(id, { status: idle(id).status })
            scripted(id, method)
          }
        )
        return
      }
      scripted(id, method)
    },

    cancel: (id) => {
      clearTimers(id)
      void core.call('vendor.cancelSignIn', id).catch(() => undefined)
      patch(id, { status: idle(id).status, progress: undefined, step: undefined })
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
