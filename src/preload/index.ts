import { contextBridge, ipcRenderer } from 'electron'
import type { CoreMessage, CoreMethod, CoreParams, CorePush, CoreRequest, CoreResult } from '@shared/api'
import type { CelesteBridge } from '@shared/bridge'
import type { BrowserState, KeyInput } from '@shared/browser'

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
  browser: {
    call: (op, arg) => ipcRenderer.invoke('celeste:browser', op, arg),
    onState: (listener) => {
      const on = (_event: unknown, state: BrowserState) => listener(state)
      ipcRenderer.on('celeste:browser-state', on)
      return () => {
        ipcRenderer.removeListener('celeste:browser-state', on)
      }
    },
    // The page is a native layer, so the window never sees the keys typed in it. The ones the window uses come back this way.
    onReveal: (listener) => {
      const on = (_event: unknown, payload: { chatId?: unknown }) => {
        if (typeof payload?.chatId === 'string') listener(payload.chatId)
      }
      ipcRenderer.on('celeste:browser-reveal', on)
      return () => {
        ipcRenderer.removeListener('celeste:browser-reveal', on)
      }
    },
    onKey: (listener) => {
      const on = (_event: unknown, key: KeyInput) => listener(key)
      ipcRenderer.on('celeste:browser-key', on)
      return () => {
        ipcRenderer.removeListener('celeste:browser-key', on)
      }
    }
  },
  chatFile: (sessionId, path, action) => ipcRenderer.invoke('celeste:chat-file', sessionId, path, action),
  saveText: (suggestedName, text) => ipcRenderer.invoke('celeste:save-text', suggestedName, text),
  openText: (extensions) => ipcRenderer.invoke('celeste:open-text', extensions),
  revealDataFolder: () => ipcRenderer.invoke('celeste:reveal-data'),
  chooseFolder: () => ipcRenderer.invoke('celeste:choose-folder'),
  onBeforeQuit: (handler) => {
    beforeQuit = handler
  }
}

contextBridge.exposeInMainWorld('celeste', bridge)
