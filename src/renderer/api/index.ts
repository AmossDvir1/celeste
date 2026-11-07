import type { CoreMethod, CoreParams, CorePush } from '@shared/api'
import type { CelesteBridge } from '@shared/bridge'

type CoreLine = CelesteBridge['core']

// In the app, Core is reached through the preload bridge. In a plain browser there is no bridge, so an
// in-memory copy of Core is loaded instead (and only then: it is a separate chunk).
let preview: Promise<CoreLine> | undefined
const line = (): Promise<CoreLine> =>
  window.celeste ? Promise.resolve(window.celeste.core) : (preview ??= import('./memory').then((m) => m.createMemoryTransport()))

export const core = {
  call: <M extends CoreMethod>(method: M, ...params: CoreParams<M>) => line().then((l) => l.call(method, params)),

  onPush(listener: (push: CorePush) => void): () => void {
    let off = () => {}
    let stopped = false
    void line().then((l) => {
      if (!stopped) off = l.onPush(listener)
    })
    return () => {
      stopped = true
      off()
    }
  }
}

// Keys and tokens are kept by the main process. A plain browser has no such store, so there they only
// live in memory, which is enough for the preview.
const inMemory = new Map<string, string>()

/** The preview's Core reads a password back from here. In the app, Core asks the main process instead. */
export const previewSecret = (name: string): string | null => inMemory.get(name) ?? null

export const secrets = {
  available: async (): Promise<boolean> => (window.celeste ? window.celeste.secrets.available() : true),
  set: async (name: string, value: string): Promise<void> => {
    if (window.celeste) return window.celeste.secrets.set(name, value)
    inMemory.set(name, value)
  },
  remove: async (name: string): Promise<void> => {
    if (window.celeste) return window.celeste.secrets.remove(name)
    inMemory.delete(name)
  },
  has: async (name: string): Promise<boolean> => (window.celeste ? window.celeste.secrets.has(name) : inMemory.has(name)),
  hint: async (name: string): Promise<string | null> =>
    window.celeste ? window.celeste.secrets.hint(name) : (inMemory.get(name)?.slice(-4) ?? null)
}

/** Shows the folder that holds the database and attachments. */
export const revealDataFolder = async (): Promise<boolean> => {
  if (!window.celeste) return false
  await window.celeste.revealDataFolder()
  return true
}
