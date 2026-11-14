import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterContext } from '../types'
import type { ResolvedMcpServer } from '../../mcp'
import { RpcClient, spawnTransport, type RpcHandlers } from '../rpc'
import { GeminiHost, type AcpModel, type Env, type Launch } from './host'
import { GEMINI_VERSION, downloadGemini, findGemini } from './program'
import { GeminiAgentSession } from './session'

export { GeminiHost } from './host'
export { GEMINI_VERSION, downloadGemini, findGemini } from './program'

/** Asks Google for one model, which needs a valid key and nothing else. Never throws: not reaching Google says nothing about the key. */
async function verifyKey(key: string, base: string): Promise<'ok' | 'rejected' | 'unknown'> {
  try {
    const res = await fetch(`${base}/v1beta/models?pageSize=1`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(8000) })
    // Google answers 400 ("API key not valid") for a key it does not know, 403 for one that is turned off or may not be used here.
    if (res.status === 400 || res.status === 401 || res.status === 403) return 'rejected'
    return res.ok ? 'ok' : 'unknown'
  } catch {
    return 'unknown'
  }
}

const connect = (launch: Launch, handlers: RpcHandlers, options: { jsonrpc: boolean }): RpcClient => new RpcClient(spawnTransport(launch.file, launch.args, launch.env), handlers, options)

/** Opens a session with nothing to say, reads the models it offers, and stops. */
async function listModels(launch: Launch, cwd: string): Promise<AcpModel[]> {
  let died: Error | undefined
  const client = connect(
    launch,
    {
      notification: () => undefined,
      request: () => Promise.reject(new Error('Not handled.')),
      exit: (_code, stderr) => {
        died = new Error(`Gemini’s program stopped: ${stderr.trim().split('\n').pop() ?? 'no reason given'}`)
      }
    },
    { jsonrpc: true }
  )
  try {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60_000)
    await client.request('authenticate', { methodId: 'gemini-api-key' }, 30_000)
    const made = await client.request<{ models?: { availableModels?: AcpModel[] } }>('session/new', { cwd, mcpServers: [] }, 60_000)
    return made.models?.availableModels ?? []
  } catch (err) {
    throw died ?? err
  } finally {
    client.close()
  }
}

export interface GeminiOptions {
  /** Where Celeste keeps what it downloads, and the CLI's own settings folder. */
  dataDir: string
  getKey: () => Promise<string | null>
  /** An npm registry other than npmjs.org (a company mirror; a stand-in for the app checks). */
  registry?: string
}

export function createGeminiHost(options: GeminiOptions): GeminiHost {
  // Looked for each time, not once: the download can finish while Celeste is running.
  const program = () => findGemini({ dataDir: options.dataDir, ...(process.env['CELESTE_GEMINI_PROGRAM'] ? { override: process.env['CELESTE_GEMINI_PROGRAM'] } : {}) })
  // For app checks, which run a stand-in for Google's API.
  const baseUrl = process.env['CELESTE_GEMINI_BASE_URL']
  const geminiHome = join(options.dataDir, 'gemini-home')
  mkdirSync(geminiHome, { recursive: true })
  return new GeminiHost({
    program,
    download: (onProgress, signal) => downloadGemini({ dataDir: options.dataDir, onProgress, signal, ...(options.registry ? { registry: options.registry } : {}) }),
    getKey: options.getKey,
    verifyKey,
    geminiHome,
    baseEnv: process.env as Env,
    ...(baseUrl ? { baseUrl } : {}),
    listModels: (launch) => {
      const probe = join(geminiHome, 'probe')
      mkdirSync(probe, { recursive: true })
      return listModels(launch, probe)
    }
  })
}

export function createGeminiSession(
  host: GeminiHost,
  ctx: AdapterContext,
  deviceServer?: (sessionId: string) => { url: string; token: string } | undefined,
  mcpServers?: () => Promise<ResolvedMcpServer[]>,
  version?: string
): GeminiAgentSession {
  return new GeminiAgentSession({
    ctx,
    launch: () => host.launch(),
    connect,
    resolveModel: (model) => host.resolve(model),
    ...(deviceServer ? { deviceServer: () => deviceServer(ctx.sessionId) } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(version ? { version } : {})
  })
}
