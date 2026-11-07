import type { DeviceProbe, DirEntry } from '@shared/devices'
import {
  OutputCollector,
  cleanClixml,
  type Connector,
  type Credentials,
  type DeviceTarget,
  type ReadResult,
  type RunOptions,
  type RunResult
} from './connector'
import { runProcess, textOf, type Exec } from './exec'

/*
 * PowerShell Direct: a Windows VM that runs on this PC, reached through Hyper-V itself. No network and no IP
 * address, but it needs a Hyper-V administrator on this PC and the VM's own login. Windows 10 or Server 2016 and
 * later guests. Everything the assistant sends travels in an environment variable, never in the command line, so
 * quoting cannot break it and the password is not visible in a process list.
 */

const HEADER = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;
$cred=New-Object System.Management.Automation.PSCredential($env:CELESTE_VM_USER,(ConvertTo-SecureString $env:CELESTE_VM_PASSWORD -AsPlainText -Force));`

const inVm = (block: string) => `${HEADER}Invoke-Command -VMName $env:CELESTE_VM -Credential $cred -ArgumentList $env:CELESTE_ARG,$env:CELESTE_ARG2 -ScriptBlock { param($a,$b) ${block} }`

const EXIT = '::celeste-exit::'

export class HyperVConnector implements Connector {
  constructor(
    private readonly target: DeviceTarget,
    private readonly credentials: Credentials,
    private readonly exec: Exec = runProcess,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  private async ps(block: string, args: { a?: string; b?: string } = {}, options: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {}) {
    if (this.platform !== 'win32') throw new Error('PowerShell Direct only works from a Windows computer running Hyper-V.')
    if (!this.credentials.password) throw new Error('The VM’s password is needed.')
    const encoded = Buffer.from(inVm(block), 'utf16le').toString('base64')
    const result = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      timeoutMs: options.timeoutMs ?? 60_000,
      signal: options.signal,
      maxBytes: options.maxBytes,
      env: {
        CELESTE_VM: this.target.host,
        CELESTE_VM_USER: this.target.username,
        CELESTE_VM_PASSWORD: this.credentials.password,
        CELESTE_ARG: args.a ?? '',
        CELESTE_ARG2: args.b ?? ''
      }
    })
    if (result.missing) throw new Error('Windows PowerShell was not found.')
    return result
  }

  private fail(r: { stdout: Buffer; stderr: Buffer }): Error {
    const message = cleanClixml(textOf(r.stderr) || textOf(r.stdout)).trim()
    if (/not recognized|-VMName|Hyper-V/i.test(message) && /VMName/i.test(message)) return new Error('This PC cannot use PowerShell Direct. Hyper-V must be installed, and this must be Windows 10 or Server 2016 or later.')
    if (/permission|authorization|administrator/i.test(message)) return new Error('Hyper-V refused. Celeste has to run as a Hyper-V administrator to reach VMs on this PC.')
    if (/credential is invalid/i.test(message)) return new Error('The VM refused the user name or password.')
    if (/does not resolve|not.*find|no virtual machine/i.test(message)) return new Error(`There is no running VM called “${this.target.host}”. Start it, and check the name.`)
    return new Error(message || 'The VM did not answer.')
  }

  async probe(): Promise<DeviceProbe> {
    const r = await this.ps(`"windows";[Environment]::UserName;[Environment]::MachineName`, {}, { timeoutMs: 30_000 })
    if (r.code !== 0) throw this.fail(r)
    const lines = textOf(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines[0] !== 'windows') throw new Error('The VM answered, but not like a Windows computer.')
    return { os: 'windows', shell: 'powershell', user: lines[1] ?? this.target.username, hostname: lines[2] ?? this.target.host }
  }

  async run(command: string, options: RunOptions): Promise<RunResult> {
    const block = `$o = (& ([scriptblock]::Create($a)) 2>&1 | Out-String); $c = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; "$o\`n${EXIT}$c"`
    const r = await this.ps(block, { a: command }, { timeoutMs: options.timeoutMs, signal: options.signal, maxBytes: options.maxBytes * 4 })
    if (r.timedOut || r.cancelled) return { exitCode: null, output: '', truncated: false, timedOut: r.timedOut, cancelled: r.cancelled }
    if (r.code !== 0 && !textOf(r.stdout).includes(EXIT)) throw this.fail(r)
    const raw = cleanClixml(textOf(r.stdout))
    const at = raw.lastIndexOf(EXIT)
    const body = at >= 0 ? raw.slice(0, at) : raw
    const code = at >= 0 ? Number.parseInt(raw.slice(at + EXIT.length), 10) : r.code
    const collector = new OutputCollector(options.maxBytes)
    collector.push(Buffer.from(body.trimEnd()))
    const { text, truncated } = collector.result()
    return { exitCode: Number.isNaN(code) ? null : code, output: text, truncated, timedOut: false, cancelled: false }
  }

  async readFile(path: string, maxBytes: number): Promise<ReadResult> {
    const block = `$f=[IO.File]::OpenRead($a); try { $n=[Math]::Min($f.Length,[int]$b); $buf=New-Object byte[] $n; [void]$f.Read($buf,0,$n); (@{size=$f.Length;data=[Convert]::ToBase64String($buf)} | ConvertTo-Json -Compress) } finally { $f.Dispose() }`
    const r = await this.ps(block, { a: path, b: String(maxBytes) })
    if (r.code !== 0) throw this.fail(r)
    const { size, data } = JSON.parse(textOf(r.stdout)) as { size: number; data: string }
    return { data: Buffer.from(data, 'base64'), size, truncated: size > maxBytes }
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const block = `[IO.File]::WriteAllBytes($a,[Convert]::FromBase64String($b))`
    const r = await this.ps(block, { a: path, b: data.toString('base64') })
    if (r.code !== 0) throw this.fail(r)
  }

  async list(path: string): Promise<DirEntry[]> {
    // -InputObject keeps a one-item folder a list, and works in Windows PowerShell 5.1, which has no -AsArray.
    const block = `ConvertTo-Json -Compress -InputObject @(Get-ChildItem -Force -LiteralPath $a | ForEach-Object { @{name=$_.Name;dir=$_.PSIsContainer;size=[long]$(if ($_.PSIsContainer) {0} else {$_.Length});modified=[DateTimeOffset]::new($_.LastWriteTimeUtc).ToUnixTimeMilliseconds()} })`
    const r = await this.ps(block, { a: path })
    if (r.code !== 0) throw this.fail(r)
    const items = JSON.parse(textOf(r.stdout) || '[]') as { name: string; dir: boolean; size: number; modified: number }[]
    return items
      .map((i): DirEntry => ({ name: i.name, type: i.dir ? 'dir' : 'file', size: i.size, modified: i.modified }))
      .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name))
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    if (!this.credentials.password) throw new Error('The VM’s password is needed.')
    const script = `${HEADER}$s=New-PSSession -VMName $env:CELESTE_VM -Credential $cred; try { Copy-Item -FromSession $s -LiteralPath $env:CELESTE_ARG -Destination $env:CELESTE_ARG2 } finally { Remove-PSSession $s }`
    const r = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      timeoutMs: 120_000,
      env: { CELESTE_VM: this.target.host, CELESTE_VM_USER: this.target.username, CELESTE_VM_PASSWORD: this.credentials.password, CELESTE_ARG: remotePath, CELESTE_ARG2: localPath }
    })
    if (r.code !== 0) throw this.fail(r)
  }

  async close(): Promise<void> {}
}
