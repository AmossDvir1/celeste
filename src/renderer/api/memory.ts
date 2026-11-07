import type { CoreMethod, CoreParams, CorePush } from '@shared/api'
import type { CelesteBridge } from '@shared/bridge'
import { DEFAULT_SETTINGS, DEFAULT_VENDORS } from '@shared/defaults'
import { MemoryFileStore, MemoryStore } from '@core/memory-store'
import { createMockSession } from '@core/mock/engine'
import { sampleSessions } from '@core/mock/samples'
import { SessionService } from '@core/service'

/**
 * Core running inside the page, for `npm run dev:web`. It is the same session code the app runs, on an
 * in-memory store, so everything works in a plain browser tab but nothing survives a reload.
 */
export function createMemoryTransport(): CelesteBridge['core'] {
  const listeners = new Set<(push: CorePush) => void>()
  const service = new SessionService({
    store: new MemoryStore(),
    files: new MemoryFileStore(),
    dataDir: 'this browser tab (nothing is saved)',
    adapter: createMockSession,
    push: (p) => listeners.forEach((l) => l(p)),
    defaults: { ...DEFAULT_SETTINGS, userName: 'Amoss', defaults: { ...DEFAULT_SETTINGS.defaults, projectsFolder: 'D:\\Projects' } },
    defaultVendors: DEFAULT_VENDORS,
    samples: sampleSessions
  })
  service.init()

  return {
    call: async <M extends CoreMethod>(method: M, params: CoreParams<M>) => {
      const handler = service.api[method] as (...args: unknown[]) => unknown
      return (await handler(...params)) as never
    },
    onPush: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
