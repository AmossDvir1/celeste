import type { FoundDevice } from '@shared/devices'
import { runProcess, textOf, type Exec } from './exec'

/** An announcement heard on the network. */
export interface Announced {
  type: string
  name: string
  host: string
  addresses: string[]
  port: number
}

export type Browse = (types: string[], ms: number) => Promise<Announced[]>

/** Listens for devices that announce themselves (mDNS) for a short time. */
export async function browseNetwork(types: string[], ms: number): Promise<Announced[]> {
  const { Bonjour } = await import('bonjour-service')
  const bonjour = new Bonjour()
  const found: Announced[] = []
  const browsers = types.map((type) =>
    bonjour.find({ type }, (service) => {
      found.push({ type, name: service.name, host: service.host, addresses: service.addresses ?? [], port: service.port })
    })
  )
  await new Promise((resolve) => setTimeout(resolve, ms))
  browsers.forEach((b) => b.stop())
  await new Promise<void>((resolve) => bonjour.destroy(() => resolve()))
  return found
}

const ipv4 = (list: string[]) => list.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))

/** Turns announcements into things that can be added. SSH machines, and Android phones ready to pair or connect. */
export function fromAnnouncements(items: Announced[]): FoundDevice[] {
  const seen = new Map<string, FoundDevice>()
  for (const a of items) {
    const host = ipv4(a.addresses) ?? a.host.replace(/\.$/, '')
    if (!host) continue
    const adb = a.type === 'adb-tls-connect' || a.type === 'adb-tls-pairing'
    const found: FoundDevice = {
      key: `${adb ? 'adb' : 'ssh'}:${host}:${a.port}`,
      kind: adb ? 'adb' : 'ssh',
      name: a.name.replace(/^adb-/, 'Android ').replace(/\.local$/, ''),
      host,
      port: a.port,
      source: adb ? 'Announced by the phone' : 'Announced on the network',
      ...(a.type === 'adb-tls-pairing' ? { pairing: true } : {})
    }
    if (!seen.has(found.key)) seen.set(found.key, found)
  }
  return [...seen.values()]
}

// --- virtual machines on this computer --------------------------------------------------------------

interface Vm {
  name: string
  host?: string
  state?: string
}

const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

/** `VBoxManage list vms`: "name" {uuid} */
export const parseVirtualBox = (t: string): Vm[] => lines(t).flatMap((l) => (/^"(.+)"\s+\{[^}]+\}$/.exec(l) ? [{ name: /^"(.+)"/.exec(l)![1] }] : []))
/** `vmrun list`: a count, then one path per running VM. */
export const parseVmrun = (t: string): Vm[] => lines(t).filter((l) => /\.vmx$/i.test(l)).map((l) => ({ name: l.replace(/^.*[\\/]/, '').replace(/\.vmx$/i, '') }))
/** `prlctl list -a -j`: a JSON list. */
export function parseParallels(t: string): Vm[] {
  try {
    return (JSON.parse(t) as { name: string; ip_configured?: string; status?: string }[]).map((v) => ({ name: v.name, host: v.ip_configured && v.ip_configured !== '-' ? v.ip_configured : undefined, state: v.status }))
  } catch {
    return []
  }
}
/** `utmctl list`: UUID, status, name. */
export const parseUtm = (t: string): Vm[] =>
  lines(t).flatMap((l) => {
    const m = /^[0-9A-Fa-f-]{36}\s+(\S+)\s+(.+)$/.exec(l)
    return m ? [{ name: m[2], state: m[1] }] : []
  })
/** `multipass list --format json` */
export function parseMultipass(t: string): Vm[] {
  try {
    return ((JSON.parse(t) as { list?: { name: string; state?: string; ipv4?: string[] }[] }).list ?? []).map((v) => ({ name: v.name, host: v.ipv4?.[0], state: v.state }))
  } catch {
    return []
  }
}
/** `virsh list --all`: a table. */
export const parseVirsh = (t: string): Vm[] =>
  lines(t).flatMap((l) => {
    const m = /^(?:\d+|-)\s+(\S+)\s+(.+)$/.exec(l)
    return m ? [{ name: m[1], state: m[2] }] : []
  })
/** `wsl -l -v`: a table that starts with a star for the default distribution. */
export const parseWsl = (t: string): Vm[] =>
  lines(t)
    .slice(1)
    .flatMap((l) => {
      const m = /^\*?\s*(\S+)\s+(Running|Stopped)\s+\d+$/.exec(l)
      return m ? [{ name: m[1], state: m[2] }] : []
    })
/** Hyper-V: JSON from Get-VM. */
export function parseHyperV(t: string): Vm[] {
  try {
    const parsed = JSON.parse(t) as { Name: string; State: string | number } | { Name: string; State: string | number }[]
    return (Array.isArray(parsed) ? parsed : [parsed]).map((v) => ({ name: v.Name, state: String(v.State) }))
  } catch {
    return []
  }
}

interface Probe {
  source: string
  file: string
  args: string[]
  parse: (text: string) => Vm[]
  kind: 'ssh' | 'hyperv'
  platforms: NodeJS.Platform[]
}

const PROBES: Probe[] = [
  { source: 'Hyper-V on this PC', file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-VM | Select-Object Name,State | ConvertTo-Json -Compress'], parse: parseHyperV, kind: 'hyperv', platforms: ['win32'] },
  { source: 'WSL on this PC', file: 'wsl.exe', args: ['-l', '-v'], parse: parseWsl, kind: 'ssh', platforms: ['win32'] },
  { source: 'Parallels on this Mac', file: 'prlctl', args: ['list', '-a', '-j'], parse: parseParallels, kind: 'ssh', platforms: ['darwin'] },
  { source: 'UTM on this Mac', file: 'utmctl', args: ['list'], parse: parseUtm, kind: 'ssh', platforms: ['darwin'] },
  { source: 'Multipass', file: 'multipass', args: ['list', '--format', 'json'], parse: parseMultipass, kind: 'ssh', platforms: ['win32', 'darwin', 'linux'] },
  { source: 'libvirt on this computer', file: 'virsh', args: ['list', '--all'], parse: parseVirsh, kind: 'ssh', platforms: ['linux'] },
  { source: 'VirtualBox', file: 'VBoxManage', args: ['list', 'vms'], parse: parseVirtualBox, kind: 'ssh', platforms: ['win32', 'darwin', 'linux'] },
  { source: 'VMware', file: 'vmrun', args: ['list'], parse: parseVmrun, kind: 'ssh', platforms: ['win32', 'darwin', 'linux'] }
]

/** The virtual machines of every product installed on this computer. A tool that is missing or refuses is left out. */
export async function listLocalVms(exec: Exec = runProcess, platform: NodeJS.Platform = process.platform): Promise<FoundDevice[]> {
  const results = await Promise.all(
    PROBES.filter((p) => p.platforms.includes(platform)).map(async (p) => {
      const r = await exec(p.file, p.args, { timeoutMs: 8000 }).catch(() => null)
      if (!r || r.missing || r.code !== 0) return []
      return p.parse(textOf(r.stdout)).map(
        (vm): FoundDevice => ({
          key: `${p.kind}:${p.source}:${vm.name}`,
          kind: p.kind,
          name: vm.name,
          // Hyper-V reaches a VM by name. For the others the address is known only if the product reports one.
          host: p.kind === 'hyperv' ? vm.name : (vm.host ?? ''),
          port: p.kind === 'hyperv' ? 0 : 22,
          source: p.source + (vm.state ? ` (${vm.state})` : '')
        })
      )
    })
  )
  return results.flat()
}

/** Everything that could be added: announcements on the network, and local VMs. */
export async function discoverAll(options: { browse?: Browse; exec?: Exec; platform?: NodeJS.Platform; ms?: number } = {}): Promise<FoundDevice[]> {
  const browse = options.browse ?? browseNetwork
  const [announced, vms] = await Promise.all([
    browse(['ssh', 'sftp-ssh', 'adb-tls-connect', 'adb-tls-pairing'], options.ms ?? 3000).catch(() => []),
    listLocalVms(options.exec, options.platform)
  ])
  return [...fromAnnouncements(announced), ...vms]
}
