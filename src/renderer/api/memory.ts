import { Buffer } from 'buffer'
import type { CoreApi, CoreMethod, CoreParams, CorePush, VendorLinkApi } from '@shared/api'
import type { CelesteBridge } from '@shared/bridge'
import { DEFAULT_SETTINGS, DEFAULT_VENDORS } from '@shared/defaults'
import { previewSecret } from '@/api'
import { DeviceService, type FileOps } from '@core/devices/device-service'
import { fakeConnectorFactory } from '@core/devices/fake-connector'
import { DeviceTools } from '@core/devices/tools'
import { MemoryFileStore, MemoryStore } from '@core/memory-store'
import { createMockSession } from '@core/mock/engine'
import { sampleSessions } from '@core/mock/samples'
import { SessionService } from '@core/service'

// The shared code uses Node's Buffer for bytes. A browser has none, so the preview brings one.
;(globalThis as { Buffer?: unknown }).Buffer ??= Buffer

/** There is no disk in a browser tab: snapshots are only pretended. */
const noDisk: FileOps = {
  join: (...parts) => parts.join('/'),
  dirname: (path) => path.split('/').slice(0, -1).join('/'),
  mkdirp: async () => undefined,
  remove: async () => undefined
}

/**
 * Core running inside the page, for `npm run dev:web`. It is the same session and device code the app runs, on an
 * in-memory store, with pretend devices instead of SSH, so everything works in a plain browser tab but nothing
 * survives a reload.
 */
export function createMemoryTransport(): CelesteBridge['core'] {
  const listeners = new Set<(push: CorePush) => void>()
  const push = (p: CorePush) => listeners.forEach((l) => l(p))
  const store = new MemoryStore()
  let sessions!: SessionService

  const devices = new DeviceService({
    store,
    dataDir: '',
    getSecret: async (name) => previewSecret(name),
    connectorFor: fakeConnectorFactory(),
    push,
    fs: noDisk
  })
  const tools = new DeviceTools(store, devices, { requestApproval: (...a) => sessions.requestApproval(...a) }, noDisk, '')

  sessions = new SessionService({
    store,
    files: new MemoryFileStore(),
    dataDir: 'this browser tab (nothing is saved)',
    adapter: (ctx) => createMockSession({ ...ctx, devices: { call: (name, args, hooks) => tools.call(ctx.sessionId, name, args, hooks) } }),
    onSessionStopped: (id) => tools.cancel(id),
    push,
    defaults: { ...DEFAULT_SETTINGS, userName: 'Amoss', defaults: { ...DEFAULT_SETTINGS.defaults, projectsFolder: 'D:\\Projects' } },
    defaultVendors: DEFAULT_VENDORS,
    samples: sampleSessions
  })
  sessions.init()
  // No real vendor runs in a browser tab: every vendor says so, and the window plays its scripted connection.
  const vendors: VendorLinkApi = {
    'vendor.status': async () => ({ state: 'unsupported' }),
    'vendor.signIn': async () => {
      throw new Error('Connecting a vendor needs the Celeste app.')
    },
    'vendor.cancelSignIn': async () => undefined,
    'vendor.models': async () => []
  }
  const api: CoreApi = { ...sessions.api, ...devices.api, ...vendors, 'devices.toolServer': async () => null }

  return {
    call: async <M extends CoreMethod>(method: M, params: CoreParams<M>) => {
      const handler = api[method] as (...args: unknown[]) => unknown
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
