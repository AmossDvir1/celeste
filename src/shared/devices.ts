// Devices: other computers, VMs and phones the assistant can work on. See plan section 7.11.

export type DeviceKind = 'ssh' | 'hyperv' | 'adb'
/** Read only: file tools only. Ask first: commands and writes, each approved. Full: no asking. */
export type AccessLevel = 'read' | 'ask' | 'full'
export type DeviceOs = 'linux' | 'mac' | 'windows' | 'android' | 'unknown'
/** The language commands to the device are written in: a POSIX shell, PowerShell, or `adb shell`. */
export type DeviceShell = 'posix' | 'powershell' | 'adb'
export type AuthMethod = 'password' | 'key' | 'ask' | 'none'

export interface DeviceRecord {
  id: string
  name: string
  kind: DeviceKind
  /** An address, or for Hyper-V the VM's name. */
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** For key sign-in: where the private key is. The key itself is never copied. */
  keyPath?: string
  os: DeviceOs
  shell: DeviceShell
  accessLevel: AccessLevel
  /** SHA-256 of the host key, pinned the first time you confirmed it. */
  hostKeySha256: string | null
  createdAt: number
  /** Null until a test connection has worked. */
  lastSeenAt: number | null
}

export interface NewDevice {
  name: string
  kind: DeviceKind
  host: string
  port?: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
}

export type DevicePatch = Partial<Pick<DeviceRecord, 'name' | 'host' | 'port' | 'username' | 'authMethod' | 'keyPath' | 'accessLevel'>>

export interface DirEntry {
  name: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  modified: number
}

/** What a test connection learned about the device. */
export interface DeviceProbe {
  os: DeviceOs
  shell: DeviceShell
  user: string
  hostname: string
}

export type HostKeyState =
  | { state: 'unknown'; fingerprint: string }
  | { state: 'changed'; fingerprint: string; expected: string }

export type TestResult =
  | { ok: true; probe: DeviceProbe; device: DeviceRecord }
  | { ok: false; error: string; hostKey?: HostKeyState }

export type FolderMode = 'live' | 'snapshot'

export interface DeviceFolder {
  id: string
  deviceId: string
  path: string
  mode: FolderMode
  snapshotAt: number | null
  bytes: number
  files: number
  createdAt: number
}

/** Adding a snapshot first measures the folder. A large one needs a second call with `confirm`. */
export type AddFolderResult =
  | { ok: true; folder: DeviceFolder }
  | { ok: false; needsConfirm: { files: number; bytes: number } }

export interface DeviceActivity {
  id: number
  deviceId: string
  sessionId: string | null
  tool: string
  summary: string
  ok: boolean
  bytes: number
  at: number
}

/** Something found on the network or on this computer that could be added. */
export interface FoundDevice {
  key: string
  kind: DeviceKind
  name: string
  host: string
  port: number
  /** Where it was found: network announcement, or a VM product on this computer. */
  source: string
  /** True for an Android phone showing its pairing screen. */
  pairing?: boolean
}

export const DEFAULT_PORT: Record<DeviceKind, number> = { ssh: 22, hyperv: 0, adb: 5555 }

/** Limits that keep one call from flooding the model or hanging. */
export const DEVICE_LIMITS = {
  outputBytes: 64 * 1024,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 10 * 60_000,
  readBytes: 256 * 1024,
  snapshotFileBytes: 25 * 1024 * 1024,
  snapshotConfirmBytes: 200 * 1024 * 1024,
  snapshotConfirmFiles: 10_000,
  snapshotSkip: ['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', '__pycache__', '.venv']
} as const
