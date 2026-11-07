import { describe, expect, it } from 'vitest'
import type { ConnectorHooks, DeviceTarget } from './connector'
import { AdbConnector, findAdb, parseLs, parseMdns, shellQuote } from './adb-connector'
import { AdbPairing } from './adb-pairing'
import { discoverAll, fromAnnouncements, listLocalVms, parseHyperV, parseMultipass, parseParallels, parseUtm, parseVirsh, parseVirtualBox, parseVmrun, parseWsl } from './discovery'
import type { Exec, ExecOptions, ExecResult } from './exec'
import { HyperVConnector } from './hyperv-connector'

const result = (over: Partial<ExecResult> & { out?: string; err?: string } = {}): ExecResult => ({
  code: 0,
  stdout: Buffer.from(over.out ?? ''),
  stderr: Buffer.from(over.err ?? ''),
  timedOut: false,
  cancelled: false,
  missing: false,
  ...over
})

interface Call {
  file: string
  args: string[]
  options: ExecOptions
}
function scripted(answer: (call: Call) => ReturnType<typeof result> | undefined) {
  const calls: Call[] = []
  const exec: Exec = async (file, args, options = {}) => {
    const call = { file, args, options }
    calls.push(call)
    return answer(call) ?? result()
  }
  return { exec, calls }
}
const decodeScript = (args: string[]) => Buffer.from(args[args.length - 1], 'base64').toString('utf16le')

const target = (over: Partial<DeviceTarget> = {}): DeviceTarget => ({
  kind: 'hyperv',
  host: 'Build VM',
  port: 0,
  username: 'Administrator',
  authMethod: 'password',
  shell: 'powershell',
  os: 'windows',
  hostKeySha256: null,
  ...over
})

describe('HyperVConnector (PowerShell Direct)', () => {
  it('only works from Windows', async () => {
    const { exec } = scripted(() => undefined)
    const c = new HyperVConnector(target(), { password: 'pw' }, exec, 'darwin')
    await expect(c.probe()).rejects.toThrow(/only works from a Windows/)
  })

  it('needs the VM password', async () => {
    const { exec } = scripted(() => undefined)
    await expect(new HyperVConnector(target(), {}, exec, 'win32').probe()).rejects.toThrow(/password is needed/)
  })

  it('reaches the VM by name, and keeps the password and the command out of the command line', async () => {
    const { exec, calls } = scripted(() => result({ out: 'windows\r\nAdministrator\r\nBUILD-VM\r\n' }))
    const c = new HyperVConnector(target(), { password: 's3cret!' }, exec, 'win32')
    expect(await c.probe()).toEqual({ os: 'windows', shell: 'powershell', user: 'Administrator', hostname: 'BUILD-VM' })

    await c.run(`Write-Output 'it''s "quoted" $x'`, { timeoutMs: 5000, maxBytes: 1000 })
    for (const call of calls) {
      expect(call.file).toBe('powershell.exe')
      expect(call.args).toContain('-EncodedCommand')
      expect(call.args.join(' ')).not.toContain('s3cret!')
      expect(decodeScript(call.args)).not.toContain('s3cret!')
      expect(decodeScript(call.args)).toContain('Invoke-Command -VMName $env:CELESTE_VM')
      expect(call.options.env).toMatchObject({ CELESTE_VM: 'Build VM', CELESTE_VM_USER: 'Administrator', CELESTE_VM_PASSWORD: 's3cret!' })
    }
    const run = calls[1]
    expect(run.options.env?.CELESTE_ARG).toBe(`Write-Output 'it''s "quoted" $x'`)
    expect(decodeScript(run.args)).not.toContain('quoted')
  })

  it('returns the output and the exit code of the command inside the VM', async () => {
    const { exec } = scripted(() => result({ out: 'hello\r\n\r\n::celeste-exit::3' }))
    const r = await new HyperVConnector(target(), { password: 'pw' }, exec, 'win32').run('x', { timeoutMs: 5000, maxBytes: 1000 })
    expect(r).toMatchObject({ exitCode: 3, output: 'hello', timedOut: false })
  })

  it('reports a command that ran too long', async () => {
    const { exec } = scripted(() => result({ code: null, timedOut: true }))
    const r = await new HyperVConnector(target(), { password: 'pw' }, exec, 'win32').run('x', { timeoutMs: 10, maxBytes: 1000 })
    expect(r).toMatchObject({ timedOut: true, exitCode: null })
  })

  it('lists, reads and writes files', async () => {
    const { exec, calls } = scripted(({ args }) => {
      const script = decodeScript(args)
      if (script.includes('Get-ChildItem')) return result({ out: JSON.stringify([{ name: 'b.txt', dir: false, size: 5, modified: 1 }, { name: 'a', dir: true, size: 0, modified: 2 }]) })
      if (script.includes('OpenRead')) return result({ out: JSON.stringify({ size: 11, data: Buffer.from('hello').toString('base64') }) })
      return result()
    })
    const c = new HyperVConnector(target(), { password: 'pw' }, exec, 'win32')
    expect((await c.list('C:\\Users')).map((e) => [e.name, e.type])).toEqual([['a', 'dir'], ['b.txt', 'file']])
    const read = await c.readFile('C:\\a.txt', 5)
    expect(read.data.toString()).toBe('hello')
    expect(read).toMatchObject({ size: 11, truncated: true })
    await c.writeFile('C:\\out.txt', Buffer.from('content'))
    expect(calls.at(-1)?.options.env).toMatchObject({ CELESTE_ARG: 'C:\\out.txt', CELESTE_ARG2: Buffer.from('content').toString('base64') })
  })

  it('turns Hyper-V’s errors into things a person can act on', async () => {
    const say = (err: string) => scripted(() => result({ code: 1, err })).exec
    const probe = (err: string) => new HyperVConnector(target(), { password: 'pw' }, say(err), 'win32').probe()
    await expect(probe('The input VMName parameter does not resolve to any virtual machine.')).rejects.toThrow(/no running VM called “Build VM”/)
    await expect(probe('You do not have the required permission to complete this task.')).rejects.toThrow(/Hyper-V administrator/)
    await expect(probe('The credential is invalid.')).rejects.toThrow(/user name or password/)
  })
})

describe('Android: finding adb and reading its output', () => {
  it('finds adb in the places it is usually kept', () => {
    const has = (...paths: string[]) => (p: string) => paths.includes(p)
    expect(findAdb({ CELESTE_ADB: 'C:\\tools\\adb.exe' }, has('C:\\tools\\adb.exe'), 'win32')).toBe('C:\\tools\\adb.exe')
    expect(findAdb({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, has('C:\\Users\\a\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe'), 'win32')).toContain('Sdk')
    expect(findAdb({ HOME: '/Users/a' }, has('/Users/a/Library/Android/sdk/platform-tools/adb'), 'darwin')).toBe('/Users/a/Library/Android/sdk/platform-tools/adb')
    expect(findAdb({ PATH: '/usr/bin:/opt/pt' }, has('/opt/pt/adb'), 'linux')).toBe('/opt/pt/adb')
    expect(findAdb({ PATH: '/usr/bin' }, () => false, 'linux')).toBeNull()
  })

  it('reads the services a phone announces', () => {
    const text = 'List of discovered mdns services\r\nadb-R5CT1234  _adb-tls-connect._tcp.  192.168.1.9:41123\r\nstudio-abc123xyz0\t_adb-tls-pairing._tcp\t192.168.1.9:37099\r\nnoise line\r\n'
    expect(parseMdns(text)).toEqual([
      { instance: 'adb-R5CT1234', kind: 'connect', host: '192.168.1.9', port: 41123 },
      { instance: 'studio-abc123xyz0', kind: 'pairing', host: '192.168.1.9', port: 37099 }
    ])
  })

  it('reads a folder listing and quotes names for the phone’s shell', () => {
    const text = 'total 8\ndrwxrwx--x 2 root sdcard_rw 4096 2026-11-07 10:00 DCIM\n-rw-rw---- 1 root sdcard_rw 120 2026-11-06 09:30 my notes.txt\nlrwxrwxrwx 1 root root 8 2026-01-01 00:00 link -> /target\n'
    expect(parseLs(text).map((e) => [e.name, e.type, e.size])).toEqual([['DCIM', 'dir', 4096], ['my notes.txt', 'file', 120], ['link', 'link', 8]])
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`)
  })
})

describe('AdbConnector', () => {
  const phone = target({ kind: 'adb', host: '192.168.1.9', port: 41123, username: 'shell', os: 'android', shell: 'adb', authMethod: 'none' })
  const ADB = 'C:\\adb.exe'

  it('says what to do when adb is not installed', async () => {
    const { exec } = scripted(() => undefined)
    await expect(new AdbConnector(phone, null, exec).probe()).rejects.toThrow(/adb tool was not found/)
  })

  it('connects, then asks the phone what it is', async () => {
    const { exec, calls } = scripted(({ args }) => (args[0] === 'connect' ? result({ out: 'connected to 192.168.1.9:41123' }) : result({ out: 'Pixel 8\nshell\n' })))
    const probe = await new AdbConnector(phone, ADB, exec).probe()
    expect(probe).toEqual({ os: 'android', shell: 'adb', user: 'shell', hostname: 'Pixel 8' })
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([['connect', '192.168.1.9:41123'], ['-s', '192.168.1.9:41123', 'shell']])
  })

  it('runs a command and returns what it printed and its exit code', async () => {
    const { exec, calls } = scripted(({ args }) => (args[0] === 'connect' ? result({ out: 'already connected to 192.168.1.9:41123' }) : result({ out: 'Filesystem Size\n/data 100G\n', code: 0 })))
    const r = await new AdbConnector(phone, ADB, exec).run('df /data', { timeoutMs: 5000, maxBytes: 1000 })
    expect(r).toMatchObject({ exitCode: 0, output: 'Filesystem Size\n/data 100G\n' })
    expect(calls.at(-1)?.args).toEqual(['-s', '192.168.1.9:41123', 'shell', '(df /data) 2>&1'])
  })

  it('finds the phone again when it has moved to a new port', async () => {
    let port = 41123
    const moved: number[] = []
    const hooks: ConnectorHooks = { portChanged: (p) => moved.push(p) }
    const { exec } = scripted(({ args }) => {
      if (args[0] === 'connect') return args[1].endsWith(':50001') ? result({ out: 'connected to 192.168.1.9:50001' }) : result({ out: 'failed to connect to 192.168.1.9:41123' })
      if (args[0] === 'mdns') return result({ out: 'adb-R5CT  _adb-tls-connect._tcp.  192.168.1.9:50001\n' })
      port = 50001
      return result({ out: 'Pixel 8\nshell\n' })
    })
    const own = { ...phone }
    await new AdbConnector(own, ADB, exec, hooks).probe()
    expect(own.port).toBe(50001)
    expect(moved).toEqual([50001])
    expect(port).toBe(50001)
  })

  it('says so when the phone cannot be reached at all', async () => {
    const { exec } = scripted(({ args }) => (args[0] === 'connect' ? result({ out: 'failed to connect to 192.168.1.9:41123' }) : result({ out: '' })))
    await expect(new AdbConnector(phone, ADB, exec).probe()).rejects.toThrow(/Wireless debugging on/)
  })

  it('lists, reads, and rejects a folder read as a file', async () => {
    const { exec } = scripted(({ args }) => {
      const cmd = args[args.length - 1]
      if (args[0] === 'connect') return result({ out: 'connected to x' })
      if (cmd.startsWith('ls -lA')) return result({ out: 'total 4\ndrwxrwx--x 2 root sdcard_rw 4096 2026-11-07 10:00 DCIM\n-rw-rw---- 1 root sdcard_rw 12 2026-11-06 09:30 a.txt\n' })
      if (cmd.includes("'/sdcard/Download'")) return result({ out: 'DIR' })
      if (cmd.startsWith('if [ -d')) return result({ out: '12\n' })
      if (cmd.startsWith('head -c')) return result({ out: 'hello world!' })
      return result()
    })
    const c = new AdbConnector(phone, ADB, exec)
    expect((await c.list('/sdcard')).map((e) => e.name)).toEqual(['DCIM', 'a.txt'])
    expect((await c.readFile('/sdcard/a.txt', 100)).data.toString()).toBe('hello world!')
    await expect(c.readFile('/sdcard/Download', 100)).rejects.toThrow(/is a folder/)
  })

  it('returns a screenshot only if it really is a PNG', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3])
    const good = scripted(({ args }) => (args[0] === 'connect' ? result({ out: 'connected to x' }) : { ...result(), stdout: png }))
    expect((await new AdbConnector(phone, ADB, good.exec).screenshot()).equals(png)).toBe(true)
    const bad = scripted(({ args }) => (args[0] === 'connect' ? result({ out: 'connected to x' }) : result({ out: 'not an image' })))
    await expect(new AdbConnector(phone, ADB, bad.exec).screenshot()).rejects.toThrow(/did not return a screenshot/)
  })
})

describe('AdbPairing', () => {
  const noWait = async () => undefined

  it('pairs with the code the phone shows and then finds the connect port', async () => {
    const { exec, calls } = scripted(({ args }) => {
      if (args[0] === 'pair') return result({ out: 'Successfully paired to 192.168.1.9:37099 [guid=adb-R5CT]' })
      return result({ out: 'adb-R5CT  _adb-tls-connect._tcp.  192.168.1.9:50123\n' })
    })
    const pairing = new AdbPairing(() => 'adb', { exec, sleep: noWait })
    expect(await pairing.pairByCode('192.168.1.9:37099', '123456')).toEqual({ host: '192.168.1.9', port: 50123 })
    expect(calls[0].args).toEqual(['pair', '192.168.1.9:37099', '123456'])
  })

  it('says what went wrong with a bad code, and when the connect port never shows up', async () => {
    const wrong = scripted(() => result({ out: 'Failed: Wrong password or connection was dropped' }))
    await expect(new AdbPairing(() => 'adb', { exec: wrong.exec, sleep: noWait }).pairByCode('192.168.1.9:37099', '000000')).rejects.toThrow(/Check the six-digit code/)

    const noPort = scripted(({ args }) => (args[0] === 'pair' ? result({ out: 'Successfully paired to x' }) : result({ out: '' })))
    await expect(new AdbPairing(() => 'adb', { exec: noPort.exec, sleep: noWait, findPortMs: 5 }).pairByCode('192.168.1.9:37099', '123456')).rejects.toThrow(/connection port was not found/)
    await expect(new AdbPairing(() => null).pairByCode('a:1', '123456')).rejects.toThrow(/adb tool was not found/)
  })

  it('shows a QR code for the phone to scan and pairs when the phone announces itself', async () => {
    let instance = ''
    let password = ''
    const { exec } = scripted(({ args }) => {
      if (args[0] === 'pair') {
        password = args[2]
        return result({ out: 'Successfully paired to 192.168.1.9:37099' })
      }
      return result({ out: `${instance}  _adb-tls-pairing._tcp.  192.168.1.9:37099\nadb-R5CT  _adb-tls-connect._tcp.  192.168.1.9:50123\n` })
    })
    const pairing = new AdbPairing(() => 'adb', { exec, sleep: noWait })
    const paired = new Promise<{ host: string; port: number }>((resolve, reject) => {
      const session = pairing.startQr('Pixel', resolve, reject)
      const m = /^WIFI:T:ADB;S:(studio-[a-z0-9]{10});P:([a-z0-9]{10});;$/.exec(session.payload)
      expect(m).not.toBeNull()
      instance = m![1]
      expect(m![2]).toHaveLength(10)
    })
    expect(await paired).toEqual({ host: '192.168.1.9', port: 50123 })
    expect(password).toHaveLength(10)
  })

  it('gives up on a QR code that is never scanned, and stops when cancelled', async () => {
    const { exec } = scripted(() => result({ out: '' }))
    const pairing = new AdbPairing(() => 'adb', { exec, sleep: async () => new Promise((r) => setTimeout(r, 2)), qrMs: 30 })
    const failure = await new Promise<Error>((resolve) => {
      pairing.startQr('x', () => undefined, resolve)
    })
    expect(failure.message).toMatch(/not scanned in time/)

    let told = false
    const cancel = new AdbPairing(() => 'adb', { exec, sleep: async () => new Promise((r) => setTimeout(r, 2)), qrMs: 200 })
    const s = cancel.startQr('x', () => (told = true), () => (told = true))
    s.cancel()
    await new Promise((r) => setTimeout(r, 40))
    expect(told).toBe(false)
  })
})

describe('finding devices', () => {
  it('turns announcements into devices, preferring an IPv4 address and not repeating one', () => {
    const found = fromAnnouncements([
      { type: 'ssh', name: 'raspberrypi', host: 'raspberrypi.local.', addresses: ['fe80::1', '192.168.1.40'], port: 22 },
      { type: 'sftp-ssh', name: 'raspberrypi', host: 'raspberrypi.local.', addresses: ['192.168.1.40'], port: 22 },
      { type: 'adb-tls-pairing', name: 'studio-abc', host: 'phone.local.', addresses: ['192.168.1.9'], port: 37099 },
      { type: 'adb-tls-connect', name: 'adb-R5CT', host: 'phone.local.', addresses: ['192.168.1.9'], port: 50123 }
    ])
    expect(found.map((f) => [f.kind, f.host, f.port, f.pairing ?? false])).toEqual([
      ['ssh', '192.168.1.40', 22, false],
      ['adb', '192.168.1.9', 37099, true],
      ['adb', '192.168.1.9', 50123, false]
    ])
  })

  it('reads each product’s list of virtual machines', () => {
    expect(parseVirtualBox('"dev box" {1111-2222}\n"other" {3333}\n').map((v) => v.name)).toEqual(['dev box', 'other'])
    expect(parseVmrun('Total running VMs: 1\nC:\\VMs\\Ubuntu\\Ubuntu.vmx\n').map((v) => v.name)).toEqual(['Ubuntu'])
    expect(parseParallels(JSON.stringify([{ name: 'Windows 11', status: 'running', ip_configured: '10.211.55.3' }, { name: 'Off', status: 'stopped', ip_configured: '-' }]))).toEqual([
      { name: 'Windows 11', host: '10.211.55.3', state: 'running' },
      { name: 'Off', host: undefined, state: 'stopped' }
    ])
    expect(parseUtm('UUID                                 Status   Name\n0E2B9E7E-1111-2222-3333-444455556666 started  Debian\n').map((v) => [v.name, v.state])).toEqual([['Debian', 'started']])
    expect(parseMultipass(JSON.stringify({ list: [{ name: 'primary', state: 'Running', ipv4: ['10.0.0.7'] }] }))).toEqual([{ name: 'primary', host: '10.0.0.7', state: 'Running' }])
    expect(parseVirsh(' Id   Name     State\n------------------------\n 1    web01    running\n -    db01     shut off\n').map((v) => v.name)).toEqual(['web01', 'db01'])
    expect(parseWsl('  NAME      STATE           VERSION\n* Ubuntu    Running         2\n  Debian    Stopped         2\n').map((v) => [v.name, v.state])).toEqual([['Ubuntu', 'Running'], ['Debian', 'Stopped']])
    expect(parseHyperV(JSON.stringify({ Name: 'Build VM', State: 2 }))).toEqual([{ name: 'Build VM', state: '2' }])
    expect(parseHyperV('not json')).toEqual([])
  })

  it('lists VMs for this computer’s own platform, and skips tools that are missing or refuse', async () => {
    const { exec, calls } = scripted(({ file }) => {
      if (file === 'powershell.exe') return result({ out: JSON.stringify([{ Name: 'Build VM', State: 'Running' }]) })
      if (file === 'VBoxManage') return result({ out: '"dev box" {1111}\n' })
      if (file === 'wsl.exe') return result({ code: 1 })
      return result({ missing: true, code: null })
    })
    const found = await listLocalVms(exec, 'win32')
    expect(found.map((f) => [f.kind, f.name, f.host, f.source])).toEqual([
      ['hyperv', 'Build VM', 'Build VM', 'Hyper-V on this PC (Running)'],
      ['ssh', 'dev box', '', 'VirtualBox']
    ])
    expect(calls.some((c) => c.file === 'prlctl' || c.file === 'virsh')).toBe(false)
    expect((await listLocalVms(scripted(({ file }) => (file === 'prlctl' ? result({ out: JSON.stringify([{ name: 'Win', status: 'running', ip_configured: '10.0.0.2' }]) }) : result({ missing: true }))).exec, 'darwin'))[0]).toMatchObject({ kind: 'ssh', host: '10.0.0.2' })
  })

  it('combines the network and the local VMs, and survives the network search failing', async () => {
    const { exec } = scripted(({ file }) => (file === 'VBoxManage' ? result({ out: '"vm" {1}\n' }) : result({ missing: true })))
    const ok = await discoverAll({ exec, platform: 'linux', browse: async () => [{ type: 'ssh', name: 'nas', host: 'nas.local', addresses: ['192.168.1.5'], port: 22 }] })
    expect(ok.map((f) => f.name)).toEqual(['nas', 'vm'])
    const broken = await discoverAll({ exec, platform: 'linux', browse: async () => Promise.reject(new Error('multicast blocked')) })
    expect(broken.map((f) => f.name)).toEqual(['vm'])
  })
})
