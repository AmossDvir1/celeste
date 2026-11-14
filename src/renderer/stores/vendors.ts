import { create } from 'zustand'
import type { VendorId } from '@shared/agent'
import type { CorePush, SignInStep, VendorRecord, VendorRecords } from '@shared/api'
import { core, secrets } from '@/api'
import { VENDORS } from '@/lib/vendors'
import { useModels } from './models'
import { useUi } from './ui'

/*
 * Vendor connections. Which vendors are connected is saved, and a pasted API key goes to the secret store
 * (see src/main/secrets.ts). Copilot and Claude connect for real: Core downloads or finds the program, then walks the
 * vendor's sign-in and reports each step. The other vendors cannot be connected until their adapters arrive.
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
  /** How much of the vendor's program has arrived (0 to 1) while it downloads in the background, for instance while a key is being pasted. */
  getting?: number
}

interface VendorsState {
  vendors: Record<VendorId, VendorState>
  /** Applies the saved connections. A key connection whose key has gone missing is dropped. */
  init: (records: VendorRecords) => Promise<void>
  connect: (id: VendorId) => void
  /** Real vendors: signs in with a code to type on GitHub, for when the browser step does not work. */
  connectWithCode: (id: VendorId) => void
  cancel: (id: VendorId) => void
  applyPush: (push: CorePush) => void
  /** Gets the vendor's program onto this computer without signing in (it downloads in the background). True once it is there. */
  prepare: (id: VendorId) => Promise<boolean>
  /** Stores the key securely, then marks the vendor connected. False if it could not be stored. */
  saveKey: (id: VendorId, key: string) => Promise<boolean>
  disconnect: (id: VendorId) => Promise<void>
}

const secretName = (id: VendorId) => `vendor.${id}.key`

/** Where a vendor starts when nothing is saved for it. */
const idle = (_id: VendorId): VendorState => ({ status: 'ready' })

const store = (id: VendorId, record: VendorRecord | null): Promise<void> =>
  core.call('vendors.set', id, record).catch(() => useUi.getState().pushToast({ text: 'Could not save that connection.' }))

/** Opens a sign-in page in the person's browser. The app sends https addresses on to it. */
export function openExternal(url: string): void {
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    /* the card has a button for it */
  }
}

export const useVendors = create<VendorsState>((set, get) => {
  const patch = (id: VendorId, p: Partial<VendorState>) =>
    set((s) => ({ vendors: { ...s.vendors, [id]: { ...s.vendors[id], ...p } } }))
  /** Downloads under way for the program alone, so asking twice waits for the same one. */
  const fetching = new Map<VendorId, Promise<boolean>>()

  return {
    vendors: { copilot: idle('copilot'), claude: idle('claude'), openai: idle('openai'), gemini: idle('gemini') },

    init: async (records) => {
      const next = { copilot: idle('copilot'), claude: idle('claude'), openai: idle('openai'), gemini: idle('gemini') } as Record<VendorId, VendorState>
      for (const id of Object.keys(next) as VendorId[]) {
        const record = records[id]
        if (!record) continue
        // A vendor Celeste cannot talk to yet cannot be connected: a record of it is left over from an older build.
        if (!VENDORS[id].available) {
          void store(id, null)
          continue
        }
        if (record.method === 'key' && !(await secrets.has(secretName(id)).catch(() => false))) {
          void store(id, null)
          continue
        }
        next[id] = { status: 'connected', account: record.account, method: record.method }
      }
      set({ vendors: next })
      // A saved connection of a real vendor is checked against its own sign-in, which can have ended since.
      for (const id of ['copilot', 'claude', 'openai'] as const) {
        if (next[id].status !== 'connected' || next[id].method !== 'browser') continue
        void core.call('vendor.status', id).then((c) => {
          if (c.state === 'signed-in') patch(id, { account: c.account })
          else if (c.state !== 'unsupported' && get().vendors[id].status === 'connected') {
            patch(id, { status: c.state === 'runtime-missing' ? 'not-installed' : 'ready', account: undefined, method: undefined })
            void store(id, null)
          }
        }, () => undefined)
      }
      // A key connection has no sign-in to check, but its program must be there: if it was lost, it comes back by itself.
      for (const id of ['claude', 'openai', 'gemini'] as const) if (next[id].status === 'connected' && next[id].method === 'key') void get().prepare(id)
    },

    prepare: (id) => {
      const running = fetching.get(id)
      if (running) return running
      patch(id, { error: undefined })
      const job = core
        .call('vendor.prepare', id)
        .catch((err: unknown) => {
          patch(id, { error: err instanceof Error ? err.message : String(err) })
          return false
        })
        .finally(() => {
          fetching.delete(id)
          patch(id, { getting: undefined })
        })
      fetching.set(id, job)
      return job
    },

    applyPush: (push) => {
      if (push.type !== 'vendor') return
      const id = push.vendor
      const p = push.progress
      const now = get().vendors[id]
      // The program coming in the background, with no sign-in under way: only its progress and its failure matter.
      if (fetching.has(id) && now.status !== 'waiting' && now.status !== 'downloading') {
        if (p.state === 'downloading') patch(id, { getting: p.progress })
        else if (p.state === 'failed') patch(id, { getting: undefined, error: p.message })
        return
      }
      if (now.status !== 'waiting' && now.status !== 'downloading') return // cancelled meanwhile
      if (p.state === 'downloading') patch(id, { status: 'downloading', progress: p.progress, error: undefined })
      else if (p.state === 'step') {
        patch(id, { status: 'waiting', progress: undefined, step: p.step })
        // The browser or the verification page opens by itself. The card keeps a button for when it does not.
        openExternal(p.step.url)
      } else if (p.state === 'done') {
        patch(id, { status: 'connected', account: p.account, method: 'browser', step: undefined, progress: undefined, error: undefined })
        void store(id, { account: p.account, method: 'browser' })
        void useModels.getState().refresh([id])
      } else patch(id, { status: 'ready', step: undefined, progress: undefined, error: p.message })
    },

    connectWithCode: (id) => {
      patch(id, { status: 'waiting', step: undefined, error: undefined })
      void core.call('vendor.signIn', id, 'code').catch((err: unknown) => patch(id, { status: 'ready', error: err instanceof Error ? err.message : String(err) }))
    },

    connect: (id) => {
      if (!VENDORS[id].available) return
      patch(id, { status: 'waiting', progress: undefined, step: undefined, error: undefined })
      void core.call('vendor.signIn', id, 'web').catch((err: unknown) => patch(id, { status: 'ready', error: err instanceof Error ? err.message : String(err) }))
    },

    cancel: (id) => {
      void core.call('vendor.cancelSignIn', id).catch(() => undefined)
      patch(id, { status: idle(id).status, progress: undefined, step: undefined })
    },

    saveKey: async (id, key) => {
      const value = key.trim()
      if (!value) return false
      // The key is checked through the vendor's own program, so it has to be here first (it may already be coming).
      const checked = id === 'claude' || id === 'openai' || id === 'gemini'
      if (checked && !(await get().prepare(id))) return false
      try {
        await secrets.set(secretName(id), value)
      } catch {
        useUi.getState().pushToast({ text: 'This computer cannot store the key securely, so Celeste did not keep it.' })
        return false
      }
      // A vendor that can check a key says so at once. The vendor's answer, when it refuses the key, is shown and the key is dropped.
      if (checked) {
        const c = await core.call('vendor.status', id).catch(() => undefined)
        if (c?.state === 'unavailable') {
          await secrets.remove(secretName(id)).catch(() => undefined)
          patch(id, { status: 'ready', error: c.message })
          return false
        }
      }
      const account = `API key ending ${value.slice(-4)}`
      patch(id, { status: 'connected', account, method: 'key', progress: undefined, error: undefined })
      await store(id, { account, method: 'key' })
      // The vendor's program reads the key itself, so its own model list and account can now be asked for.
      if (checked) void useModels.getState().refresh([id])
      return true
    },

    disconnect: async (id) => {
      const wasKey = get().vendors[id].method === 'key'
      const wasPlan = id === 'openai' && !wasKey
      patch(id, { status: 'ready', account: undefined, method: undefined })
      await store(id, null)
      if (wasKey) await secrets.remove(secretName(id)).catch(() => undefined)
      // A ChatGPT sign-in is cancelled with OpenAI, so the app stops being listed in the person's ChatGPT settings.
      if (wasPlan) {
        const done = await core.call('vendor.signOut', id).catch(() => ({ revoked: false }))
        if (!done.revoked) useUi.getState().pushToast({ text: 'Signed out here, but Celeste could not reach OpenAI to cancel the sign-in. You can disconnect Celeste in ChatGPT’s settings, under Usage.' })
      }
      if (id === 'openai') void useModels.getState().refresh([id])
    }
  }
})

export function connectedVendors(vendors: Record<VendorId, VendorState>): VendorId[] {
  return (Object.keys(vendors) as VendorId[]).filter((v) => vendors[v].status === 'connected')
}
