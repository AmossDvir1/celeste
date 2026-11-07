import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceProbe, DirEntry } from '@shared/devices'
import {
  OutputCollector,
  type Connector,
  type ConnectorHooks,
  type DeviceTarget,
  type ReadResult,
  type RunOptions,
  type RunResult
} from './connector'
import { runProcess, textOf, type Exec } from './exec'

/** Where Google's `adb` is, if it is installed: an override, the Android SDK, or the PATH. */
export function findAdb(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): string | null {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb'
  const sep = platform === 'win32' ? '\\' : '/'
  const candidates = [
    env.CELESTE_ADB,
    env.ANDROID_HOME && `${env.ANDROID_HOME}${sep}platform-tools${sep}${exe}`,
    env.ANDROID_SDK_ROOT && `${env.ANDROID_SDK_ROOT}${sep}platform-tools${sep}${exe}`,
    env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\${exe}`,
    env.HOME && `${env.HOME}/Library/Android/sdk/platform-tools/${exe}`,
    env.HOME && `${env.HOME}/Android/Sdk/platform-tools/${exe}`,
    ...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map((d) => `${d}${sep}${exe}`)
  ].filter((p): p is string => !!p)
  return candidates.find((p) => exists(p)) ?? null
}

export interface AdbService {
  instance: string
  host: string
  port: number
  kind: 'connect' | 'pairing'
}

/** The services `adb mdns services` lists: the phone announces when it is ready to pair or to connect. */
export function parseMdns(text: string): AdbService[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = /^(\S+)\s+_adb-tls-(connect|pairing)\._tcp\.?\s+(\d+\.\d+\.\d+\.\d+):(\d+)\s*$/.exec(line.trim())
    return m ? [{ instance: m[1], kind: m[2] as 'connect' | 'pairing', host: m[3], port: Number(m[4]) }] : []
  })
}

/** One argument for the phone's shell, quoted so it arrives as written. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const LS_LINE = /^([-dlbcps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+?)(?: -> .*)?$/

export function parseLs(text: string): DirEntry[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = LS_LINE.exec(line.trim())
    if (!m || m[5] === '.' || m[5] === '..') return []
    const type: DirEntry['type'] = m[1] === 'd' ? 'dir' : m[1] === 'l' ? 'link' : m[1] === '-' ? 'file' : 'other'
    return [{ name: m[5], type, size: Number(m[2]), modified: Date.parse(`${m[3]}T${m[4]}:00`) || 0 }]
  })
}

export class AdbConnector implements Connector {
  private connected = false

  constructor(
    private readonly target: DeviceTarget,
    private readonly adb: string | null,
    private readonly exec: Exec = runProcess,
    private readonly hooks: ConnectorHooks = {}
  ) {}

  private get serial() {
    return `${this.target.host}:${this.target.port}`
  }

  private async adbExec(args: string[], options: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {}) {
    if (!this.adb) throw new Error('Android’s adb tool was not found. Install Android platform-tools, or set CELESTE_ADB to its path.')
    const r = await this.exec(this.adb, args, options)
    if (r.missing) throw new Error('Android’s adb tool could not be started.')
    return r
  }

  /** `adb connect`, and if the phone moved to a new port (it picks a new one each time Wireless debugging is switched on), finds it. */
  private async connect(): Promise<void> {
    if (this.connected) return
    const attempt = async () => {
      const r = await this.adbExec(['connect', this.serial], { timeoutMs: 15_000 })
      const out = textOf(r.stdout) + textOf(r.stderr)
      return /connected to|already connected/i.test(out) && !/failed|cannot|unable/i.test(out)
    }
    if (await attempt()) {
      this.connected = true
      return
    }
    const r = await this.adbExec(['mdns', 'services'], { timeoutMs: 10_000 })
    const found = parseMdns(textOf(r.stdout)).find((s) => s.kind === 'connect' && s.host === this.target.host)
    if (found && found.port !== this.target.port) {
      this.target.port = found.port
      this.hooks.portChanged?.(found.port)
      if (await attempt()) {
        this.connected = true
        return
      }
    }
    throw new Error('Could not reach the phone. Is Wireless debugging on, and is the phone on the same Wi-Fi as this computer?')
  }

  private async onDevice(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number }) {
    await this.connect()
    return this.adbExec(['-s', this.serial, ...args], options)
  }

  async probe(): Promise<DeviceProbe> {
    const r = await this.onDevice(['shell', 'getprop ro.product.model; id -un'], { timeoutMs: 20_000 })
    if (r.code !== 0) throw new Error(textOf(r.stderr).trim() || 'The phone did not answer.')
    const lines = textOf(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    return { os: 'android', shell: 'adb', user: lines[1] ?? 'shell', hostname: lines[0] ?? this.target.host }
  }

  async run(command: string, options: RunOptions): Promise<RunResult> {
    // The subshell sends errors into the same stream, so output stays in the order it happened.
    const r = await this.onDevice(['shell', `(${command}) 2>&1`], { timeoutMs: options.timeoutMs, signal: options.signal, maxBytes: options.maxBytes * 4 })
    if (r.timedOut || r.cancelled) return { exitCode: null, output: '', truncated: false, timedOut: r.timedOut, cancelled: r.cancelled }
    const collector = new OutputCollector(options.maxBytes)
    collector.push(Buffer.concat([r.stdout, r.stderr]))
    const { text, truncated } = collector.result()
    return { exitCode: r.code, output: text, truncated, timedOut: false, cancelled: false }
  }

  async readFile(path: string, maxBytes: number): Promise<ReadResult> {
    const q = shellQuote(path)
    const probe = await this.onDevice(['shell', `if [ -d ${q} ]; then echo DIR; else stat -c %s ${q}; fi`])
    const first = textOf(probe.stdout).trim()
    if (first === 'DIR') throw new Error(`${path} is a folder, not a file.`)
    const size = Number.parseInt(first, 10)
    if (probe.code !== 0 || Number.isNaN(size)) throw new Error(`${path}: ${textOf(probe.stderr).trim() || 'no such file'}`)
    const data = await this.onDevice(['exec-out', `head -c ${Math.min(size, maxBytes)} ${q}`], { maxBytes: maxBytes + 1024 })
    return { data: data.stdout, size, truncated: size > maxBytes }
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'celeste-adb-'))
    try {
      const local = join(dir, 'upload')
      writeFileSync(local, content)
      const r = await this.onDevice(['push', local, path], { timeoutMs: 60_000 })
      if (r.code !== 0) throw new Error(textOf(r.stderr).trim() || `Could not write ${path}.`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    const r = await this.onDevice(['shell', `ls -lA ${shellQuote(path)}`])
    if (r.code !== 0) throw new Error(`${path}: ${(textOf(r.stderr) || textOf(r.stdout)).trim() || 'no such folder'}`)
    return parseLs(textOf(r.stdout)).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const r = await this.onDevice(['pull', remotePath, localPath], { timeoutMs: 120_000 })
    if (r.code !== 0) throw new Error(textOf(r.stderr).trim() || `Could not copy ${remotePath}.`)
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.onDevice(['exec-out', 'screencap -p'], { timeoutMs: 20_000, maxBytes: 32 * 1024 * 1024 })
    if (r.stdout.length < 8 || r.stdout[0] !== 0x89 || r.stdout[1] !== 0x50) throw new Error('The phone did not return a screenshot. Is the screen on and unlocked?')
    return r.stdout
  }

  async close(): Promise<void> {}
}
