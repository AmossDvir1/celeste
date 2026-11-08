// Rules and helpers for the list of MCP servers (the outside tools an agent can use), shared by the window and Core.
// MCP, the Model Context Protocol, is the standard way an agent is given tools. Celeste keeps one list and gives it to
// whichever vendor runs the session.

/** Celeste's own tool server goes by this name in every vendor's list, so no server of the person's may. */
export const RESERVED_NAMES = ['celeste-devices']

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/
export const HEADER_NAME = /^[A-Za-z0-9-]{1,36}$/
export const MAX_SERVERS = 30
export const MAX_ARGS = 50
export const MAX_PAIRS = 30

/** The name of the secret that holds one value of one server. The main process's list of names it hands to Core allows these. */
export const mcpSecretName = (id: string, kind: 'env' | 'header', name: string): string => `mcp.${id}.${kind}.${name}`

/** The name a vendor knows the server by: lower case letters, numbers and dashes, since it ends up inside tool names. */
export function serverKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Splits a command line into words, keeping what is inside quotes together. */
export function splitArgs(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) words.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started || current) words.push(current)
  return words
}

/** The opposite: arguments as one line to edit, with quotes where a word has spaces. */
export function joinArgs(args: string[]): string {
  return args.map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, "'")}"` : a)).join(' ')
}

/** One server read from a pasted configuration, with its secret values still in it. */
export interface ParsedServer {
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  env: Record<string, string>
  headers: Record<string, string>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): Record<string, string> =>
  isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, value]) => typeof value === 'string') as [string, string][]) : {}

/**
 * Reads the configuration other tools share (the `mcpServers` of a `.mcp.json` or of Claude Desktop's settings), or one
 * server on its own. Servers it cannot use are named in `skipped` with the reason, not silently dropped.
 */
export function parseMcpJson(text: string): { servers: ParsedServer[]; skipped: string[] } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('That is not valid JSON.')
  }
  if (!isRecord(data)) throw new Error('Expected a JSON object with the servers in it.')
  const table = isRecord(data['mcpServers']) ? data['mcpServers'] : 'command' in data || 'url' in data ? { server: data } : data
  const servers: ParsedServer[] = []
  const skipped: string[] = []
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) {
      skipped.push(`${name}: not a server`)
      continue
    }
    if (typeof raw['command'] === 'string' && raw['command'].trim()) {
      const args = Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : []
      servers.push({ name, type: 'stdio', command: raw['command'].trim(), args, env: strings(raw['env']), headers: {} })
    } else if (typeof raw['url'] === 'string' && /^https?:\/\//i.test(raw['url'])) {
      servers.push({ name, type: 'http', url: raw['url'], env: {}, headers: strings(raw['headers']) })
    } else {
      skipped.push(`${name}: needs a command or a web address`)
    }
  }
  if (servers.length === 0 && skipped.length === 0) throw new Error('No servers were found in that.')
  return { servers, skipped }
}
