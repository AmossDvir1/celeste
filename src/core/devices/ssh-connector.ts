import { readFileSync } from 'node:fs'
import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from 'ssh2'
import type { DeviceOs, DeviceProbe, DeviceShell, DirEntry } from '@shared/devices'
import {
  HostKeyError,
  Mutex,
  OutputCollector,
  cleanClixml,
  fingerprintFromHex,
  powershellCommand,
  type Connector,
  type Credentials,
  type DeviceTarget,
  type ReadResult,
  type RunOptions,
  type RunResult
} from './connector'

/**
 * SSH to Linux, Mac, a Raspberry Pi or a NAS, or to Windows through its OpenSSH Server. Windows commands run as
 * PowerShell. The host key is checked against the pinned one before anything is sent, and files travel over SFTP.
 */
export class SshConnector implements Connector {
  private client: Promise<Client> | null = null
  private sftpPromise: Promise<SFTPWrapper> | null = null
  private readonly lock = new Mutex()
  private shell: DeviceShell
  private os: DeviceOs

  constructor(
    private readonly target: DeviceTarget,
    private readonly credentials: Credentials,
    private readonly options: { readyTimeoutMs?: number } = {}
  ) {
    this.shell = target.shell
    this.os = target.os
  }

  private config(onKey: (fingerprint: string) => boolean): ConnectConfig {
    const t = this.target
    const config: ConnectConfig = {
      host: t.host,
      port: t.port,
      username: t.username,
      readyTimeout: this.options.readyTimeoutMs ?? 15_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (hash: string) => onKey(fingerprintFromHex(hash))
    }
    if (t.authMethod === 'key') {
      if (!t.keyPath) throw new Error('No key file was chosen for this device.')
      config.privateKey = readFileSync(t.keyPath)
      if (this.credentials.passphrase) config.passphrase = this.credentials.passphrase
    } else if (t.authMethod === 'password' || t.authMethod === 'ask') {
      if (!this.credentials.password) throw new Error('A password is needed for this device.')
      config.password = this.credentials.password
    }
    return config
  }

  private connect(): Promise<Client> {
    if (this.client) return this.client
    const attempt = new Promise<Client>((resolve, reject) => {
      let issue: HostKeyError | null = null
      const client = new Client()
      let config: ConnectConfig
      try {
        config = this.config((fingerprint) => {
          const pinned = this.target.hostKeySha256
          if (pinned === fingerprint) return true
          issue = pinned === null ? new HostKeyError('unknown', fingerprint) : new HostKeyError('changed', fingerprint, pinned)
          return false
        })
      } catch (err) {
        reject(err)
        return
      }
      client.once('ready', () => resolve(client))
      // Kept for the life of the connection: a reset after connecting must not crash the process.
      client.on('error', (err: Error & { level?: string }) => {
        if (issue) reject(issue)
        else if (err.level === 'client-authentication') reject(new Error('The sign-in was refused. Check the user name and the password or key.'))
        else reject(err)
        this.client = null
        this.sftpPromise = null
      })
      client.once('close', () => {
        this.client = null
        this.sftpPromise = null
        if (issue) reject(issue)
      })
      client.connect(config)
    })
    this.client = attempt
    attempt.catch(() => {
      if (this.client === attempt) this.client = null
    })
    return attempt
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpPromise) return this.sftpPromise
    const attempt = this.connect().then(
      (client) =>
        new Promise<SFTPWrapper>((resolve, reject) => {
          client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
        })
    )
    this.sftpPromise = attempt
    attempt.catch(() => {
      if (this.sftpPromise === attempt) this.sftpPromise = null
    })
    return attempt
  }

  private exec(command: string, options: RunOptions): Promise<RunResult> {
    return this.connect().then(
      (client) =>
        new Promise<RunResult>((resolve, reject) => {
          client.exec(command, (err, stream) => {
            if (err) {
              reject(err)
              return
            }
            const output = new OutputCollector(options.maxBytes)
            let timedOut = false
            let cancelled = false
            const stop = () => {
              stream.signal('KILL')
              stream.close()
            }
            const timer = setTimeout(() => {
              timedOut = true
              stop()
            }, options.timeoutMs)
            const onAbort = () => {
              cancelled = true
              stop()
            }
            if (options.signal?.aborted) onAbort()
            else options.signal?.addEventListener('abort', onAbort, { once: true })
            // If the connection drops mid-command (Wi-Fi gone, machine restarted), say so instead of waiting.
            const onLost = () => {
              clearTimeout(timer)
              options.signal?.removeEventListener('abort', onAbort)
              reject(new Error('The connection to the device was lost while the command was running.'))
            }
            client.once('close', onLost)

            stream.on('data', (chunk: Buffer) => output.push(chunk))
            stream.stderr.on('data', (chunk: Buffer) => output.push(chunk))
            stream.once('close', (code: number | null) => {
              client.off('close', onLost)
              clearTimeout(timer)
              options.signal?.removeEventListener('abort', onAbort)
              const { text, truncated } = output.result()
              resolve({
                exitCode: timedOut || cancelled ? null : (code ?? null),
                output: this.shell === 'powershell' ? cleanClixml(text) : text,
                truncated,
                timedOut,
                cancelled
              })
            })
          })
        })
    )
  }

  run(command: string, options: RunOptions): Promise<RunResult> {
    const line = this.shell === 'powershell' ? powershellCommand(command) : command
    return this.lock.run(() => this.exec(line, options))
  }

  async probe(): Promise<DeviceProbe> {
    const options: RunOptions = { timeoutMs: 20_000, maxBytes: 4096 }
    // A POSIX shell first. On Windows this fails (cmd has no uname, PowerShell 5 has no &&), and PowerShell is tried.
    const posix = await this.lock.run(() => this.exec('uname -s && whoami && hostname', options))
    const lines = posix.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (posix.exitCode === 0 && /^(Linux|Darwin)/i.test(lines[0] ?? '')) {
      this.os = /^Darwin/i.test(lines[0]) ? 'mac' : 'linux'
      this.shell = 'posix'
      return { os: this.os, shell: this.shell, user: lines[1] ?? this.target.username, hostname: lines[2] ?? this.target.host }
    }
    const script = "'windows';[Environment]::UserName;[Environment]::MachineName"
    const win = await this.lock.run(() => this.exec(powershellCommand(script), options))
    const w = cleanClixml(win.output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (win.exitCode === 0 && w[0] === 'windows') {
      this.os = 'windows'
      this.shell = 'powershell'
      return { os: 'windows', shell: 'powershell', user: w[1] ?? this.target.username, hostname: w[2] ?? this.target.host }
    }
    throw new Error(`Signed in, but could not tell what kind of computer this is. ${(win.output || posix.output).trim().slice(0, 200)}`)
  }

  async readFile(path: string, maxBytes: number): Promise<ReadResult> {
    const sftp = await this.sftp()
    const size = await new Promise<number>((resolve, reject) => {
      sftp.stat(path, (err, stats) => {
        if (err) reject(err)
        else if (stats.isDirectory()) reject(new Error(`${path} is a folder, not a file.`))
        else resolve(stats.size)
      })
    })
    const wanted = Math.min(size, maxBytes)
    const chunks: Buffer[] = []
    if (wanted > 0) {
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createReadStream(path, { start: 0, end: wanted - 1 })
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.once('error', reject)
        stream.once('close', () => resolve())
      })
    }
    return { data: Buffer.concat(chunks), size, truncated: size > maxBytes }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => sftp.writeFile(path, data, (err) => (err ? reject(err) : resolve())))
  }

  async list(path: string): Promise<DirEntry[]> {
    const sftp = await this.sftp()
    const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
    })
    return entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => ({
        name: e.filename,
        type: (e.attrs.isDirectory() ? 'dir' : e.attrs.isSymbolicLink() ? 'link' : e.attrs.isFile() ? 'file' : 'other') as DirEntry['type'],
        size: e.attrs.size,
        modified: (e.attrs.mtime ?? 0) * 1000
      }))
      .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve())))
  }

  async close(): Promise<void> {
    const pending = this.client
    this.client = null
    this.sftpPromise = null
    if (pending) (await pending.catch(() => null))?.end()
  }
}
