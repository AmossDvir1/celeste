import type { DeviceOs, DeviceProbe, DirEntry } from '@shared/devices'
import {
  HostKeyError,
  OutputCollector,
  type Connector,
  type ConnectorFactory,
  type Credentials,
  type DeviceTarget,
  type ReadResult,
  type RunOptions,
  type RunResult
} from '../devices/connector'

/**
 * A pretend device, for the browser preview (which has no sockets) and for tests of the layers above the
 * connector. It answers a few commands and keeps files in memory.
 */
export function fakeFingerprint(host: string): string {
  // A stable, fingerprint-shaped string made from the address. Not a real hash: this device is pretend.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let seed = 2166136261
  for (const ch of `fake-host-key:${host}`) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0
  let text = ''
  for (let i = 0; i < 43; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    text += alphabet[seed >>> 26]
  }
  return `SHA256:${text}`
}

type Tree = Record<string, string | null>

const SAMPLE_POSIX: Tree = {
  '/home/dev/README.md': '# Build server\nNightly builds run at 02:00.\n',
  '/home/dev/notes.txt': 'rotate the logs on Friday\n',
  '/home/dev/app/package.json': '{ "name": "app", "version": "1.4.2" }\n',
  '/home/dev/app/src/index.ts': 'export const answer = 42\n',
  '/home/dev/app/src/util.ts': 'export const double = (n: number) => n * 2\n',
  '/var/log/build.log': 'build 1031 ok\nbuild 1032 ok\nbuild 1033 FAILED (test timeout)\n'
}
const SAMPLE_WINDOWS: Tree = {
  '/C:/Users/dev/Documents/report.txt': 'Quarterly figures are in the spreadsheet.\n',
  '/C:/Users/dev/Documents/todo.txt': 'install the November updates\n'
}

export class FakeConnector implements Connector {
  readonly files: Tree
  readonly ran: string[] = []

  constructor(
    private readonly target: DeviceTarget,
    files?: Tree
  ) {
    this.files = files ?? (target.os === 'windows' ? { ...SAMPLE_WINDOWS } : { ...SAMPLE_POSIX })
  }

  private guard(): void {
    if (this.target.hostKeySha256 === null) throw new HostKeyError('unknown', fakeFingerprint(this.target.host))
    if (this.target.hostKeySha256 !== fakeFingerprint(this.target.host)) {
      throw new HostKeyError('changed', fakeFingerprint(this.target.host), this.target.hostKeySha256)
    }
  }

  async probe(): Promise<DeviceProbe> {
    this.guard()
    const os: DeviceOs = this.target.os === 'unknown' ? (/win/i.test(this.target.host) ? 'windows' : 'linux') : this.target.os
    return { os, shell: os === 'windows' ? 'powershell' : os === 'android' ? 'adb' : 'posix', user: this.target.username, hostname: this.target.host }
  }

  async run(command: string, options: RunOptions): Promise<RunResult> {
    this.guard()
    this.ran.push(command)
    const out = new OutputCollector(options.maxBytes)
    let code = 0
    const say = (text: string) => out.push(Buffer.from(text))
    if (/^echo /.test(command) || /^Write-Output /.test(command)) say(`${command.replace(/^\S+ /, '')}\n`)
    else if (/^df\b|^uname\b/.test(command)) {
      say('Linux fake-host 6.8.0 x86_64\nFilesystem  Size  Used Avail Use% Mounted on\n/dev/sda1    80G   31G   45G  41% /\n')
    } else if (/Get-PSDrive/.test(command)) say('Name  Used(GB)  Free(GB)\nC        212       264\n')
    else if (/^hostname|COMPUTERNAME/.test(command)) say(`${this.target.host}\n`)
    else {
      say(`${command.split(' ')[0]}: command not found\n`)
      code = 127
    }
    const { text, truncated } = out.result()
    return { exitCode: code, output: text, truncated, timedOut: false, cancelled: false }
  }

  async readFile(path: string, maxBytes: number): Promise<ReadResult> {
    this.guard()
    const text = this.files[path]
    if (text === undefined) throw new Error(`${path}: no such file`)
    if (text === null) throw new Error(`${path} is a folder, not a file.`)
    const data = Buffer.from(text)
    return { data: data.subarray(0, maxBytes), size: data.length, truncated: data.length > maxBytes }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    this.guard()
    this.files[path] = data.toString('utf8')
  }

  async list(path: string): Promise<DirEntry[]> {
    this.guard()
    const base = path.replace(/\/+$/, '')
    const children = new Map<string, DirEntry>()
    for (const [file, content] of Object.entries(this.files)) {
      if (!file.startsWith(`${base}/`)) continue
      const rest = file.slice(base.length + 1)
      const [name, ...more] = rest.split('/')
      if (!name) continue
      const isDir = more.length > 0 || content === null
      const entry: DirEntry = { name, type: isDir ? 'dir' : 'file', size: isDir ? 0 : Buffer.byteLength(content ?? ''), modified: Date.UTC(2026, 10, 1) }
      if (!children.has(name) || isDir) children.set(name, entry)
    }
    if (children.size === 0 && !Object.keys(this.files).some((f) => f === base || f.startsWith(`${base}/`))) {
      if (base !== '' && base !== '/') throw new Error(`${path}: no such folder`)
    }
    return [...children.values()].sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
  }

  async download(): Promise<void> {
    this.guard()
  }

  async close(): Promise<void> {}
}

/** One shared set of pretend files per address, so a test can change a file and see it later. */
export function fakeConnectorFactory(trees: Record<string, Tree> = {}): ConnectorFactory & { made: FakeConnector[] } {
  const made: FakeConnector[] = []
  const make: ConnectorFactory = (target: DeviceTarget, _credentials: Credentials) => {
    const connector = new FakeConnector(target, trees[target.host])
    if (!trees[target.host]) trees[target.host] = connector.files
    made.push(connector)
    return connector
  }
  return Object.assign(make, { made })
}
