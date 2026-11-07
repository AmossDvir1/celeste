import type { DeviceKind, DeviceOs, DeviceProbe, DeviceShell, DirEntry, AuthMethod } from '@shared/devices'

/*
 * What every way of reaching a device has in common. SSH, Hyper-V and Android each implement it, so the
 * device tools, the approval gate and the screens never care which one is behind a device.
 */

export interface DeviceTarget {
  kind: DeviceKind
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
  shell: DeviceShell
  os: DeviceOs
  /** The pinned host key. Null means it has not been confirmed yet. */
  hostKeySha256: string | null
}

/** Secrets for one connection. They come from the main process and are held in memory only. */
export interface Credentials {
  password?: string
  passphrase?: string
}

export interface RunOptions {
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
}

export interface RunResult {
  exitCode: number | null
  /** Standard output and error together, in the order they arrived, cut at `maxBytes`. */
  output: string
  truncated: boolean
  timedOut: boolean
  cancelled: boolean
}

export interface ReadResult {
  data: Buffer
  size: number
  truncated: boolean
}

export interface Connector {
  /** Connects, works out the operating system and shell, and returns who we are signed in as. */
  probe(): Promise<DeviceProbe>
  run(command: string, options: RunOptions): Promise<RunResult>
  readFile(path: string, maxBytes: number): Promise<ReadResult>
  writeFile(path: string, data: Buffer): Promise<void>
  list(path: string): Promise<DirEntry[]>
  /** Copies one remote file to a local path. */
  download(remotePath: string, localPath: string): Promise<void>
  /** A PNG of the screen, for devices that can give one (Android). */
  screenshot?(): Promise<Buffer>
  close(): Promise<void>
}

/** Things a connector can tell the rest of the app while it works. */
export interface ConnectorHooks {
  /** A phone moved to a new port (Android picks a new one each time Wireless debugging is switched on). */
  portChanged?(port: number): void
}

export type ConnectorFactory = (target: DeviceTarget, credentials: Credentials, hooks?: ConnectorHooks) => Connector

/** The host key was not confirmed yet, or is not the one that was confirmed. Nothing was sent. */
export class HostKeyError extends Error {
  constructor(
    readonly state: 'unknown' | 'changed',
    readonly fingerprint: string,
    readonly expected?: string
  ) {
    super(state === 'unknown' ? 'This computer has not been confirmed yet.' : 'This computer’s identity has changed.')
  }
}

/** `SHA256:` and the base64 text OpenSSH shows, from the hex digest ssh2 hands over. */
export function fingerprintFromHex(hex: string): string {
  return `SHA256:${Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')}`
}

/**
 * Keeps the start and the end of output that is too long, which is where the command and its result usually
 * are, and says how much was left out.
 */
export class OutputCollector {
  private head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  private total = 0
  private readonly half: number

  constructor(max: number) {
    this.half = Math.max(1, Math.floor(max / 2))
  }

  push(chunk: Buffer): void {
    this.total += chunk.length
    if (this.headBytes < this.half) {
      const take = chunk.subarray(0, this.half - this.headBytes)
      this.head.push(take)
      this.headBytes += take.length
      chunk = chunk.subarray(take.length)
    }
    if (chunk.length === 0) return
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes - this.tail[0].length >= this.half) this.tailBytes -= (this.tail.shift() as Buffer).length
  }

  result(): { text: string; truncated: boolean } {
    const head = Buffer.concat(this.head)
    let tail = Buffer.concat(this.tail)
    if (tail.length > this.half) tail = tail.subarray(tail.length - this.half)
    const omitted = this.total - head.length - tail.length
    if (omitted <= 0) return { text: Buffer.concat([head, tail]).toString('utf8'), truncated: false }
    return { text: `${head.toString('utf8')}\n[… ${omitted} bytes left out …]\n${tail.toString('utf8')}`, truncated: true }
  }
}

/** Runs one at a time. Commands to one device queue up instead of running over each other. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }
}

/**
 * A PowerShell command as the command line that runs it. It is sent encoded, so quotes, dollar signs and line
 * breaks arrive exactly as written, and output is switched to UTF-8 so accents survive.
 */
export function powershellCommand(script: string): string {
  const prelude = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
  const encoded = Buffer.from(prelude + script, 'utf16le').toString('base64')
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}

/**
 * PowerShell reports errors as XML on the error stream when its output is piped. This turns that back into the
 * message a person would have seen.
 */
export function cleanClixml(text: string): string {
  if (!text.includes('#< CLIXML')) return text
  const decode = (s: string) =>
    s
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/_x000A_/g, '\n')
      .replace(/_x000D_/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  const [before, ...blocks] = text.split('#< CLIXML')
  const messages = blocks.map((block) =>
    [...block.matchAll(/<S S="(?:Error|error)">([\s\S]*?)<\/S>/g)].map((m) => decode(m[1])).join('')
  )
  return (before + messages.join('')).replace(/\n{3,}/g, '\n\n').trim()
}
