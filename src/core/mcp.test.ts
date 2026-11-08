import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { McpServerInput } from '@shared/api'
import { joinArgs, parseMcpJson, serverKey, splitArgs } from '@shared/mcp'
import { MemoryStore } from './testing/memory-store'
import { McpService, forClaude, forCopilot, mcpSecretName, probe } from './mcp'

const FIXTURE = resolve(process.cwd(), 'scripts', 'lib', 'mcp-fixture.mjs')
const stdio = (over: Partial<McpServerInput> = {}): McpServerInput => ({ name: 'Fixture', type: 'stdio', command: process.execPath, args: [FIXTURE], envNames: [], headerNames: [], ...over })

describe('words and lines', () => {
  it('makes a name safe to go inside a vendor’s tool names', () => {
    expect(serverKey('My Internal Tool!')).toBe('my-internal-tool')
    expect(serverKey('  --a__b--  ')).toBe('a-b')
    expect(serverKey('???')).toBe('')
    expect(serverKey('x'.repeat(80)).length).toBe(40)
  })

  it('splits a command line into words, keeping quoted parts together, and joins them back', () => {
    expect(splitArgs('-y @scope/server --root "C:\\My Files" --name \'two words\'')).toEqual(['-y', '@scope/server', '--root', 'C:\\My Files', '--name', 'two words'])
    expect(splitArgs('   ')).toEqual([])
    expect(splitArgs('a "" b')).toEqual(['a', '', 'b'])
    expect(splitArgs(joinArgs(['--root', 'C:\\My Files', 'plain']))).toEqual(['--root', 'C:\\My Files', 'plain'])
  })
})

describe('reading a pasted configuration', () => {
  it('reads the mcpServers of a .mcp.json, programs and web addresses, with their variables and headers', () => {
    const { servers, skipped } = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          files: { command: 'npx', args: ['-y', 'server-files', '/work'], env: { TOKEN: 'abc', COUNT: 3 } },
          remote: { type: 'http', url: 'https://tools.example.com/mcp', headers: { Authorization: 'Bearer x' } },
          odd: { nothing: true },
          bad: 'text'
        }
      })
    )
    expect(servers).toEqual([
      { name: 'files', type: 'stdio', command: 'npx', args: ['-y', 'server-files', '/work'], env: { TOKEN: 'abc' }, headers: {} },
      { name: 'remote', type: 'http', url: 'https://tools.example.com/mcp', env: {}, headers: { Authorization: 'Bearer x' } }
    ])
    expect(skipped).toEqual(['odd: needs a command or a web address', 'bad: not a server'])
  })

  it('also takes the table without the wrapper, or one server on its own', () => {
    expect(parseMcpJson('{"a":{"command":"x"}}').servers.map((s) => s.name)).toEqual(['a'])
    expect(parseMcpJson('{"command":"node","args":["s.js"]}').servers).toMatchObject([{ name: 'server', command: 'node', args: ['s.js'] }])
  })

  it('refuses what is not JSON, not an object, or has nothing in it, and ignores a web address that is not http', () => {
    expect(() => parseMcpJson('not json')).toThrow(/not valid JSON/)
    expect(() => parseMcpJson('[1,2]')).toThrow(/JSON object/)
    expect(() => parseMcpJson('{"mcpServers":{}}')).toThrow(/No servers/)
    expect(parseMcpJson('{"a":{"url":"file:///etc/passwd"}}').skipped).toEqual(['a: needs a command or a web address'])
  })
})

describe('the list of tools', () => {
  let store: MemoryStore
  let service: McpService
  const secrets = new Map<string, string>()
  beforeEach(() => {
    store = new MemoryStore()
    secrets.clear()
    service = new McpService(store, async (name) => secrets.get(name) ?? null, 15_000)
  })
  const api = () => service.api

  it('starts empty, keeps what is added in name order, and survives a restart', async () => {
    expect(api()['mcp.list']()).toEqual([])
    await api()['mcp.save'](stdio({ name: 'Zeta' }))
    await api()['mcp.save'](stdio({ name: 'Alpha', envNames: ['FIXTURE_TOKEN'] }))
    expect(api()['mcp.list']().map((s) => s.name)).toEqual(['Alpha', 'Zeta'])
    expect(api()['mcp.list']()[0]).toMatchObject({ type: 'stdio', command: process.execPath, envNames: ['FIXTURE_TOKEN'], enabled: true })
    const again = new McpService(store, async () => null)
    expect(again.api['mcp.list']().map((s) => s.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('changes, switches off and removes a tool', async () => {
    const added = await api()['mcp.save'](stdio())
    await api()['mcp.save']({ ...stdio({ name: 'Renamed' }), id: added.id })
    expect(api()['mcp.list']().map((s) => s.name)).toEqual(['Renamed'])
    expect(api()['mcp.setEnabled'](added.id, false).enabled).toBe(false)
    expect(api()['mcp.list']()[0]?.enabled).toBe(false)
    api()['mcp.remove'](added.id)
    expect(api()['mcp.list']()).toEqual([])
    expect(() => api()['mcp.remove'](added.id)).toThrow(/not in the list/)
    await expect(api()['mcp.save']({ ...stdio(), id: 'mcp-00000000' })).rejects.toThrow(/not in the list/)
  })

  it('refuses names that clash, that are Celeste’s own, or empty, and anything that is not a program or an http address', async () => {
    await api()['mcp.save'](stdio({ name: 'Notes' }))
    await expect(api()['mcp.save'](stdio({ name: 'notes' }))).rejects.toThrow(/already has that name/)
    await expect(api()['mcp.save'](stdio({ name: 'Notes!' }))).rejects.toThrow(/already has that name/)
    await expect(api()['mcp.save'](stdio({ name: 'Celeste Devices' }))).rejects.toThrow(/Celeste’s own/)
    await expect(api()['mcp.save'](stdio({ name: '   ' }))).rejects.toThrow(/name of up to 40/)
    await expect(api()['mcp.save'](stdio({ name: '???' }))).rejects.toThrow(/letters or numbers/)
    await expect(api()['mcp.save'](stdio({ name: 'x'.repeat(41) }))).rejects.toThrow(/name of up to 40/)
    await expect(api()['mcp.save'](stdio({ name: 'A', command: '  ' }))).rejects.toThrow(/which program/)
    await expect(api()['mcp.save'](stdio({ name: 'B', args: [1 as never] }))).rejects.toThrow(/arguments/)
    await expect(api()['mcp.save']({ name: 'C', type: 'http', url: 'ftp://x', envNames: [], headerNames: [] })).rejects.toThrow(/https/)
    await expect(api()['mcp.save']({ name: 'D', type: 'http', url: 'not a url', envNames: [], headerNames: [] })).rejects.toThrow(/not valid/)
    await expect(api()['mcp.save']({ name: 'E', type: 'ssh' as never, envNames: [], headerNames: [] })).rejects.toThrow(/program or a web address/)
    await expect(api()['mcp.save'](stdio({ name: 'F', envNames: ['bad name'] }))).rejects.toThrow(/not a valid environment variable name/)
    await expect(api()['mcp.save'](stdio({ name: 'G', envNames: ['A', 'a'] }))).rejects.toThrow(/listed twice/)
    await expect(api()['mcp.save']({ name: 'H', type: 'http', url: 'https://x.test/mcp', envNames: [], headerNames: ['Bad Header'] })).rejects.toThrow(/not a valid header name/)
    expect(api()['mcp.list']()).toHaveLength(1)
  })

  it('never shows a secret: the list has the names of variables and headers and nothing else', async () => {
    secrets.set(mcpSecretName('mcp-aaaaaaaa', 'env', 'FIXTURE_TOKEN'), 'super-secret-value')
    const added = await api()['mcp.save'](stdio({ envNames: ['FIXTURE_TOKEN'] }))
    expect(JSON.stringify(api()['mcp.list']())).not.toContain('super-secret-value')
    expect(Object.keys(added).sort()).toEqual(['args', 'command', 'enabled', 'envNames', 'headerNames', 'id', 'name', 'status', 'type'])
  })

  it('hands the enabled tools to a vendor with their secrets in, and leaves out the ones that are off', async () => {
    const on = await api()['mcp.save'](stdio({ name: 'On', envNames: ['FIXTURE_TOKEN', 'MISSING'] }))
    const web = await api()['mcp.save']({ name: 'Web', type: 'http', url: 'https://tools.example.com/mcp', envNames: [], headerNames: ['Authorization'] })
    const off = await api()['mcp.save'](stdio({ name: 'Off' }))
    api()['mcp.setEnabled'](off.id, false)
    secrets.set(mcpSecretName(on.id, 'env', 'FIXTURE_TOKEN'), 'abc')
    secrets.set(mcpSecretName(web.id, 'header', 'Authorization'), 'Bearer xyz')

    const resolved = await service.resolved()
    expect(resolved.map((s) => s.key)).toEqual(['on', 'web'])
    expect(resolved[0]).toMatchObject({ type: 'stdio', command: process.execPath, args: [FIXTURE], env: { FIXTURE_TOKEN: 'abc' } })
    expect(resolved[0]?.env).not.toHaveProperty('MISSING')
    expect(forClaude(resolved[0] as never)).toEqual({ type: 'stdio', command: process.execPath, args: [FIXTURE], env: { FIXTURE_TOKEN: 'abc' } })
    expect(forCopilot(resolved[1] as never)).toEqual({ type: 'http', url: 'https://tools.example.com/mcp', headers: { Authorization: 'Bearer xyz' }, tools: ['*'] })
    expect(forCopilot(resolved[0] as never)).toMatchObject({ type: 'stdio', tools: ['*'] })
  })

  it('looks at a tool by really starting it, asks for its tools, and says what it found', async () => {
    const added = await api()['mcp.save'](stdio())
    const status = await api()['mcp.test'](added.id)
    expect(status).toMatchObject({ state: 'ok' })
    expect(status.state === 'ok' && status.tools.map((t) => t.name).sort()).toEqual(['boom', 'header', 'shout', 'whoami'])
    expect(status.state === 'ok' && status.tools.find((t) => t.name === 'shout')?.description).toBe('Answers the text in capital letters')
    expect(api()['mcp.list']()[0]?.status).toMatchObject({ state: 'ok' })
  }, 60_000)

  it('gives the program its secret variables when it is started', async () => {
    const added = await api()['mcp.save'](stdio({ envNames: ['FIXTURE_TOKEN'] }))
    secrets.set(mcpSecretName(added.id, 'env', 'FIXTURE_TOKEN'), 'token-from-the-store')
    const [server] = await service.resolved()
    const tools = await probe(server as never, 30_000)
    expect(tools.length).toBe(4)
    // The same program asked for its answer: the variable arrived in its environment.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const client = new Client({ name: 't', version: '1' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [FIXTURE], env: { ...process.env, ...(server as { env: Record<string, string> }).env } as Record<string, string>, stderr: 'pipe' }))
    const out = await client.callTool({ name: 'whoami', arguments: {} })
    await client.close()
    expect(JSON.stringify(out)).toContain('token=token-from-the-store')
  }, 60_000)

  it('says why a tool did not work: no such program, a program that stops at once, a program that is not an MCP server', async () => {
    const missing = await api()['mcp.save'](stdio({ name: 'Missing', command: 'definitely-not-a-program-xyz' }))
    const m = await api()['mcp.test'](missing.id)
    expect(m).toMatchObject({ state: 'failed' })
    expect(m.state === 'failed' && m.message.length).toBeGreaterThan(5)

    const dir = mkdtempSync(join(tmpdir(), 'celeste-mcp-'))
    try {
      writeFileSync(join(dir, 'quits.mjs'), 'console.error("I could not start because of a bad setting"); process.exit(3)')
      writeFileSync(join(dir, 'silent.mjs'), 'setTimeout(() => {}, 60000)')
      const quits = await api()['mcp.save'](stdio({ name: 'Quits', args: [join(dir, 'quits.mjs')] }))
      const q = await api()['mcp.test'](quits.id)
      expect(q.state === 'failed' && q.message).toMatch(/bad setting/)

      const slow = new McpService(store, async () => null, 1500)
      const silent = await slow.api['mcp.save'](stdio({ name: 'Silent', args: [join(dir, 'silent.mjs')] }))
      const s = await slow.test(silent.id)
      expect(s.state === 'failed' && s.message).toMatch(/longer than/)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }, 90_000)

  it('shares one look between two asks at the same time, and drops a result for a tool that was removed meanwhile', async () => {
    const added = await api()['mcp.save'](stdio({ name: 'Once' }))
    const [a, b] = await Promise.all([service.test(added.id), service.test(added.id)])
    expect(a).toBe(b)
    const second = await api()['mcp.save'](stdio({ name: 'Gone' }))
    const pending = service.test(second.id)
    api()['mcp.remove'](second.id)
    await pending
    expect(api()['mcp.list']().map((s) => s.name)).toEqual(['Once'])
  }, 90_000)
})


describe('a tool that is a web address', () => {
  let child: ChildProcess | undefined
  let port = 0

  beforeAll(async () => {
    // A real MCP server over HTTP (the fixture) that wants the right Authorization header.
    const free = await new Promise<number>((ok) => {
      const probeServer = createServer()
      probeServer.listen(0, '127.0.0.1', () => {
        const p = (probeServer.address() as AddressInfo).port
        probeServer.close(() => ok(p))
      })
    })
    port = free
    child = spawn(process.execPath, [FIXTURE, '--http', String(port), '--require', 'Bearer open-sesame'], { stdio: 'ignore', windowsHide: true })
    await new Promise((r) => setTimeout(r, 1500))
  })
  afterAll(() => {
    child?.kill()
  })

  it('connects with the header it was given, and is refused without it', async () => {
    const secrets = new Map<string, string>()
    const service = new McpService(new MemoryStore(), async (n) => secrets.get(n) ?? null, 15_000)
    const added = await service.api['mcp.save']({ name: 'Remote', type: 'http', url: `http://127.0.0.1:${port}/mcp`, envNames: [], headerNames: ['Authorization'] })
    expect(await service.test(added.id)).toMatchObject({ state: 'failed' })
    secrets.set(mcpSecretName(added.id, 'header', 'Authorization'), 'Bearer open-sesame')
    const ok = await service.test(added.id)
    expect(ok.state).toBe('ok')
    expect(ok.state === 'ok' && ok.tools.map((t) => t.name)).toContain('shout')
  }, 60_000)

  it('says plainly when nothing is listening', async () => {
    const service = new McpService(new MemoryStore(), async () => null, 8000)
    const added = await service.api['mcp.save']({ name: 'Nobody', type: 'http', url: 'http://127.0.0.1:9/mcp', envNames: [], headerNames: [] })
    const status = await service.test(added.id)
    expect(status.state === 'failed' && status.message.length).toBeGreaterThan(5)
  }, 60_000)
})
