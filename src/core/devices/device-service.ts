import type { CorePush, DeviceApi } from '@shared/api'
import {
  DEFAULT_PORT,
  DEVICE_LIMITS,
  type AccessLevel,
  type AddFolderResult,
  type AuthMethod,
  type DeviceKind,
  type DevicePatch,
  type DeviceRecord,
  type DirEntry,
  type FolderMode,
  type FoundDevice,
  type NewDevice,
  type TestResult
} from '@shared/devices'
import type { Store, StoredFolder } from '../store'
import { HostKeyError, type Connector, type ConnectorHooks, type Credentials, type DeviceTarget } from './connector'

/** Folder and file operations the service needs. The app uses the disk; the browser preview does nothing. */
export interface FileOps {
  join(...parts: string[]): string
  dirname(path: string): string
  mkdirp(path: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface DeviceServiceOptions {
  store: Store
  dataDir: string
  /** Secrets (passwords, key passphrases) come from the main process on request. */
  getSecret: (name: string) => Promise<string | null>
  connectorFor: (target: DeviceTarget, credentials: Credentials, hooks?: ConnectorHooks) => Connector
  push: (p: CorePush) => void
  fs: FileOps
  discover?: () => Promise<FoundDevice[]>
  pairing?: {
    pairByCode(address: string, code: string): Promise<{ host: string; port: number }>
    startQr(name: string, onPaired: (found: { host: string; port: number }) => void, onFailed: (error: Error) => void): { payload: string; cancel(): void }
  }
  /** When a snapshot is large enough to ask first. Defaults to the plan's limits. */
  confirmAbove?: { files: number; bytes: number }
  now?: () => number
}

const KINDS: DeviceKind[] = ['ssh', 'hyperv', 'adb']
const AUTHS: AuthMethod[] = ['password', 'key', 'none']
const LEVELS: AccessLevel[] = ['read', 'ask', 'full']
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/

const secretNames = (id: string) => ({ password: `device.${id}.password`, passphrase: `device.${id}.passphrase` })

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid ${what}`)
  return value.trim()
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`Invalid ${what}`)
  return value as T
}

/** What a person should read when something goes wrong with a connection. */
export function explainError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string } | null)?.code
  if (code === 'ECONNREFUSED') return 'The computer refused the connection. Is its SSH server running, and is the port right?'
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) return 'The computer did not answer in time. Check the address, and that it is on and reachable from here.'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That name could not be found. Check the spelling, or use the IP address.'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'That address cannot be reached from this network.'
  if (code === 'ECONNRESET') return 'The connection was cut off.'
  return message
}

export class DeviceService {
  private readonly store: Store
  private readonly pool = new Map<string, { signature: string; connector: Connector }>()
  private qr: { cancel(): void } | null = null

  constructor(private readonly opts: DeviceServiceOptions) {
    this.store = opts.store
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private changed(): void {
    this.opts.push({ type: 'devices' })
  }

  /** Stops open connections. Called when Celeste quits. */
  async close(): Promise<void> {
    this.qr?.cancel()
    await Promise.all([...this.pool.values()].map((p) => p.connector.close().catch(() => undefined)))
    this.pool.clear()
  }

  // --- reaching a device -----------------------------------------------------------------------------

  require(id: string): DeviceRecord {
    const device = this.store.getDevice(id)
    if (!device) throw new Error('That device no longer exists.')
    return device
  }

  private targetOf(d: DeviceRecord): DeviceTarget {
    return {
      kind: d.kind,
      host: d.host,
      port: d.port,
      username: d.username,
      authMethod: d.authMethod,
      keyPath: d.keyPath,
      shell: d.shell,
      os: d.os,
      hostKeySha256: d.hostKeySha256
    }
  }

  private async credentialsOf(d: DeviceRecord): Promise<Credentials> {
    const names = secretNames(d.id)
    if (d.authMethod === 'password') {
      const password = await this.opts.getSecret(names.password)
      if (!password) throw new Error('The password for this device is missing. Edit the device and enter it again.')
      return { password }
    }
    if (d.authMethod === 'key') return { passphrase: (await this.opts.getSecret(names.passphrase)) ?? undefined }
    return {}
  }

  private forget(id: string): void {
    const pooled = this.pool.get(id)
    this.pool.delete(id)
    void pooled?.connector.close().catch(() => undefined)
  }

  /** A connector for the device, reused while nothing about the device has changed. */
  async connector(device: DeviceRecord): Promise<Connector> {
    const target = this.targetOf(device)
    const signature = JSON.stringify([target.host, target.port, target.username, target.authMethod, target.keyPath, target.hostKeySha256, target.shell, target.os])
    const pooled = this.pool.get(device.id)
    if (pooled && pooled.signature === signature) return pooled.connector
    this.forget(device.id)
    const connector = this.opts.connectorFor(target, await this.credentialsOf(device), {
      portChanged: (port) => {
        this.store.patchDevice(device.id, { port })
        this.changed()
      }
    })
    this.pool.set(device.id, { signature, connector })
    return connector
  }

  record(deviceId: string, sessionId: string | null, tool: string, summary: string, ok: boolean, bytes = 0): void {
    this.store.addActivity({ deviceId, sessionId, tool, summary: summary.slice(0, 500), ok, bytes, at: this.now() })
  }

  // --- the methods the window can call ---------------------------------------------------------------

  readonly api: DeviceApi = {
    'devices.list': async () => this.store.listDevices(),
    'devices.create': async (input) => this.create(input),
    'devices.update': async (id, patch) => this.update(id, patch),
    'devices.remove': async (id) => this.remove(id),
    'devices.test': async (id) => this.test(id),
    'devices.trustKey': async (id, fingerprint) => this.trustKey(id, fingerprint),
    'devices.discover': async () => (await this.opts.discover?.()) ?? [],
    'devices.pairByCode': async (address, code, name) => this.pairByCode(address, code, name),
    'devices.startQrPairing': async (name) => this.startQrPairing(name),
    'devices.cancelQrPairing': async () => this.qr?.cancel(),
    'devices.attach': async (sessionId, deviceId, on) => this.attach(sessionId, deviceId, on),
    'devices.attached': async (sessionId) => this.store.attachedDevices(sessionId),
    'devices.browse': async (deviceId, path) => this.browse(deviceId, path),
    'devices.folders': async () => this.store.listFolders(),
    'devices.addFolder': async (deviceId, path, mode, confirm) => this.addFolder(deviceId, path, mode, confirm === true),
    'devices.refreshFolder': async (folderId) => this.refreshFolder(folderId),
    'devices.removeFolder': async (folderId) => this.removeFolder(folderId),
    'devices.activity': async (deviceId) => this.store.activity(this.require(deviceId).id, 100),
    'devices.toolServer': async () => null
  }

  private create(input: NewDevice): DeviceRecord {
    const kind = oneOf(input.kind, KINDS, 'kind')
    const device: DeviceRecord = {
      id: `dev-${crypto.randomUUID()}`,
      name: text(input.name, 'name', 80),
      kind,
      host: text(input.host, 'address', 253),
      port: input.port === undefined ? DEFAULT_PORT[kind] : Math.round(Number(input.port)),
      username: text(input.username, 'user name', 100),
      authMethod: oneOf(input.authMethod, AUTHS, 'sign-in method'),
      ...(input.keyPath ? { keyPath: text(input.keyPath, 'key path', 500) } : {}),
      os: kind === 'adb' ? 'android' : 'unknown',
      shell: kind === 'adb' ? 'adb' : 'posix',
      // A new device can be looked at but not touched, until you say otherwise.
      accessLevel: 'read',
      hostKeySha256: null,
      createdAt: this.now(),
      lastSeenAt: null
    }
    if (!(device.port >= 0 && device.port <= 65535)) throw new Error('Invalid port')
    if (device.authMethod === 'key' && !device.keyPath) throw new Error('Choose the key file to sign in with.')
    this.store.insertDevice(device)
    this.changed()
    return device
  }

  private update(id: string, patch: DevicePatch): DeviceRecord {
    const current = this.require(id)
    const next: Partial<DeviceRecord> = {}
    if (patch.name !== undefined) next.name = text(patch.name, 'name', 80)
    if (patch.host !== undefined) next.host = text(patch.host, 'address', 253)
    if (patch.port !== undefined) next.port = Math.round(Number(patch.port))
    if (patch.username !== undefined) next.username = text(patch.username, 'user name', 100)
    if (patch.authMethod !== undefined) next.authMethod = oneOf(patch.authMethod, AUTHS, 'sign-in method')
    if (patch.keyPath !== undefined) next.keyPath = text(patch.keyPath, 'key path', 500)
    if (patch.accessLevel !== undefined) next.accessLevel = oneOf(patch.accessLevel, LEVELS, 'access level')
    if (next.port !== undefined && !(next.port >= 0 && next.port <= 65535)) throw new Error('Invalid port')
    // A different address is a different computer until the person confirms its key again.
    if ((next.host !== undefined && next.host !== current.host) || (next.port !== undefined && next.port !== current.port)) {
      next.hostKeySha256 = null
    }
    const updated = this.store.patchDevice(id, next) as DeviceRecord
    this.forget(id)
    this.record(id, null, 'settings', next.accessLevel ? `Access level set to ${next.accessLevel}` : 'Settings changed', true)
    this.changed()
    return updated
  }

  private async remove(id: string): Promise<void> {
    this.require(id)
    this.forget(id)
    this.store.deleteDevice(id)
    // Copies of folders taken from this device go too.
    await this.opts.fs.remove(this.opts.fs.join(this.opts.dataDir, 'devices', id)).catch(() => undefined)
    this.changed()
  }

  private async test(id: string): Promise<TestResult> {
    const device = this.require(id)
    try {
      const probe = await (await this.connector(device)).probe()
      const updated = this.store.patchDevice(id, { os: probe.os, shell: probe.shell, lastSeenAt: this.now() }) as DeviceRecord
      this.forget(id) // the next connection learns the shell
      this.record(id, null, 'test', `Connected as ${probe.user} on ${probe.hostname} (${probe.os})`, true)
      this.changed()
      return { ok: true, probe, device: updated }
    } catch (err) {
      this.forget(id)
      if (err instanceof HostKeyError) {
        return {
          ok: false,
          error: err.message,
          hostKey: err.state === 'unknown' ? { state: 'unknown', fingerprint: err.fingerprint } : { state: 'changed', fingerprint: err.fingerprint, expected: err.expected as string }
        }
      }
      const error = explainError(err)
      this.record(id, null, 'test', error, false)
      return { ok: false, error }
    }
  }

  private trustKey(id: string, fingerprint: string): DeviceRecord {
    this.require(id)
    if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) throw new Error('Invalid fingerprint')
    const updated = this.store.patchDevice(id, { hostKeySha256: fingerprint }) as DeviceRecord
    this.forget(id)
    this.record(id, null, 'trust', `Trusted host key ${fingerprint}`, true)
    this.changed()
    return updated
  }

  // --- Android ---------------------------------------------------------------------------------------

  private async adopt(name: string, host: string, port: number): Promise<DeviceRecord> {
    const device = this.create({ name, kind: 'adb', host, port, username: 'shell', authMethod: 'none' })
    this.store.patchDevice(device.id, { hostKeySha256: null })
    return device
  }

  private async pairByCode(address: string, code: string, name: string): Promise<DeviceRecord> {
    if (!this.opts.pairing) throw new Error('Pairing a phone is not available here.')
    if (typeof address !== 'string' || !/^[\w.\-:[\]]{3,100}$/.test(address)) throw new Error('Enter the address and port the phone shows, like 192.168.1.20:37099.')
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('The pairing code is six digits.')
    const { host, port } = await this.opts.pairing.pairByCode(address, code)
    return this.adopt(text(name, 'name', 80), host, port)
  }

  private async startQrPairing(name: string): Promise<{ payload: string }> {
    if (!this.opts.pairing) throw new Error('Pairing a phone is not available here.')
    const clean = text(name, 'name', 80)
    this.qr?.cancel()
    const session = this.opts.pairing.startQr(
      clean,
      (found) => {
        this.qr = null
        void this.adopt(clean, found.host, found.port).then(() => this.changed())
      },
      () => {
        this.qr = null
      }
    )
    this.qr = session
    return { payload: session.payload }
  }

  // --- attaching, browsing, folders ------------------------------------------------------------------

  private attach(sessionId: string, deviceId: string, on: boolean): string[] {
    this.require(deviceId)
    if (typeof sessionId !== 'string' || !this.store.getSession(sessionId)) throw new Error('That session no longer exists.')
    this.store.setAttached(sessionId, deviceId, on)
    this.changed()
    return this.store.attachedDevices(sessionId)
  }

  private async browse(deviceId: string, path: string): Promise<DirEntry[]> {
    const device = this.require(deviceId)
    if (typeof path !== 'string' || path.length > 1000) throw new Error('Invalid path')
    try {
      return await (await this.connector(device)).list(path || '/')
    } catch (err) {
      throw new Error(err instanceof HostKeyError ? `${err.message} Test the connection again.` : explainError(err))
    }
  }

  /** Lists the files a snapshot would copy, within the limits. */
  private async measure(connector: Connector, root: string) {
    const files: { remote: string; rel: string; size: number }[] = []
    let bytes = 0
    const stack = [{ remote: root, rel: '', depth: 0 }]
    while (stack.length) {
      const { remote, rel, depth } = stack.pop() as { remote: string; rel: string; depth: number }
      let entries: DirEntry[]
      try {
        entries = await connector.list(remote)
      } catch {
        continue
      }
      for (const e of entries) {
        const childRemote = remote.endsWith('/') ? `${remote}${e.name}` : `${remote}/${e.name}`
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.type === 'dir') {
          if (!(DEVICE_LIMITS.snapshotSkip as readonly string[]).includes(e.name) && depth < 12) stack.push({ remote: childRemote, rel: childRel, depth: depth + 1 })
        } else if (e.type === 'file' && e.size <= DEVICE_LIMITS.snapshotFileBytes) {
          files.push({ remote: childRemote, rel: childRel, size: e.size })
          bytes += e.size
          if (files.length > 200_000) throw new Error('That folder has too many files to copy. Choose a smaller one.')
        }
      }
    }
    return { files, bytes }
  }

  private async copyFolder(device: DeviceRecord, folder: StoredFolder, confirm: boolean): Promise<AddFolderResult> {
    const connector = await this.connector(device)
    const { files, bytes } = await this.measure(connector, folder.path)
    const above = this.opts.confirmAbove ?? { files: DEVICE_LIMITS.snapshotConfirmFiles, bytes: DEVICE_LIMITS.snapshotConfirmBytes }
    if (!confirm && (bytes > above.bytes || files.length > above.files)) {
      return { ok: false, needsConfirm: { files: files.length, bytes } }
    }
    const dir = this.opts.fs.join(this.opts.dataDir, 'devices', device.id, folder.id)
    await this.opts.fs.remove(dir).catch(() => undefined)
    await this.opts.fs.mkdirp(dir)
    let copied = 0
    let copiedBytes = 0
    for (const f of files) {
      const target = this.opts.fs.join(dir, ...f.rel.split('/'))
      try {
        await this.opts.fs.mkdirp(this.opts.fs.dirname(target))
        await connector.download(f.remote, target)
        copied++
        copiedBytes += f.size
      } catch {
        // A file that cannot be copied (a name Windows does not allow, say) is left out. The rest still come.
      }
    }
    this.store.patchFolder(folder.id, { snapshotPath: dir, snapshotAt: this.now(), bytes: copiedBytes, files: copied })
    this.record(device.id, null, 'snapshot', `Copied ${copied} files (${copiedBytes} bytes) from ${folder.path}`, true, copiedBytes)
    this.changed()
    return { ok: true, folder: this.store.listFolders().find((f) => f.id === folder.id) as StoredFolder }
  }

  private async addFolder(deviceId: string, path: string, mode: FolderMode, confirm: boolean): Promise<AddFolderResult> {
    const device = this.require(deviceId)
    oneOf(mode, ['live', 'snapshot'] as const, 'mode')
    const clean = text(path, 'folder', 1000)
    const folder: StoredFolder = { id: `fld-${crypto.randomUUID()}`, deviceId, path: clean, mode, snapshotPath: null, snapshotAt: null, bytes: 0, files: 0, createdAt: this.now() }
    if (mode === 'live') {
      this.store.insertFolder(folder)
      this.changed()
      const { snapshotPath: _p, ...plain } = folder
      return { ok: true, folder: plain }
    }
    this.store.insertFolder(folder)
    try {
      const result = await this.copyFolder(device, folder, confirm)
      if (!result.ok) this.store.deleteFolder(folder.id)
      return result
    } catch (err) {
      this.store.deleteFolder(folder.id)
      throw new Error(explainError(err))
    }
  }

  private async refreshFolder(folderId: string): Promise<AddFolderResult> {
    const folder = this.store.getFolder(folderId)
    if (!folder) throw new Error('That folder no longer exists.')
    if (folder.mode !== 'snapshot') throw new Error('Only a snapshot can be refreshed.')
    try {
      return await this.copyFolder(this.require(folder.deviceId), folder, true)
    } catch (err) {
      throw new Error(explainError(err))
    }
  }

  private async removeFolder(folderId: string): Promise<void> {
    const folder = this.store.deleteFolder(folderId)
    if (folder?.snapshotPath) await this.opts.fs.remove(folder.snapshotPath).catch(() => undefined)
    this.changed()
  }

  /** Local paths of the snapshots a session can use as extra folders. */
  snapshotDirs(sessionId: string): string[] {
    const attached = new Set(this.store.attachedDevices(sessionId))
    return this.store
      .listFolders()
      .filter((f) => f.mode === 'snapshot' && attached.has(f.deviceId))
      .map((f) => this.store.getFolder(f.id)?.snapshotPath)
      .filter((p): p is string => !!p)
  }
}
