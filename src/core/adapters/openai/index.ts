import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterContext } from '../types'
import type { ResolvedMcpServer } from '../../mcp'
import { ChatgptAuth, newHostId } from './auth'
import { OpenAiHost, type CodexModel, type Env, type Launch } from './host'
import { CODEX_VERSION, downloadCodex, findCodex } from './program'
import { RpcClient, spawnTransport, type RpcHandlers } from '../rpc'
import { OpenAiAgentSession } from './session'

export { OpenAiHost } from './host'
export { CODEX_VERSION, codexPlatform, downloadCodex, findCodex } from './program'

/** An id for this computer that OpenAI accepts and that holds nothing about the person. Made on first use and kept in the data folder. */
export function hostIdIn(dataDir: string): string {
  const file = join(dataDir, 'openai-host-id')
  try {
    const kept = readFileSync(file, 'utf8').trim()
    if (/^urn:uuid:[0-9a-f-]{36}$/.test(kept)) return kept
  } catch {
    /* none yet */
  }
  const made = newHostId()
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, `${made}\n`, { mode: 0o600 })
  return made
}

/** Asks OpenAI for one page of models, which needs a valid key and nothing else. Never throws: not reaching OpenAI says nothing about the key. */
async function verifyKey(key: string, base: string): Promise<'ok' | 'rejected' | 'unknown'> {
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
    if (res.status === 401 || res.status === 403) return 'rejected'
    return res.ok ? 'ok' : 'unknown'
  } catch {
    return 'unknown'
  }
}

const connect = (launch: Launch, handlers: RpcHandlers): RpcClient => new RpcClient(spawnTransport(launch.file, launch.args, launch.env), handlers)

/** Starts Codex with nothing to say, reads its model list, and stops it. */
async function listCatalog(launch: Launch): Promise<CodexModel[]> {
  let died: Error | undefined
  const client = connect(launch, {
    notification: () => undefined,
    request: () => Promise.reject(new Error('Not handled.')),
    exit: (_code, stderr) => {
      died = new Error(`OpenAI’s program stopped: ${stderr.trim().split('\n').pop() ?? 'no reason given'}`)
    }
  })
  try {
    await client.request('initialize', { clientInfo: { name: 'celeste', title: 'Celeste', version: '0.0.0' }, capabilities: null }, 45_000)
    client.notify('initialized')
    const all: CodexModel[] = []
    let cursor: string | null | undefined
    do {
      const page = await client.request<{ data: CodexModel[]; nextCursor: string | null }>('model/list', cursor ? { cursor } : {}, 30_000)
      all.push(...page.data)
      cursor = page.nextCursor
    } while (cursor && all.length < 500)
    return all
  } catch (err) {
    throw died ?? err
  } finally {
    client.close()
  }
}

/**
 * On a ChatGPT plan, OpenAI says which models the account may use (Codex's own list is a bundled catalog, not an entitlement check).
 * This keeps that list's order and takes each model's effort settings from Codex's catalog. Falls back to the catalog.
 */
async function planModels(catalog: CodexModel[], launch: Launch, base: string): Promise<CodexModel[]> {
  try {
    const token = launch.env['CELESTE_OPENAI_TOKEN']
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return catalog
    const body = (await res.json()) as { models?: { slug?: string; display_name?: string; visibility?: string }[] }
    const listed = (body.models ?? []).filter((m) => m.visibility === 'list' && m.slug)
    if (!listed.length) return catalog
    return listed.map((m) => {
      const known = catalog.find((c) => c.model === m.slug)
      return known ?? { id: m.slug as string, model: m.slug as string, displayName: m.display_name ?? (m.slug as string), hidden: false, supportedReasoningEfforts: [] }
    })
  } catch {
    return catalog
  }
}

export interface OpenAiOptions {
  /** Where Celeste keeps what it downloads, and Codex's own settings folder. */
  dataDir: string
  /** The person's own sign-in: kept in the secret store of the main process, as one piece of text. */
  tokens: { get: () => Promise<string | null>; set: (value: string) => Promise<boolean>; remove: () => Promise<void> }
  getKey: () => Promise<string | null>
  /** An npm registry other than npmjs.org (a company mirror; a stand-in for the app checks). */
  registry?: string
}

export function createOpenAiHost(options: OpenAiOptions): OpenAiHost {
  // Looked for each time, not once: the download can finish while Celeste is running.
  const program = () => findCodex({ dataDir: options.dataDir, ...(process.env['CELESTE_CODEX_PROGRAM'] ? { override: process.env['CELESTE_CODEX_PROGRAM'] } : {}) })
  // For app checks, which run stand-ins for OpenAI's API and sign-in service.
  const baseUrl = process.env['CELESTE_OPENAI_BASE_URL']
  const issuer = process.env['CELESTE_OPENAI_ISSUER']
  const auth = new ChatgptAuth({
    store: options.tokens,
    hostId: () => hostIdIn(options.dataDir),
    ...(issuer ? { issuer } : {}),
    ...(baseUrl ? { resource: baseUrl } : {})
  })
  const codexHome = join(options.dataDir, 'codex-home')
  if (!existsSync(codexHome)) mkdirSync(codexHome, { recursive: true })
  const host: OpenAiHost = new OpenAiHost({
    program,
    download: (onProgress, signal) => downloadCodex({ dataDir: options.dataDir, onProgress, signal, ...(options.registry ? { registry: options.registry } : {}) }),
    auth,
    getKey: options.getKey,
    verifyKey,
    codexHome,
    baseEnv: process.env as Env,
    ...(baseUrl ? { baseUrl } : {}),
    listModels: async (launch) => {
      const catalog = await listCatalog(launch)
      return launch.via === 'plan' ? planModels(catalog, launch, host.baseUrl) : catalog
    }
  })
  return host
}

export function createOpenAiSession(
  host: OpenAiHost,
  ctx: AdapterContext,
  deviceServer?: (sessionId: string) => { url: string; token: string } | undefined,
  mcpServers?: () => Promise<ResolvedMcpServer[]>,
  version?: string
): OpenAiAgentSession {
  return new OpenAiAgentSession({
    ctx,
    launch: (extra) => host.launch(extra),
    connect,
    resolveModel: (model, effort) => host.resolve(model, effort),
    currentToken: async () => (await host.credential()).token,
    ...(deviceServer ? { deviceServer: () => deviceServer(ctx.sessionId) } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(version ? { version } : {})
  })
}

export { CODEX_VERSION as OPENAI_PROGRAM_VERSION }
