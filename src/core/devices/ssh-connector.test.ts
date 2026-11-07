import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateClientKey, startSshFixture, type SshFixture } from '../../../scripts/lib/ssh-fixture.mjs'
import { HostKeyError, OutputCollector, cleanClixml, powershellCommand, type DeviceTarget } from './connector'
import { SshConnector } from './ssh-connector'

const open: SshConnector[] = []
const fixtures: SshFixture[] = []
const temp: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
  await Promise.all(fixtures.splice(0).map((f) => f.close().catch(() => undefined)))
  temp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

async function fixture(options: Parameters<typeof startSshFixture>[0] = {}) {
  const f = await startSshFixture(options)
  fixtures.push(f)
  return f
}

const targetFor = (f: SshFixture, over: Partial<DeviceTarget> = {}): DeviceTarget => ({
  kind: 'ssh',
  host: f.host,
  port: f.port,
  username: 'dev',
  authMethod: 'password',
  shell: 'posix',
  os: 'unknown',
  hostKeySha256: f.fingerprint,
  ...over
})

function connect(f: SshFixture, over: Partial<DeviceTarget> = {}, password = 'secret') {
  const c = new SshConnector(targetFor(f, over), { password })
  open.push(c)
  return c
}

const quick = { timeoutMs: 5000, maxBytes: 64 * 1024 }

describe('SshConnector: signing in', () => {
  it('learns that a Linux machine is Linux and who it signed in as', async () => {
    const f = await fixture()
    expect(await connect(f).probe()).toEqual({ os: 'linux', shell: 'posix', user: 'fixture-user', hostname: 'fixture-host' })
  })

  it('learns that a Windows machine is Windows and then sends commands as PowerShell', async () => {
    const f = await fixture({ os: 'windows' })
    const c = connect(f)
    expect(await c.probe()).toEqual({ os: 'windows', shell: 'powershell', user: 'fixture-user', hostname: 'WIN-FIXTURE' })
    const r = await c.run("Write-Output héllo-$env:X-'q'", quick)
    expect(r).toMatchObject({ exitCode: 0, output: "héllo-$env:X-'q'\n" })
    expect(f.commands.at(-1)).toBe("powershell: Write-Output héllo-$env:X-'q'")
  })

  it('does not send anything to a computer whose key was never confirmed, and shows its fingerprint', async () => {
    const f = await fixture()
    const error = await connect(f, { hostKeySha256: null }).probe().catch((e) => e)
    expect(error).toBeInstanceOf(HostKeyError)
    expect(error).toMatchObject({ state: 'unknown', fingerprint: f.fingerprint })
    expect(f.commands).toEqual([])
  })

  it('refuses a computer whose key is not the confirmed one, and sends nothing', async () => {
    const first = await fixture()
    const pinned = first.fingerprint
    const port = first.port
    await first.close()
    const impostor = await fixture({ port })
    const error = await connect(impostor, { hostKeySha256: pinned }).probe().catch((e) => e)
    expect(error).toBeInstanceOf(HostKeyError)
    expect(error).toMatchObject({ state: 'changed', expected: pinned, fingerprint: impostor.fingerprint })
    expect(error.fingerprint).not.toBe(pinned)
    expect(impostor.commands).toEqual([])
  })

  it('says plainly when the password is wrong', async () => {
    const f = await fixture()
    await expect(connect(f, {}, 'nope').probe()).rejects.toThrow(/sign-in was refused/)
  })

  it('signs in with a key file', async () => {
    const keys = generateClientKey()
    const dir = mkdtempSync(join(tmpdir(), 'celeste-key-'))
    temp.push(dir)
    const keyPath = join(dir, 'id_ed25519')
    writeFileSync(keyPath, keys.private)
    const f = await fixture({ authorizedKey: keys.public })
    const c = new SshConnector(targetFor(f, { authMethod: 'key', keyPath }), {})
    open.push(c)
    expect((await c.probe()).os).toBe('linux')
  })

  it('reports a machine that is not there without hanging', async () => {
    const f = await fixture()
    const port = f.port
    await f.close()
    const c = new SshConnector(targetFor(f, { port }), { password: 'secret' }, { readyTimeoutMs: 2000 })
    open.push(c)
    await expect(c.probe()).rejects.toThrow()
  })
})

describe('SshConnector: running commands', () => {
  it('returns the output and the exit code, with errors in the same stream', async () => {
    const f = await fixture()
    const c = connect(f)
    expect(await c.run('echo hello', quick)).toMatchObject({ exitCode: 0, output: 'hello\n', truncated: false })
    expect(await c.run('fail', quick)).toMatchObject({ exitCode: 3, output: 'boom\n' })
    expect(await c.run('nothing-like-this', quick)).toMatchObject({ exitCode: 127 })
  })

  it('keeps the start and the end of long output and says how much it left out', async () => {
    const f = await fixture()
    const r = await connect(f).run('big 50000', { timeoutMs: 5000, maxBytes: 1000 })
    expect(r.truncated).toBe(true)
    expect(r.output.startsWith('S')).toBe(true)
    expect(r.output.endsWith('E')).toBe(true)
    expect(r.output).toMatch(/\[… 49\d{3} bytes left out …\]/)
    expect(r.output.length).toBeLessThan(1200)
  })

  it('stops a command that runs too long', async () => {
    const f = await fixture()
    const started = Date.now()
    const r = await connect(f).run('sleep 10000', { timeoutMs: 300, maxBytes: 1000 })
    expect(r).toMatchObject({ timedOut: true, exitCode: null })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('stops a command when asked to', async () => {
    const f = await fixture()
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 200)
    const r = await connect(f).run('sleep 10000', { timeoutMs: 10_000, maxBytes: 1000, signal: abort.signal })
    expect(r).toMatchObject({ cancelled: true, exitCode: null })
  })

  it('runs one command at a time on a device', async () => {
    const f = await fixture()
    const c = connect(f)
    const started = Date.now()
    const both = await Promise.all([c.run('sleep 300', quick), c.run('sleep 300', quick)])
    expect(both.every((r) => r.exitCode === 0)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(580)
  })

  it('turns PowerShell’s XML error report into the message', async () => {
    const f = await fixture({ os: 'windows' })
    const c = connect(f)
    await c.probe()
    expect((await c.run('throw', quick)).output).toBe('nope')
  })

  it('reports a dropped connection as an error instead of waiting', async () => {
    const f = await fixture()
    const c = connect(f)
    await c.probe()
    const running = c.run('sleep 10000', { timeoutMs: 10_000, maxBytes: 1000 })
    setTimeout(() => f.dropConnections(), 200)
    const started = Date.now()
    await expect(running).rejects.toThrow(/connection to the device was lost/)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('SshConnector: files', () => {
  it('writes, reads, lists and downloads', async () => {
    const f = await fixture()
    const c = connect(f)
    await c.writeFile('/notes/todo.txt', Buffer.from('buy milk\n'))
    mkdirSync(join(f.root, 'notes', 'old'), { recursive: true })

    expect(readFileSync(join(f.root, 'notes', 'todo.txt'), 'utf8')).toBe('buy milk\n')
    const read = await c.readFile('/notes/todo.txt', 1000)
    expect(read.data.toString()).toBe('buy milk\n')
    expect(read).toMatchObject({ size: 9, truncated: false })

    const list = await c.list('/notes')
    expect(list.map((e) => [e.name, e.type])).toEqual([['old', 'dir'], ['todo.txt', 'file']])
    expect(list[1].size).toBe(9)

    const dir = mkdtempSync(join(tmpdir(), 'celeste-dl-'))
    temp.push(dir)
    await c.download('/notes/todo.txt', join(dir, 'copy.txt'))
    expect(readFileSync(join(dir, 'copy.txt'), 'utf8')).toBe('buy milk\n')
  })

  it('reads only as much as asked and says the file is longer', async () => {
    const f = await fixture()
    const c = connect(f)
    await c.writeFile('/big.txt', Buffer.alloc(5000, 'a'))
    const r = await c.readFile('/big.txt', 100)
    expect(r.data.length).toBe(100)
    expect(r).toMatchObject({ size: 5000, truncated: true })
  })

  it('explains a missing file and a folder read as a file', async () => {
    const f = await fixture()
    const c = connect(f)
    mkdirSync(join(f.root, 'folder'))
    await expect(c.readFile('/missing.txt', 100)).rejects.toThrow()
    await expect(c.readFile('/folder', 100)).rejects.toThrow(/is a folder/)
    await expect(c.list('/missing')).rejects.toThrow()
  })
})

describe('output and command helpers', () => {
  it('collects everything when it fits', () => {
    const o = new OutputCollector(100)
    o.push(Buffer.from('abc'))
    o.push(Buffer.from('def'))
    expect(o.result()).toEqual({ text: 'abcdef', truncated: false })
  })

  it('cuts the middle when it does not', () => {
    const o = new OutputCollector(10)
    for (const part of ['0123456789', 'abcdefghij', 'ABCDEFGHIJ']) o.push(Buffer.from(part))
    const { text, truncated } = o.result()
    expect(truncated).toBe(true)
    expect(text.startsWith('01234')).toBe(true)
    expect(text.endsWith('FGHIJ')).toBe(true)
    expect(text).toContain('20 bytes left out')
  })

  it('encodes PowerShell so quotes and dollar signs arrive as written', () => {
    const line = powershellCommand(`Write-Output 'it''s "$HOME"'`)
    expect(line).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    const decoded = Buffer.from(line.split(' ').at(-1) as string, 'base64').toString('utf16le')
    expect(decoded.endsWith(`Write-Output 'it''s "$HOME"'`)).toBe(true)
    expect(decoded).toContain('UTF8')
  })

  it('leaves ordinary text alone and unwraps PowerShell error XML', () => {
    expect(cleanClixml('plain')).toBe('plain')
    expect(cleanClixml('#< CLIXML\n<Objs><S S="Error">The term is not recognized_x000D__x000A_</S><S S="Error">At line:1 &lt;here&gt;_x000D__x000A_</S></Objs>')).toBe(
      'The term is not recognized\nAt line:1 <here>'
    )
  })
})

beforeEach(() => undefined)
