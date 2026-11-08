import type { CoreMethod, CoreParams, CorePush } from '@shared/api'
import type { CelesteBridge } from '@shared/bridge'

// Core is reached through the preload bridge. There is no other way in: opened in a plain browser, there is no Core to talk to.
const bridge = (): CelesteBridge => {
  if (!window.celeste) throw new Error('Celeste runs in its desktop app. Open it from there.')
  return window.celeste
}

export const core = {
  call: <M extends CoreMethod>(method: M, ...params: CoreParams<M>) => {
    try {
      return bridge().core.call(method, params)
    } catch (err) {
      return Promise.reject(err)
    }
  },

  onPush(listener: (push: CorePush) => void): () => void {
    return window.celeste ? window.celeste.core.onPush(listener) : () => undefined
  }
}

// Keys and tokens are kept by the main process: they can be stored and removed from here, never read back.
export const secrets = {
  available: async (): Promise<boolean> => bridge().secrets.available(),
  set: async (name: string, value: string): Promise<void> => bridge().secrets.set(name, value),
  remove: async (name: string): Promise<void> => bridge().secrets.remove(name),
  has: async (name: string): Promise<boolean> => bridge().secrets.has(name),
  hint: async (name: string): Promise<string | null> => bridge().secrets.hint(name)
}

/** Shows the folder that holds the database and attachments. */
export const revealDataFolder = async (): Promise<boolean> => {
  if (!window.celeste) return false
  await window.celeste.revealDataFolder()
  return true
}

/** Asks the person to choose a folder. Null when they cancel. */
export const chooseFolder = async (): Promise<string | null> => (window.celeste ? window.celeste.chooseFolder() : null)
