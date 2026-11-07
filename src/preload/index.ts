import { contextBridge, ipcRenderer } from 'electron'
import type { CoreMessage, CoreMethod, CoreParams, CorePush, CoreRequest, CoreResult } from '@shared/api'
import type { CelesteBridge } from '@shared/bridge'

// The main process gives each window a message port straight to Core, as soon as this script asks for one.
const port = new Promise<MessagePort>((resolve) => {
  ipcRenderer.once('celeste:port', (event) => resolve(event.ports[0]))
})
ipcRenderer.send('celeste:port-request')

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Set<(push: CorePush) => void>()
let nextId = 1

void port.then((p) => {
  p.onmessage = (event: { data: CoreMessage }) => {
    const message = event.data
    if (message.kind === 'push') {
      listeners.forEach((listener) => listener(message.push))
      return
    }
    const waiting = pending.get(message.response.id)
    if (!waiting) return
    pending.delete(message.response.id)
    if (message.response.ok) waiting.resolve(message.response.result)
    else waiting.reject(new Error(message.response.error))
  }
})

const secret = (op: string, name?: string, value?: string) => ipcRenderer.invoke('celeste:secrets', op, name, value)

let beforeQuit: (() => Promise<void> | void) | undefined
ipcRenderer.on('celeste:before-quit', async () => {
  try {
    await beforeQuit?.()
  } finally {
    ipcRenderer.send('celeste:flush-done')
  }
})

const bridge: CelesteBridge = {
  platform: process.platform,
  setTheme: (payload) => {
    ipcRenderer.send('celeste:theme', payload)
  },
  core: {
    call: <M extends CoreMethod>(method: M, params: CoreParams<M>) =>
      port.then(
        (p) =>
          new Promise<Awaited<CoreResult<M>>>((resolve, reject) => {
            const id = nextId++
            pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
            p.postMessage({ id, method, params } satisfies CoreRequest)
          })
      ),
    onPush: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  },
  secrets: {
    available: () => secret('available'),
    set: (name, value) => secret('set', name, value),
    remove: (name) => secret('remove', name),
    has: (name) => secret('has', name),
    hint: (name) => secret('hint', name)
  },
  revealDataFolder: () => ipcRenderer.invoke('celeste:reveal-data'),
  onBeforeQuit: (handler) => {
    beforeQuit = handler
  }
}

contextBridge.exposeInMainWorld('celeste', bridge)
