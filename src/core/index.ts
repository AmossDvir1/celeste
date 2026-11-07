// The Core process: database, sessions and the assistant. Started by the main process as a utility process,
// so a slow or crashing agent can never freeze or take down the window.
import { mkdirSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import type { CoreMessage, CorePush, CoreRequest } from '@shared/api'
import { DEFAULT_SETTINGS, DEFAULT_VENDORS } from '@shared/defaults'
import { DiskFileStore } from './disk-files'
import { createMockSession } from './mock/engine'
import { sampleSessions } from './mock/samples'
import { SessionService } from './service'
import { SqliteStore } from './sqlite-store'

const parent = process.parentPort

/** The first name for the greeting: the operating system's user name, capitalised. */
function friendlyName(): string {
  try {
    const name = userInfo().username
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'there'
  } catch {
    return 'there'
  }
}

const ports = new Set<MessagePortMain>()
const send = (port: MessagePortMain, message: CoreMessage) => port.postMessage(message)
const push = (p: CorePush) => ports.forEach((port) => send(port, { kind: 'push', push: p }))

let service: SessionService | undefined
let store: SqliteStore | undefined

try {
  const dataDir = process.env['CELESTE_DATA_DIR']
  if (!dataDir) throw new Error('CELESTE_DATA_DIR is not set')
  mkdirSync(dataDir, { recursive: true })
  store = new SqliteStore(join(dataDir, 'celeste.db'))
  service = new SessionService({
    store,
    files: new DiskFileStore(join(dataDir, 'attachments')),
    dataDir,
    adapter: createMockSession,
    push,
    defaults: {
      ...DEFAULT_SETTINGS,
      userName: friendlyName(),
      defaults: { ...DEFAULT_SETTINGS.defaults, projectsFolder: join(homedir(), 'Projects') }
    },
    defaultVendors: DEFAULT_VENDORS,
    samples: sampleSessions
  })
  service.init()
  parent.postMessage({ type: 'ready' })
} catch (err) {
  // Typically a database made by a newer Celeste. The main process tells the user and quits.
  parent.postMessage({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })
}

function onRequest(port: MessagePortMain, data: unknown): void {
  const req = data as Partial<CoreRequest> | null
  if (!service || typeof req?.id !== 'number' || typeof req.method !== 'string' || !Array.isArray(req.params)) return
  const id = req.id
  const api = service.api
  if (!Object.hasOwn(api, req.method)) {
    send(port, { kind: 'response', response: { id, ok: false, error: `Unknown method ${req.method}` } })
    return
  }
  const method = api[req.method as keyof typeof api] as (...args: unknown[]) => unknown
  const params = req.params
  Promise.resolve()
    .then(() => method(...params))
    .then(
      (result) => send(port, { kind: 'response', response: { id, ok: true, result } }),
      (err: unknown) => send(port, { kind: 'response', response: { id, ok: false, error: err instanceof Error ? err.message : String(err) } })
    )
}

parent.on('message', (event) => {
  const message = event.data as { type?: string } | null
  if (message?.type === 'connect') {
    const port = event.ports[0]
    if (!port) return
    ports.add(port)
    port.on('message', (e) => onRequest(port, e.data))
    port.on('close', () => ports.delete(port))
    port.start()
  } else if (message?.type === 'shutdown') {
    service?.close()
    store?.close()
    parent.postMessage({ type: 'closed' })
  }
})
