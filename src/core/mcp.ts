import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpApi, McpServerInput, McpServerView, McpStatus } from '@shared/api'
import { ENV_NAME, HEADER_NAME, MAX_ARGS, MAX_PAIRS, MAX_SERVERS, RESERVED_NAMES, mcpSecretName, serverKey } from '@shared/mcp'

/*
 * The outside tools (MCP servers) the person has added. Celeste keeps one list and hands it to whichever vendor runs a session, so an
 * internal tool is added once and every vendor's agent can use it. A server is either a program Celeste starts (stdio) or a web
 * address. Secret values (environment variables, request headers) are not kept here: they live in the encrypted secret store of the
 * main process, which Core can read when it needs one and the window can write but never read back.
 */

/** What is saved for a server. Names of variables and headers only. */
interface Stored {
  id: string
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  envNames: string[]
  headerNames: string[]
  enabled: boolean
}

/** A server ready to be handed to a vendor: secrets filled in. Never sent to the window. */
export interface ResolvedMcpServer {
  /** The name the vendor knows it by, and so what appears in its tool names. */
  key: string
  type: 'stdio' | 'http'
  command?: string
  args: string[]
  env: Record<string, string>
  url?: string
  headers: Record<string, string>
}

interface SettingsStore {
  settings(): Record<string, unknown>
  setSetting(key: string, value: unknown): void
}

/** How long a server has to connect and list its tools. A program that has to download itself first (npx) can be slow. */
const TEST_TIMEOUT_MS = 45_000
const KEY = 'mcpServers'

export { mcpSecretName }

function clean(input: McpServerInput, existing: Stored[]): Stored {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 40) throw new Error('Give the tool a name of up to 40 characters.')
  const key = serverKey(name)
  if (!key) throw new Error('The name needs some letters or numbers in it.')
  if (RESERVED_NAMES.includes(key)) throw new Error(`“${key}” is Celeste’s own tool server, so another tool cannot have that name.`)
  if (existing.some((s) => s.id !== input.id && serverKey(s.name) === key)) throw new Error('Another tool already has that name.')
  if (input.type !== 'stdio' && input.type !== 'http') throw new Error('A tool is either a program or a web address.')

  const names = (list: unknown, rule: RegExp, what: string): string[] => {
    if (!Array.isArray(list) || list.length > MAX_PAIRS) throw new Error(`Too many ${what}.`)
    const seen = new Set<string>()
    for (const n of list) {
      if (typeof n !== 'string' || !rule.test(n)) throw new Error(`“${String(n)}” is not a valid ${what.replace(/s$/, '')} name.`)
      if (seen.has(n.toLowerCase())) throw new Error(`The ${what.replace(/s$/, '')} “${n}” is listed twice.`)
      seen.add(n.toLowerCase())
    }
    return list as string[]
  }
  const envNames = names(input.envNames ?? [], ENV_NAME, 'environment variables')
  const headerNames = names(input.headerNames ?? [], HEADER_NAME, 'headers')
  const base = { id: input.id ?? `mcp-${randomBytes(4).toString('hex')}`, name, envNames, headerNames, enabled: input.enabled !== false }

  if (input.type === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command || command.length > 500) throw new Error('Say which program to run.')
    const args = input.args ?? []
    if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((a) => typeof a !== 'string' || a.length > 2000)) throw new Error('Those arguments are not valid.')
    return { ...base, type: 'stdio', command, args, headerNames: [] }
  }
  let url: URL
  try {
    url = new URL(String(input.url ?? '').trim())
  } catch {
    throw new Error('That web address is not valid.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https:// (or http:// for a tool on this computer).')
  return { ...base, type: 'http', url: url.toString(), envNames: [] }
}

/** Connects once, asks for the tools, and leaves. Everything it started is stopped again. */
export async function probe(server: ResolvedMcpServer, timeoutMs = TEST_TIMEOUT_MS): Promise<{ name: string; description?: string }[]> {
  const limit = <T>(promise: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
    })
    return Promise.race([promise, late]).finally(() => clearTimeout(timer))
  }
  const ask = async (make: () => ConstructorParameters<typeof Client> extends never ? never : unknown): Promise<{ name: string; description?: string }[]> => {
    const client = new Client({ name: 'celeste', version: '1.0.0' })
    const transport = make() as Parameters<Client['connect']>[0] & { stderr?: NodeJS.ReadableStream | null }
    let said = ''
    transport.stderr?.on('data', (b: Buffer) => (said = (said + b.toString('utf8')).slice(-1500)))
    try {
      await limit(client.connect(transport), 'Connecting')
      const { tools } = await limit(client.listTools(), 'Asking for the tools')
      return tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) }))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(said.trim() ? `${reason} The program said: ${said.trim().split('\n').slice(-3).join(' ')}` : reason)
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  if (server.type === 'stdio') {
    return ask(() => new StdioClientTransport({ command: server.command as string, args: server.args, env: { ...getDefaultEnvironment(), ...server.env }, stderr: 'pipe' }))
  }
  const url = new URL(server.url as string)
  const requestInit = { headers: server.headers }
  try {
    return await ask(() => new StreamableHTTPClientTransport(url, { requestInit }))
  } catch (first) {
    // Older servers speak SSE. Only if that also fails is the first answer the one worth showing.
    try {
      return await ask(() => new SSEClientTransport(url, { requestInit }))
    } catch {
      throw first
    }
  }
}

export class McpService {
  private readonly status = new Map<string, McpStatus>()
  private readonly running = new Map<string, Promise<McpStatus>>()

  constructor(
    private readonly store: SettingsStore,
    private readonly getSecret: (name: string) => Promise<string | null>,
    private readonly timeoutMs = TEST_TIMEOUT_MS,
    /** Called when a server's status changes, so the window can look again. */
    private readonly changed: () => void = () => undefined
  ) {}

  private all(): Stored[] {
    const saved = this.store.settings()[KEY]
    return Array.isArray(saved) ? (saved as Stored[]) : []
  }

  private view(s: Stored): McpServerView {
    return { ...s, status: this.status.get(s.id) ?? { state: 'unchecked' } }
  }

  private find(id: unknown): Stored {
    const found = this.all().find((s) => s.id === id)
    if (!found) throw new Error('That tool is not in the list any more.')
    return found
  }

  /** What the window may call. */
  readonly api: McpApi = {
    'mcp.list': () => this.all().map((s) => this.view(s)),
    'mcp.save': async (input) => {
      const all = this.all()
      if (!input?.id && all.length >= MAX_SERVERS) throw new Error(`You can add up to ${MAX_SERVERS} tools.`)
      if (input?.id) this.find(input.id)
      const next = clean(input, all)
      this.store.setSetting(KEY, [...all.filter((s) => s.id !== next.id), next].sort((a, b) => a.name.localeCompare(b.name)))
      this.status.delete(next.id)
      // Not looked at here: the window stores the secret values first (it needs the id this gives), then asks for a test.
      return this.view(next)
    },
    'mcp.remove': (id) => {
      this.find(id)
      this.store.setSetting(KEY, this.all().filter((s) => s.id !== id))
      this.status.delete(id)
    },
    'mcp.setEnabled': (id, enabled) => {
      const server = this.find(id)
      const next = { ...server, enabled: enabled === true }
      this.store.setSetting(KEY, this.all().map((s) => (s.id === id ? next : s)))
      return this.view(next)
    },
    'mcp.test': (id) => this.test(id)
  }

  /** Looks at one server: connects, lists its tools, and remembers the answer. Two asks at once share one look. */
  test(id: string): Promise<McpStatus> {
    const running = this.running.get(id)
    if (running) return running
    const server = this.find(id)
    this.status.set(id, { state: 'checking' })
    this.changed()
    const job = (async (): Promise<McpStatus> => {
      let result: McpStatus
      try {
        const resolved = await this.resolve(server)
        result = { state: 'ok', tools: await probe(resolved, this.timeoutMs), at: Date.now() }
      } catch (err) {
        result = { state: 'failed', message: err instanceof Error ? err.message : String(err), at: Date.now() }
      }
      // It may have been removed or changed while it was being looked at.
      if (this.all().some((s) => s.id === id)) this.status.set(id, result)
      this.changed()
      return result
    })().finally(() => this.running.delete(id))
    this.running.set(id, job)
    return job
  }

  private async resolve(s: Stored): Promise<ResolvedMcpServer> {
    const read = async (kind: 'env' | 'header', names: string[]): Promise<Record<string, string>> => {
      const out: Record<string, string> = {}
      for (const name of names) {
        const value = await this.getSecret(mcpSecretName(s.id, kind, name)).catch(() => null)
        if (value) out[name] = value
      }
      return out
    }
    return {
      key: serverKey(s.name),
      type: s.type,
      ...(s.command ? { command: s.command } : {}),
      args: s.args ?? [],
      env: await read('env', s.envNames),
      ...(s.url ? { url: s.url } : {}),
      headers: await read('header', s.headerNames)
    }
  }

  /** The enabled servers, ready for a vendor. A session gets them when it starts; a change applies to sessions that start after it. */
  async resolved(): Promise<ResolvedMcpServer[]> {
    return Promise.all(this.all().filter((s) => s.enabled).map((s) => this.resolve(s)))
  }
}

/** Claude's form of a server. */
export function forClaude(s: ResolvedMcpServer): Record<string, unknown> {
  return s.type === 'stdio' ? { type: 'stdio', command: s.command, args: s.args, env: s.env } : { type: 'http', url: s.url, headers: s.headers }
}

/** Copilot's form of a server. Every tool the server offers is allowed in; what is asked first is decided by the approval mode. */
export function forCopilot(s: ResolvedMcpServer): Record<string, unknown> {
  return s.type === 'stdio' ? { type: 'stdio', command: s.command, args: s.args, env: s.env, tools: ['*'] } : { type: 'http', url: s.url, headers: s.headers, tools: ['*'] }
}
