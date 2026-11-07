import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CorePush } from '@shared/api'
import { DEFAULT_SETTINGS, DEFAULT_VENDORS } from '@shared/defaults'
import type { AccessLevel, DeviceRecord } from '@shared/devices'
import { startSshFixture, type SshFixture } from '../../../scripts/lib/ssh-fixture.mjs'
import { MemoryFileStore, MemoryStore } from '../memory-store'
import { createMockSession } from '../mock/engine'
import { SessionService } from '../service'
import { fakeConnectorFactory } from './fake-connector'
import { DeviceService, type FileOps } from './device-service'
import { DeviceToolServer } from './mcp-server'
import { nodeFileOps } from './node-fs'
import { SshConnector } from './ssh-connector'
import { DeviceTools, normalizePath } from './tools'

const idle = { vendorSessionId: 'x', events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }) }, send() {}, respond() {}, async setModel() {}, async setApprovalMode() {}, async interrupt() {}, async close() {} }

const noDisk = (removed: string[] = []): FileOps => ({
  join: (...p) => p.join('/'),
  dirname: (p) => p.split('/').slice(0, -1).join('/'),
  mkdirp: async () => undefined,
  remove: async (p) => void removed.push(p)
})

function world(useMock = false) {
  const store = new MemoryStore()
  const pushes: CorePush[] = []
  const removed: string[] = []
  const connectors = fakeConnectorFactory()
  let tools!: DeviceTools
  const sessions = new SessionService({
    store,
    files: new MemoryFileStore(),
    dataDir: '/data',
    adapter: useMock ? (ctx) => createMockSession({ ...ctx, devices: { call: (n, a, h) => tools.call(ctx.sessionId, n, a, h) } }) : () => idle as never,
    push: (p) => pushes.push(p),
    defaults: DEFAULT_SETTINGS,
    defaultVendors: DEFAULT_VENDORS,
    onSessionStopped: (id) => tools.cancel(id)
  })
  const devices = new DeviceService({ store, dataDir: '/data', getSecret: async () => 'pw', connectorFor: connectors, push: (p) => pushes.push(p), fs: noDisk(removed) })
  tools = new DeviceTools(store, devices, sessions, noDisk(removed), '/data')
  const newSession = () =>
    sessions.api['sessions.create']({ vendor: 'claude', mode: 'chat', title: 'Check the servers', model: 'copilot-auto', effort: null, approval: 'auto' }).id

  /** Adds a device the way the window does: create, test (key unknown), trust the key, test again. */
  async function addDevice(name: string, level: AccessLevel = 'read', host = '10.0.0.5'): Promise<DeviceRecord> {
    let d = await devices.api['devices.create']({ name, kind: 'ssh', host, username: 'dev', authMethod: 'password' })
    const first = await devices.api['devices.test'](d.id)
    if (first.ok || !first.hostKey) throw new Error('expected an unknown host key')
    d = await devices.api['devices.trustKey'](d.id, first.hostKey.fingerprint)
    const second = await devices.api['devices.test'](d.id)
    if (!second.ok) throw new Error(second.error)
    return devices.api['devices.update'](d.id, { accessLevel: level })
  }
  const approvals = (sessionId: string) =>
    store.events(sessionId).flatMap((e) => (e.event.type === 'approval.requested' ? [{ requestId: e.event.requestId, title: e.event.title, detail: e.event.detail, kind: e.event.kind }] : []))
  const waitForApproval = async (sessionId: string) => {
    for (let i = 0; i < 200 && approvals(sessionId).length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    return approvals(sessionId).at(-1) as ReturnType<typeof approvals>[number]
  }
  return { store, sessions, devices, tools, connectors, pushes, removed, newSession, addDevice, approvals, waitForApproval }
}

describe('adding and testing a device', () => {
  it('starts read only and unverified, and checks what it is given', async () => {
    const { devices } = world()
    const d = await devices.api['devices.create']({ name: 'build-vm', kind: 'ssh', host: '10.0.0.5', username: 'dev', authMethod: 'password' })
    expect(d).toMatchObject({ accessLevel: 'read', os: 'unknown', hostKeySha256: null, lastSeenAt: null, port: 22 })
    await expect(devices.api['devices.create']({ name: '', kind: 'ssh', host: 'h', username: 'u', authMethod: 'password' })).rejects.toThrow()
    await expect(devices.api['devices.create']({ name: 'x', kind: 'ftp' as never, host: 'h', username: 'u', authMethod: 'password' })).rejects.toThrow()
    await expect(devices.api['devices.create']({ name: 'x', kind: 'ssh', host: 'h', username: 'u', authMethod: 'key' })).rejects.toThrow(/key file/)
    await expect(devices.api['devices.create']({ name: 'x', kind: 'ssh', host: 'h', username: 'u', authMethod: 'password', port: 70000 })).rejects.toThrow(/port/)
    expect((await devices.api['devices.list']()).map((x) => x.name)).toEqual(['build-vm'])
  })

  it('asks you to confirm an unknown computer, then connects and learns what it is', async () => {
    const { devices } = world()
    const d = await devices.api['devices.create']({ name: 'build-vm', kind: 'ssh', host: '10.0.0.5', username: 'dev', authMethod: 'password' })
    const first = await devices.api['devices.test'](d.id)
    expect(first).toMatchObject({ ok: false, hostKey: { state: 'unknown' } })
    await expect(devices.api['devices.trustKey'](d.id, 'not a fingerprint')).rejects.toThrow()

    if (first.ok || !first.hostKey) return
    await devices.api['devices.trustKey'](d.id, first.hostKey.fingerprint)
    const second = await devices.api['devices.test'](d.id)
    expect(second).toMatchObject({ ok: true, probe: { os: 'linux', shell: 'posix' }, device: { os: 'linux', hostKeySha256: first.hostKey.fingerprint } })
    expect((await devices.api['devices.list']())[0].lastSeenAt).not.toBeNull()
    const activity = await devices.api['devices.activity'](d.id)
    expect(activity.map((a) => a.tool)).toEqual(['test', 'trust'])
  })

  it('treats a new address as a new computer that must be confirmed again', async () => {
    const { devices, addDevice } = world()
    const d = await addDevice('build-vm')
    expect(d.hostKeySha256).not.toBeNull()
    expect((await devices.api['devices.update'](d.id, { name: 'renamed' })).hostKeySha256).toBe(d.hostKeySha256)
    expect((await devices.api['devices.update'](d.id, { host: '10.0.0.99' })).hostKeySha256).toBeNull()
    expect(await devices.api['devices.test'](d.id)).toMatchObject({ ok: false, hostKey: { state: 'unknown' } })
  })

  it('refuses a pinned key that no longer matches', async () => {
    const { devices, addDevice } = world()
    const d = await addDevice('build-vm')
    const other = 'SHA256:' + 'A'.repeat(43)
    await devices.api['devices.trustKey'](d.id, other)
    const r = await devices.api['devices.test'](d.id)
    expect(r).toMatchObject({ ok: false, hostKey: { state: 'changed', expected: other } })
  })

  it('removes a device with its attachments, and deletes copies of its folders', async () => {
    const { devices, addDevice, newSession, removed, store } = world()
    const d = await addDevice('build-vm')
    const s = newSession()
    await devices.api['devices.attach'](s, d.id, true)
    await devices.api['devices.remove'](d.id)
    expect(store.attachedDevices(s)).toEqual([])
    expect(removed).toContain(`/data/devices/${d.id}`)
    await expect(devices.api['devices.attach'](s, d.id, true)).rejects.toThrow(/no longer exists/)
  })
})

describe('what an assistant may do, by access level', () => {
  it('offers nothing until a device is attached, and only to the session it is attached to', async () => {
    const { tools, devices, addDevice, newSession } = world()
    const a = newSession()
    const b = newSession()
    const d = await addDevice('build-vm', 'full')
    expect(tools.available(a)).toEqual(['devices_list'])
    await devices.api['devices.attach'](a, d.id, true)
    expect(tools.available(a)).toContain('device_run')
    expect(tools.available(b)).toEqual(['devices_list'])
    expect(await tools.call(b, 'devices_list', {})).toMatchObject({ isError: false, text: expect.stringMatching(/No device is attached/) })
    expect(await tools.call(b, 'device_run', { device: 'build-vm', command: 'echo hi' })).toMatchObject({ isError: true })
  })

  it('gives a read only device no command or write tool, and refuses them anyway', async () => {
    const { tools, devices, addDevice, newSession, connectors } = world()
    const s = newSession()
    const d = await addDevice('build-vm', 'read')
    await devices.api['devices.attach'](s, d.id, true)
    expect(tools.available(s)).toEqual(['devices_list', 'device_read_file', 'device_list_dir', 'device_pull'])
    const refused = await tools.call(s, 'device_run', { device: 'build-vm', command: 'rm -rf /' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/command or write tool|read only/i)
    expect(connectors.made.flatMap((c) => c.ran).filter((c) => c.includes('rm'))).toEqual([])

    const read = await tools.call(s, 'device_read_file', { device: 'build-vm', path: '/home/dev/notes.txt' })
    expect(read).toEqual({ text: 'rotate the logs on Friday\n', isError: false })
    const list = await tools.call(s, 'device_list_dir', { device: 'build-vm', path: '/home/dev' })
    expect(list.text).toMatch(/dir .*app\/\n.*file .*README.md/s)
  })

  it('shows an approval card with the exact command, and runs only if it is allowed', async () => {
    const { tools, devices, addDevice, newSession, sessions, waitForApproval, connectors, store } = world()
    const s = newSession()
    const d = await addDevice('build-vm', 'ask')
    await devices.api['devices.attach'](s, d.id, true)

    const running = tools.call(s, 'device_run', { device: 'build-vm', command: 'echo hello' })
    const card = await waitForApproval(s)
    expect(card).toMatchObject({ kind: 'shell', title: 'Run on build-vm', detail: 'echo hello' })
    expect(connectors.made.flatMap((c) => c.ran)).not.toContain('echo hello')
    expect(store.getSession(s)?.status).toBe('waiting')

    sessions.api['sessions.respondApproval'](s, card.requestId, { allow: true })
    expect(await running).toEqual({ text: 'hello\n[exit code 0]', isError: false })
    expect(connectors.made.flatMap((c) => c.ran)).toContain('echo hello')
  })

  it('does not run a command the user declined, and says so to the assistant', async () => {
    const { tools, devices, addDevice, newSession, sessions, waitForApproval, connectors } = world()
    const s = newSession()
    const d = await addDevice('build-vm', 'ask')
    await devices.api['devices.attach'](s, d.id, true)
    const running = tools.call(s, 'device_run', { device: 'build-vm', command: 'echo no' })
    sessions.api['sessions.respondApproval'](s, (await waitForApproval(s)).requestId, { allow: false })
    const out = await running
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/declined/)
    expect(connectors.made.flatMap((c) => c.ran)).not.toContain('echo no')
    const activity = await devices.api['devices.activity'](d.id)
    expect(activity[0]).toMatchObject({ tool: 'device_run', ok: false, summary: 'Declined: echo no' })
  })

  it('never lets "allow for this session" turn a device into full access', async () => {
    const { tools, devices, addDevice, newSession, sessions, waitForApproval, approvals, store } = world()
    const s = newSession()
    const d = await addDevice('build-vm', 'ask')
    await devices.api['devices.attach'](s, d.id, true)
    const first = tools.call(s, 'device_run', { device: 'build-vm', command: 'echo one' })
    sessions.api['sessions.respondApproval'](s, (await waitForApproval(s)).requestId, { allow: true, always: true })
    await first
    expect(store.getDevice(d.id)?.accessLevel).toBe('ask')
    const second = tools.call(s, 'device_run', { device: 'build-vm', command: 'echo two' })
    for (let i = 0; i < 200 && approvals(s).length < 2; i++) await new Promise((r) => setTimeout(r, 5))
    expect(approvals(s)).toHaveLength(2)
    sessions.api['sessions.respondApproval'](s, approvals(s)[1].requestId, { allow: false })
    await second
  })

  it('runs a full access device without asking, and writes files through the same gate', async () => {
    const { tools, devices, addDevice, newSession, approvals, connectors } = world()
    const s = newSession()
    const d = await addDevice('build-vm', 'full')
    await devices.api['devices.attach'](s, d.id, true)
    expect((await tools.call(s, 'device_run', { device: 'build-vm', command: 'echo quick' })).text).toBe('quick\n[exit code 0]')
    expect((await tools.call(s, 'device_write_file', { device: 'build-vm', path: '/home/dev/new.txt', content: 'made by the assistant' })).text).toMatch(/Wrote 21 bytes/)
    expect(connectors.made[0].files['/home/dev/new.txt']).toBe('made by the assistant')
    expect(approvals(s)).toEqual([])
  })

  it('asks before writing a file on an ask first device, showing the file and where it goes', async () => {
    const { tools, devices, addDevice, newSession, sessions, waitForApproval, connectors } = world()
    const s = newSession()
    const d = await addDevice('build-vm', 'ask')
    await devices.api['devices.attach'](s, d.id, true)
    const writing = tools.call(s, 'device_write_file', { device: 'build-vm', path: '/etc/motd', content: 'hello' })
    const card = await waitForApproval(s)
    expect(card).toMatchObject({ kind: 'edit', title: 'Write /etc/motd on build-vm', detail: 'hello' })
    expect(connectors.made[0].files['/etc/motd']).toBeUndefined()
    sessions.api['sessions.respondApproval'](s, card.requestId, { allow: true })
    expect((await writing).isError).toBe(false)
    expect(connectors.made[0].files['/etc/motd']).toBe('hello')
  })

  it('declines a pending approval when the session is stopped, so the call does not hang', async () => {
    const { tools, devices, addDevice, newSession, sessions, waitForApproval } = world()
    const s = newSession()
    const d = await addDevice('build-vm', 'ask')
    await devices.api['devices.attach'](s, d.id, true)
    const running = tools.call(s, 'device_run', { device: 'build-vm', command: 'echo later' })
    await waitForApproval(s)
    sessions.api['sessions.interrupt'](s)
    const out = await running
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/declined/)
  })

  it('checks arguments, names and what it was asked for', async () => {
    const { tools, devices, addDevice, newSession } = world()
    const s = newSession()
    const d = await addDevice('Build VM', 'full')
    await devices.api['devices.attach'](s, d.id, true)
    expect((await tools.call(s, 'device_run', { device: 'Build VM' })).text).toMatch(/Invalid arguments/)
    expect((await tools.call(s, 'device_run', { device: 'nope', command: 'echo x' })).text).toMatch(/no attached device called "nope".*Build VM/)
    expect((await tools.call(s, 'device_run', { device: 'build vm', command: 'echo x' })).isError).toBe(false)
    expect((await tools.call(s, 'device_nothing', {})).text).toMatch(/no tool called/)
    expect((await tools.call(s, 'device_read_file', { device: 'Build VM', path: '/nope' })).isError).toBe(true)
  })

  it('tells the assistant which shell and path style each device wants', async () => {
    const { tools, devices, addDevice, newSession } = world()
    const s = newSession()
    const lin = await addDevice('linux-box', 'ask', '10.0.0.5')
    const win = await addDevice('win-box', 'read', '10.0.0.6-win')
    await devices.api['devices.attach'](s, lin.id, true)
    await devices.api['devices.attach'](s, win.id, true)
    const text = (await tools.call(s, 'devices_list', {})).text
    expect(text).toMatch(/linux-box: Linux\. Write commands for a POSIX shell.*ask first/)
    expect(text).toMatch(/win-box: Windows\. Write commands for PowerShell\. Paths use forward slashes.*read only/)
  })

  it('writes Windows paths the way SFTP wants them', () => {
    expect(normalizePath('windows', 'C:\\Users\\dev\\a.txt')).toBe('/C:/Users/dev/a.txt')
    expect(normalizePath('windows', 'D:/x')).toBe('/D:/x')
    expect(normalizePath('windows', '/C:/ok')).toBe('/C:/ok')
    expect(normalizePath('linux', '/home/dev')).toBe('/home/dev')
  })
})

// --- real files over real SFTP ------------------------------------------------------------------------

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function sshWorld(confirmAbove?: { files: number; bytes: number }) {
  const fixture: SshFixture = await startSshFixture()
  cleanup.push(() => fixture.close())
  const dataDir = mkdtempSync(join(tmpdir(), 'celeste-snap-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const store = new MemoryStore()
  const devices = new DeviceService({
    store,
    dataDir,
    getSecret: async () => 'secret',
    connectorFor: (t, c) => new SshConnector(t, c),
    push: () => undefined,
    fs: nodeFileOps,
    confirmAbove
  })
  cleanup.push(() => devices.close())
  const d = await devices.api['devices.create']({ name: 'vm', kind: 'ssh', host: fixture.host, port: fixture.port, username: 'dev', authMethod: 'password' })
  await devices.api['devices.trustKey'](d.id, fixture.fingerprint)
  const t = await devices.api['devices.test'](d.id)
  if (!t.ok) throw new Error(t.error)
  return { fixture, devices, dataDir, device: d, store }
}

describe('folders from a device', () => {
  it('browses a folder on the device', async () => {
    const { devices, fixture, device } = await sshWorld()
    mkdirSync(join(fixture.root, 'srv', 'app'), { recursive: true })
    writeFileSync(join(fixture.root, 'srv', 'readme.txt'), 'hi')
    const entries = await devices.api['devices.browse'](device.id, '/srv')
    expect(entries.map((e) => [e.name, e.type])).toEqual([['app', 'dir'], ['readme.txt', 'file']])
    await expect(devices.api['devices.browse'](device.id, '/missing')).rejects.toThrow()
  })

  it('copies a snapshot, leaving out build folders and very large files', async () => {
    const { devices, fixture, device, dataDir } = await sshWorld()
    const app = join(fixture.root, 'srv', 'app')
    mkdirSync(join(app, 'src'), { recursive: true })
    mkdirSync(join(app, 'node_modules', 'dep'), { recursive: true })
    mkdirSync(join(app, '.git'), { recursive: true })
    writeFileSync(join(app, 'package.json'), '{"name":"app"}')
    writeFileSync(join(app, 'src', 'index.ts'), 'export const x = 1\n')
    writeFileSync(join(app, 'node_modules', 'dep', 'index.js'), 'junk')
    writeFileSync(join(app, '.git', 'HEAD'), 'ref')
    writeFileSync(join(app, 'huge.bin'), Buffer.alloc(26 * 1024 * 1024))

    const result = await devices.api['devices.addFolder'](device.id, '/srv/app', 'snapshot')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.folder).toMatchObject({ mode: 'snapshot', files: 2, path: '/srv/app' })
    const local = join(dataDir, 'devices', device.id, result.folder.id)
    expect(readFileSync(join(local, 'src', 'index.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(existsSync(join(local, 'package.json'))).toBe(true)
    expect(existsSync(join(local, 'node_modules'))).toBe(false)
    expect(existsSync(join(local, '.git'))).toBe(false)
    expect(existsSync(join(local, 'huge.bin'))).toBe(false)
  })

  it('asks before copying a lot, then copies when told to', async () => {
    const { devices, fixture, device } = await sshWorld({ files: 2, bytes: 1_000_000 })
    mkdirSync(join(fixture.root, 'big'))
    for (const n of ['a', 'b', 'c']) writeFileSync(join(fixture.root, 'big', `${n}.txt`), n)
    const first = await devices.api['devices.addFolder'](device.id, '/big', 'snapshot')
    expect(first).toEqual({ ok: false, needsConfirm: { files: 3, bytes: 3 } })
    expect(await devices.api['devices.folders']()).toEqual([])
    const second = await devices.api['devices.addFolder'](device.id, '/big', 'snapshot', true)
    expect(second.ok && second.folder.files).toBe(3)
  })

  it('refreshes a snapshot, and deletes the copy when the folder is removed', async () => {
    const { devices, fixture, device, dataDir } = await sshWorld()
    mkdirSync(join(fixture.root, 'proj'))
    writeFileSync(join(fixture.root, 'proj', 'one.txt'), '1')
    const added = await devices.api['devices.addFolder'](device.id, '/proj', 'snapshot')
    if (!added.ok) throw new Error('expected a snapshot')
    const local = join(dataDir, 'devices', device.id, added.folder.id)
    writeFileSync(join(fixture.root, 'proj', 'two.txt'), '22')
    const refreshed = await devices.api['devices.refreshFolder'](added.folder.id)
    expect(refreshed.ok && refreshed.folder).toMatchObject({ files: 2, bytes: 3 })
    expect(existsSync(join(local, 'two.txt'))).toBe(true)
    await devices.api['devices.removeFolder'](added.folder.id)
    expect(existsSync(local)).toBe(false)
    expect(await devices.api['devices.folders']()).toEqual([])
  })

  it('offers snapshots of attached devices as folders the vendor can open, and live folders by tool', async () => {
    const { devices, fixture, device, store } = await sshWorld()
    mkdirSync(join(fixture.root, 'docs'))
    writeFileSync(join(fixture.root, 'docs', 'a.md'), '# a')
    const session = new SessionService({ store, files: new MemoryFileStore(), dataDir: '/x', adapter: () => idle as never, push: () => undefined, defaults: DEFAULT_SETTINGS, defaultVendors: DEFAULT_VENDORS })
    const s = session.api['sessions.create']({ vendor: 'claude', mode: 'chat', title: 't', model: 'm', effort: null, approval: 'auto' }).id
    const snap = await devices.api['devices.addFolder'](device.id, '/docs', 'snapshot')
    await devices.api['devices.addFolder'](device.id, '/docs', 'live')
    expect(devices.snapshotDirs(s)).toEqual([])
    await devices.api['devices.attach'](s, device.id, true)
    expect(devices.snapshotDirs(s)).toHaveLength(1)
    expect(snap.ok).toBe(true)
  })
})

// --- the MCP server ------------------------------------------------------------------------------------

describe('the device tool server', () => {
  async function serverWorld() {
    const w = world()
    const server = new DeviceToolServer(w.tools)
    await server.start()
    cleanup.push(() => server.stop())
    const connect = async (token: string) => {
      const client = new Client({ name: 'test-agent', version: '1' })
      const url = server.info('placeholder').url
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
      cleanup.push(() => client.close())
      return client
    }
    return { ...w, server, connect }
  }

  it('lists the tools a session may use, which follow the device’s access level', async () => {
    const w = await serverWorld()
    const s = w.newSession()
    const d = await w.addDevice('build-vm', 'read')
    await w.devices.api['devices.attach'](s, d.id, true)
    const client = await w.connect(w.server.info(s).token)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['devices_list', 'device_read_file', 'device_list_dir', 'device_pull'])

    await w.devices.api['devices.update'](d.id, { accessLevel: 'full' })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('device_run')
    expect(names).not.toContain('device_screenshot')
  })

  it('runs a tool for the session its token belongs to, and no other', async () => {
    const w = await serverWorld()
    const s = w.newSession()
    const other = w.newSession()
    const d = await w.addDevice('build-vm', 'full')
    await w.devices.api['devices.attach'](s, d.id, true)

    const client = await w.connect(w.server.info(s).token)
    const ran = await client.callTool({ name: 'device_run', arguments: { device: 'build-vm', command: 'echo from mcp' } })
    expect(ran).toMatchObject({ isError: false, content: [{ type: 'text', text: 'from mcp\n[exit code 0]' }] })

    const stranger = await w.connect(w.server.info(other).token)
    expect((await stranger.listTools()).tools.map((t) => t.name)).toEqual(['devices_list'])
  })

  it('holds a tool call open while the approval card waits for an answer', async () => {
    const w = await serverWorld()
    const s = w.newSession()
    const d = await w.addDevice('build-vm', 'ask')
    await w.devices.api['devices.attach'](s, d.id, true)
    const client = await w.connect(w.server.info(s).token)
    const call = client.callTool({ name: 'device_run', arguments: { device: 'build-vm', command: 'echo approved' } })
    const card = await w.waitForApproval(s)
    expect(card.detail).toBe('echo approved')
    w.sessions.api['sessions.respondApproval'](s, card.requestId, { allow: true })
    expect(await call).toMatchObject({ isError: false, content: [{ text: 'approved\n[exit code 0]' }] })
  })

  it('refuses requests without the right token, from a web page, or to the wrong address', async () => {
    const w = await serverWorld()
    const s = w.newSession()
    const { url } = w.server.info(s)
    const port = Number(new URL(url).port)
    const send = (headers: Record<string, string>, path = '/mcp', method = 'POST') =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on('error', reject)
        req.end(method === 'POST' ? '{}' : undefined)
      })
    const ok = { host: `127.0.0.1:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    expect(await send(ok)).toBe(401)
    expect(await send({ ...ok, authorization: 'Bearer wrong' })).toBe(401)
    expect(await send({ ...ok, authorization: `Bearer ${w.server.info(s).token}`, origin: 'https://evil.example' })).toBe(403)
    expect(await send({ ...ok, host: 'evil.example', authorization: `Bearer ${w.server.info(s).token}` })).toBe(403)
    expect(await send({ ...ok, authorization: `Bearer ${w.server.info(s).token}` }, '/other')).toBe(404)
    expect(await send({ ...ok, authorization: `Bearer ${w.server.info(s).token}` }, '/mcp', 'GET')).toBe(405)

    w.server.forget(s)
    expect(await send({ ...ok, authorization: `Bearer ${w.server.info(s).token}` })).not.toBe(401) // a fresh token works
  })
})

// --- the scripted assistant, end to end ----------------------------------------------------------------

describe('the scripted assistant working on a device', () => {
  const types = (store: MemoryStore, id: string) => store.events(id).map((e) => e.event.type)
  const finished = async (store: MemoryStore, id: string) => {
    for (let i = 0; i < 600 && !types(store, id).some((t) => t === 'turn.completed' || t === 'turn.interrupted'); i++) await new Promise((r) => setTimeout(r, 10))
  }
  const lastSaid = (store: MemoryStore, id: string) =>
    store
      .events(id)
      .flatMap((e) => (e.event.type === 'message.delta' ? [e.event.text] : []))
      .join('')

  it('says so when no device is attached', async () => {
    const w = world(true)
    const s = w.newSession()
    w.sessions.api['sessions.send'](s, { text: 'Check my device please', attachments: [] })
    await finished(w.store, s)
    expect(lastSaid(w.store, s)).toMatch(/No device is attached to this chat yet/)
  })

  it('only looks at a read only device, and never asks', async () => {
    const w = world(true)
    const s = w.newSession()
    const d = await w.addDevice('build-vm', 'read')
    await w.devices.api['devices.attach'](s, d.id, true)
    w.sessions.api['sessions.send'](s, { text: 'What is on my device?', attachments: [] })
    await finished(w.store, s)
    const events = w.store.events(s).map((e) => e.event)
    expect(events.filter((e) => e.type === 'approval.requested')).toEqual([])
    expect(events.flatMap((e) => (e.type === 'tool.started' ? [e.kind] : []))).toEqual(['mcp', 'read'])
    expect(lastSaid(w.store, s)).toMatch(/build-vm is read only, so I only looked/)
    expect(w.connectors.made.flatMap((c) => c.ran)).toEqual([])
  })

  it('asks before running a command on an ask first device, then reports what it found', async () => {
    const w = world(true)
    const s = w.newSession()
    const d = await w.addDevice('build-vm', 'ask')
    await w.devices.api['devices.attach'](s, d.id, true)
    w.sessions.api['sessions.send'](s, { text: 'Check disk space on my device', attachments: [] })

    const card = await w.waitForApproval(s)
    expect(card).toMatchObject({ kind: 'shell', title: 'Run on build-vm', detail: 'uname -a; df -h /' })
    expect(w.store.getSession(s)?.status).toBe('waiting')
    expect(w.connectors.made.flatMap((c) => c.ran)).toEqual([])

    w.sessions.api['sessions.respondApproval'](s, card.requestId, { allow: true })
    await finished(w.store, s)
    expect(w.connectors.made.flatMap((c) => c.ran)).toEqual(['uname -a; df -h /'])
    expect(lastSaid(w.store, s)).toMatch(/Here is what `build-vm` reported/)
    expect(lastSaid(w.store, s)).toMatch(/Filesystem/)
    expect(w.store.getSession(s)?.status).toBe('idle')
    // The card for the command appears only after the approval, as a finished tool.
    const order = types(w.store, s)
    expect(order.indexOf('approval.resolved')).toBeLessThan(order.lastIndexOf('tool.started'))
  })

  it('reports plainly when the user declines', async () => {
    const w = world(true)
    const s = w.newSession()
    const d = await w.addDevice('build-vm', 'ask')
    await w.devices.api['devices.attach'](s, d.id, true)
    w.sessions.api['sessions.send'](s, { text: 'Check disk space on my device', attachments: [] })
    w.sessions.api['sessions.respondApproval'](s, (await w.waitForApproval(s)).requestId, { allow: false })
    await finished(w.store, s)
    expect(lastSaid(w.store, s)).toMatch(/did not run on build-vm: The user declined/)
    expect(w.connectors.made.flatMap((c) => c.ran)).toEqual([])
  })

  it('stops cleanly when the user presses Stop while a command waits for approval', async () => {
    const w = world(true)
    const s = w.newSession()
    const d = await w.addDevice('build-vm', 'ask')
    await w.devices.api['devices.attach'](s, d.id, true)
    w.sessions.api['sessions.send'](s, { text: 'Check disk space on my device', attachments: [] })
    await w.waitForApproval(s)
    w.sessions.api['sessions.interrupt'](s)
    await finished(w.store, s)
    expect(w.store.getSession(s)?.status).toBe('idle')
    expect(w.connectors.made.flatMap((c) => c.ran)).toEqual([])
  })
})
