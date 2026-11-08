import { z } from 'zod'
import type { ToolKind } from '@shared/agent'
import { DEVICE_LIMITS, type AccessLevel, type DeviceRecord, type DeviceOs } from '@shared/devices'
import type { Store } from '../store'
import { HostKeyError } from './connector'
import { explainError, type DeviceService } from './device-service'

/*
 * The tools an assistant uses on a device. They are the same whether the assistant is a vendor's agent, reaching
 * them through the MCP server, or the assistant the tests use. Every rule that matters lives here and not in the caller:
 * a session sees only the devices attached to it, Read only devices have no command or write tool, and Ask first
 * devices show an approval card with the exact command before anything runs.
 */

export type ToolName =
  | 'devices_list'
  | 'device_run'
  | 'device_read_file'
  | 'device_list_dir'
  | 'device_write_file'
  | 'device_pull'
  | 'device_screenshot'

const device = z.string().min(1).describe('The device name from devices_list')

interface ToolDef {
  title: string
  description: string
  /** `write` tools change something on the device, so they need a level of Ask first or Full. */
  needs: 'any' | 'write'
  shape: z.ZodRawShape
}

export const TOOLS: Record<ToolName, ToolDef> = {
  devices_list: {
    title: 'List devices',
    description:
      'Lists the devices attached to this chat: each one’s name, operating system, which shell to write commands in, how much you may do on it, and the folders you can use. Call this first.',
    needs: 'any',
    shape: {}
  },
  device_run: {
    title: 'Run a command on a device',
    description:
      'Runs one command on a device and returns its output and exit code. Write it for the device’s own shell (devices_list says which). The user may be asked to approve it first. Output is cut at 64 KB, and the command is stopped after the time limit.',
    needs: 'write',
    shape: {
      device,
      command: z.string().min(1).max(20_000).describe('The command, written for the device’s shell'),
      timeoutSeconds: z.number().int().min(1).max(600).optional().describe('Stop it after this long. Default 60, at most 600')
    }
  },
  device_read_file: {
    title: 'Read a file on a device',
    description: 'Reads a text file on a device. Large files are cut at maxBytes (default 256 KB). Binary files are not shown: use device_pull.',
    needs: 'any',
    shape: { device, path: z.string().min(1).max(1000), maxBytes: z.number().int().min(1).max(1_000_000).optional() }
  },
  device_list_dir: {
    title: 'List a folder on a device',
    description: 'Lists the files and folders in a folder on a device.',
    needs: 'any',
    shape: { device, path: z.string().min(1).max(1000) }
  },
  device_write_file: {
    title: 'Write a file on a device',
    description: 'Creates or replaces a text file on a device. The user may be asked to approve it first.',
    needs: 'write',
    shape: { device, path: z.string().min(1).max(1000), content: z.string().max(1_000_000) }
  },
  device_pull: {
    title: 'Copy a file from a device',
    description: 'Copies a file from a device to this computer and returns where it is, so it can be opened with the normal file tools. Files over 25 MB are refused.',
    needs: 'any',
    shape: { device, path: z.string().min(1).max(1000) }
  },
  device_screenshot: {
    title: 'Take a screenshot of an Android device',
    description: 'Returns a screenshot of an Android phone or tablet.',
    needs: 'any',
    shape: { device }
  }
}

export interface ToolOutput {
  text: string
  isError: boolean
  image?: { mime: string; data: string }
}

export interface CallHooks {
  /** Called once the call is allowed and about to run, after any approval. */
  started?: () => void
}

export interface ApprovalPort {
  requestApproval(sessionId: string, request: { kind: ToolKind; title: string; detail?: string }): Promise<boolean>
}

const error = (text: string): ToolOutput => ({ text, isError: true })

const LEVEL_TEXT: Record<AccessLevel, string> = {
  read: 'read only (you can look at files, not run commands or change anything)',
  ask: 'ask first (each command or change needs the user’s approval)',
  full: 'full (commands and changes run without asking)'
}

const SHELL_TEXT: Record<DeviceRecord['shell'], string> = {
  posix: 'a POSIX shell (sh/bash)',
  powershell: 'PowerShell',
  adb: 'the Android shell (`adb shell`, toybox sh)'
}

const OS_TEXT: Record<DeviceOs, string> = { linux: 'Linux', mac: 'macOS', windows: 'Windows', android: 'Android', unknown: 'an unknown system' }

/** SFTP wants `/C:/Users/...` for a Windows path, however the model wrote it. */
export function normalizePath(os: DeviceOs, path: string): string {
  if (os !== 'windows') return path
  const forward = path.replace(/\\/g, '/')
  return /^[A-Za-z]:/.test(forward) ? `/${forward}` : forward
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

export class DeviceTools {
  private readonly running = new Map<string, Set<AbortController>>()

  constructor(
    private readonly store: Store,
    private readonly devices: DeviceService,
    private readonly approvals: ApprovalPort,
    private readonly fs: { join(...p: string[]): string; mkdirp(p: string): Promise<void> },
    private readonly dataDir: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  private attached(sessionId: string): DeviceRecord[] {
    return this.store
      .attachedDevices(sessionId)
      .map((id) => this.store.getDevice(id))
      .filter((d): d is DeviceRecord => !!d)
  }

  /** The tools this session can use right now. Read only devices alone give no command or write tool. */
  available(sessionId: string): ToolName[] {
    const devices = this.attached(sessionId)
    // devices_list is always there: it tells the assistant that nothing is attached, and keeps the tool list valid.
    if (devices.length === 0) return ['devices_list']
    const canWrite = devices.some((d) => d.accessLevel !== 'read')
    const hasAndroid = devices.some((d) => d.kind === 'adb')
    return (Object.keys(TOOLS) as ToolName[]).filter((name) => {
      if (TOOLS[name].needs === 'write' && !canWrite) return false
      if (name === 'device_screenshot' && !hasAndroid) return false
      return true
    })
  }

  /** Stops whatever this session has running on devices. */
  cancel(sessionId: string): void {
    this.running.get(sessionId)?.forEach((c) => c.abort())
  }

  private describe(sessionId: string): string {
    const devices = this.attached(sessionId)
    if (devices.length === 0) return 'No device is attached to this chat. The user can attach one from Tools & Integrations.'
    const folders = this.store.listFolders()
    return [
      'Devices attached to this chat:',
      ...devices.map((d) => {
        const mine = folders.filter((f) => f.deviceId === d.id)
        const pathNote = d.os === 'windows' ? ' Paths use forward slashes, like C:/Users/name/file.txt.' : ''
        const lines = [`- ${d.name}: ${OS_TEXT[d.os]}. Write commands for ${SHELL_TEXT[d.shell]}.${pathNote} Access: ${LEVEL_TEXT[d.accessLevel]}.`]
        for (const f of mine) {
          const snapshotPath = f.mode === 'snapshot' ? this.store.getFolder(f.id)?.snapshotPath : null
          lines.push(
            f.mode === 'snapshot' && snapshotPath
              ? `    Folder ${f.path}: a copy from ${f.snapshotAt ? ago(this.now() - f.snapshotAt) : 'earlier'} is on this computer at ${snapshotPath} (read it with the normal file tools).`
              : `    Folder ${f.path}: read it live with device_list_dir and device_read_file.`
          )
        }
        return lines.join('\n')
      })
    ].join('\n')
  }

  private resolve(sessionId: string, name: string): DeviceRecord | string {
    const devices = this.attached(sessionId)
    const wanted = name.trim().toLowerCase()
    const matches = devices.filter((d) => d.name.toLowerCase() === wanted || d.id === name)
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) return `More than one attached device is called "${name}". Detach one in Tools & Integrations.`
    const known = devices.map((d) => d.name).join(', ')
    return devices.length ? `There is no attached device called "${name}". Attached: ${known}.` : 'No device is attached to this chat. The user can attach one from Tools & Integrations.'
  }

  async call(sessionId: string, name: string, args: unknown, hooks: CallHooks = {}): Promise<ToolOutput> {
    const def = TOOLS[name as ToolName]
    if (!def) return error(`There is no tool called ${name}.`)
    if (!this.available(sessionId).includes(name as ToolName)) {
      return error(
        name === 'devices_list' || def.needs === 'any'
          ? 'No device is attached to this chat.'
          : 'None of the attached devices allows commands or changes. They are read only. The user can change a device’s access level in Settings, Devices.'
      )
    }
    const parsed = z.object(def.shape).safeParse(args ?? {})
    if (!parsed.success) return error(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`)
    const input = parsed.data as Record<string, unknown>

    if (name === 'devices_list') {
      hooks.started?.()
      return { text: this.describe(sessionId), isError: false }
    }

    const target = this.resolve(sessionId, String(input.device))
    if (typeof target === 'string') return error(target)
    const d = target

    if (def.needs === 'write' && d.accessLevel === 'read') {
      return error(`${d.name} is read only, so nothing can be run or changed on it. The user can change that in Settings, Devices.`)
    }

    const path = typeof input.path === 'string' ? normalizePath(d.os, input.path) : ''
    const summary =
      name === 'device_run'
        ? String(input.command)
        : name === 'device_write_file'
          ? `Write ${path}`
          : name === 'device_read_file'
            ? `Read ${path}`
            : name === 'device_list_dir'
              ? `List ${path}`
              : name === 'device_pull'
                ? `Copy ${path}`
                : 'Screenshot'

    // The approval is Celeste's own, whatever approval mode the vendor is in.
    if (def.needs === 'write' && d.accessLevel === 'ask') {
      const approved = await this.approvals.requestApproval(sessionId, {
        kind: name === 'device_run' ? 'shell' : 'edit',
        title: name === 'device_run' ? `Run on ${d.name}` : `Write ${path} on ${d.name}`,
        detail: name === 'device_run' ? String(input.command) : String(input.content).slice(0, 2000)
      })
      if (!approved) {
        this.devices.record(d.id, sessionId, name, `Declined: ${summary}`, false)
        return error('The user declined this. Do not try again unless they ask you to.')
      }
    }

    const controller = new AbortController()
    const set = this.running.get(sessionId) ?? new Set<AbortController>()
    set.add(controller)
    this.running.set(sessionId, set)
    hooks.started?.()
    try {
      const connector = await this.devices.connector(d)
      switch (name as ToolName) {
        case 'device_run': {
          const seconds = Math.min(Number(input.timeoutSeconds ?? DEVICE_LIMITS.defaultTimeoutMs / 1000), DEVICE_LIMITS.maxTimeoutMs / 1000)
          const r = await connector.run(String(input.command), { timeoutMs: seconds * 1000, maxBytes: DEVICE_LIMITS.outputBytes, signal: controller.signal })
          const notes = [
            r.timedOut ? `[stopped: it was still running after ${seconds} seconds]` : '',
            r.cancelled ? '[stopped at the user’s request]' : '',
            r.truncated ? '[output was cut: only the start and the end are shown]' : '',
            r.exitCode !== null ? `[exit code ${r.exitCode}]` : ''
          ].filter(Boolean)
          this.devices.record(d.id, sessionId, name, summary, r.exitCode === 0, Buffer.byteLength(r.output))
          return { text: `${r.output.trimEnd() || '(no output)'}\n${notes.join('\n')}`.trimEnd(), isError: r.timedOut || r.cancelled }
        }
        case 'device_read_file': {
          const max = Math.min(Number(input.maxBytes ?? DEVICE_LIMITS.readBytes), 1_000_000)
          const r = await connector.readFile(path, max)
          this.devices.record(d.id, sessionId, name, summary, true, r.data.length)
          if (r.data.includes(0)) return { text: `${path} looks like a binary file (${r.size} bytes). Use device_pull to copy it here.`, isError: false }
          const note = r.truncated ? `\n[only the first ${r.data.length} of ${r.size} bytes are shown]` : ''
          return { text: r.data.toString('utf8') + note, isError: false }
        }
        case 'device_list_dir': {
          const entries = await connector.list(path)
          this.devices.record(d.id, sessionId, name, summary, true)
          const lines = entries.map((e) => `${e.type === 'dir' ? 'dir ' : e.type === 'link' ? 'link' : 'file'}  ${String(e.size).padStart(10)}  ${e.name}${e.type === 'dir' ? '/' : ''}`)
          return { text: lines.length ? lines.join('\n') : '(empty)', isError: false }
        }
        case 'device_write_file': {
          const data = Buffer.from(String(input.content), 'utf8')
          await connector.writeFile(path, data)
          this.devices.record(d.id, sessionId, name, summary, true, data.length)
          return { text: `Wrote ${data.length} bytes to ${path} on ${d.name}.`, isError: false }
        }
        case 'device_pull': {
          const probe = await connector.readFile(path, 1)
          if (probe.size > DEVICE_LIMITS.snapshotFileBytes) return error(`${path} is ${probe.size} bytes, over the 25 MB limit.`)
          const dir = this.fs.join(this.dataDir, 'devices', d.id, 'pulled')
          await this.fs.mkdirp(dir)
          const local = this.fs.join(dir, `${this.now()}-${path.split('/').filter(Boolean).pop() ?? 'file'}`.replace(/[<>:"|?*\u0000-\u001f]/g, '_'))
          await connector.download(path, local)
          this.devices.record(d.id, sessionId, name, summary, true, probe.size)
          return { text: `Copied ${path} (${probe.size} bytes) to ${local}`, isError: false }
        }
        case 'device_screenshot': {
          if (!connector.screenshot) return error(`${d.name} cannot give a screenshot.`)
          const png = await connector.screenshot()
          this.devices.record(d.id, sessionId, name, summary, true, png.length)
          return { text: 'Screenshot taken.', isError: false, image: { mime: 'image/png', data: png.toString('base64') } }
        }
        default:
          return error(`There is no tool called ${name}.`)
      }
    } catch (err) {
      const message = err instanceof HostKeyError ? `${err.message} The user has to test the connection again in Settings, Devices.` : explainError(err)
      this.devices.record(d.id, sessionId, name, `${summary} — ${message}`, false)
      return error(message)
    } finally {
      set.delete(controller)
    }
  }
}
