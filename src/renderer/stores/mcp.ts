import { create } from 'zustand'
import type { CorePush, McpServerInput, McpServerView } from '@shared/api'
import { mcpSecretName } from '@shared/mcp'
import { core, secrets } from '@/api'
import { useUi } from './ui'

/** The values typed for a server's secret variables and headers. A name with no value keeps what is already stored. */
export interface McpSecretValues {
  env: Record<string, string>
  header: Record<string, string>
}

interface McpState {
  servers: McpServerView[]
  /** The server being changed, `'new'` for the add dialog, or null when it is closed. */
  editing: McpServerView | 'new' | null
  importOpen: boolean

  setEditing: (editing: McpServerView | 'new' | null) => void
  setImportOpen: (open: boolean) => void
  refresh: () => Promise<void>
  applyPush: (push: CorePush) => void
  /** Saves the server, stores its secret values, forgets the ones it no longer has, and starts a test. Returns the saved server. */
  save: (input: McpServerInput, values: McpSecretValues, previous?: McpServerView) => Promise<McpServerView>
  remove: (server: McpServerView) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  test: (id: string) => Promise<void>
}

function report(err: unknown): void {
  useUi.getState().pushToast({ text: err instanceof Error ? err.message : 'Something went wrong.' })
}

export const useMcp = create<McpState>((set, get) => ({
  servers: [],
  editing: null,
  importOpen: false,

  setEditing: (editing) => set({ editing }),
  setImportOpen: (importOpen) => set({ importOpen }),

  refresh: async () => {
    try {
      set({ servers: await core.call('mcp.list') })
    } catch (err) {
      report(err)
    }
  },

  applyPush: (push) => {
    if (push.type === 'mcp') void get().refresh()
  },

  save: async (input, values, previous) => {
    const saved = await core.call('mcp.save', input)
    const keep = new Set<string>()
    for (const kind of ['env', 'header'] as const) {
      for (const name of kind === 'env' ? saved.envNames : saved.headerNames) {
        keep.add(mcpSecretName(saved.id, kind, name))
        const value = values[kind][name]
        if (value) await secrets.set(mcpSecretName(saved.id, kind, name), value)
      }
    }
    // Variables or headers the server no longer has: their values go too.
    if (previous) {
      for (const [kind, names] of [['env', previous.envNames], ['header', previous.headerNames]] as const) {
        for (const name of names) if (!keep.has(mcpSecretName(saved.id, kind, name))) await secrets.remove(mcpSecretName(saved.id, kind, name)).catch(() => undefined)
      }
    }
    await get().refresh()
    // Looked at in the background: the status shows up on the list as it arrives.
    void core.call('mcp.test', saved.id).catch(() => undefined)
    return saved
  },

  remove: async (server) => {
    try {
      await core.call('mcp.remove', server.id)
      for (const name of server.envNames) await secrets.remove(mcpSecretName(server.id, 'env', name)).catch(() => undefined)
      for (const name of server.headerNames) await secrets.remove(mcpSecretName(server.id, 'header', name)).catch(() => undefined)
    } catch (err) {
      report(err)
    }
    await get().refresh()
  },

  setEnabled: async (id, enabled) => {
    // Shown at once, then confirmed.
    set((s) => ({ servers: s.servers.map((x) => (x.id === id ? { ...x, enabled } : x)) }))
    try {
      await core.call('mcp.setEnabled', id, enabled)
    } catch (err) {
      report(err)
    }
    await get().refresh()
  },

  test: async (id) => {
    try {
      await core.call('mcp.test', id)
    } catch (err) {
      report(err)
    }
    await get().refresh()
  }
}))
