import { spawn } from 'node:child_process'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AdapterContext } from '../types'
import { ClaudeHost, type Env, type Probe } from './host'
import { cheapest, titlePrompt, TITLE_SYSTEM } from '../../titles'
import { downloadClaudeProgram, findProgram } from './program'
import { ClaudeAgentSession, type ClaudeQuery, type StartQuery } from './session'

export { ClaudeHost } from './host'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')
let sdk: Promise<Sdk> | undefined
/** The SDK is a module that only loads with `import`, and only when Claude is first used. */
const loadSdk = (): Promise<Sdk> => (sdk ??= import('@anthropic-ai/claude-agent-sdk'))

export { PROGRAM_VERSION, downloadClaudeProgram, findProgram, programPlatform } from './program'

/** Claude Code's program: the one that came beside the SDK (development), found by the platform package's name. */
export function claudeProgram(resolvePaths: string[] = []): string | undefined {
  return findProgram({ installedAt: resolvePaths })
}

/** Reads who Claude Code would be and which models it has, by starting it with nothing to say and stopping it. */
async function probe(env: Env, executable: string | undefined): Promise<Probe> {
  if (!executable) throw new Error('Claude’s program is not installed.')
  const { query } = await loadSdk()
  const never = new Promise<never>(() => undefined)
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await never
  }
  const q = query({ prompt: idle(), options: { settingSources: [], persistSession: false, env, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) } })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude did not start in time.')), 45_000)
      })
    ])
    const account = (init.account ?? {}) as Record<string, unknown>
    const text = (k: string) => (typeof account[k] === 'string' ? (account[k] as string) : undefined)
    return {
      account: {
        tokenSource: text('tokenSource'),
        apiKeySource: text('apiKeySource'),
        subscriptionType: text('subscriptionType'),
        email: text('email'),
        organization: text('organization')
      },
      models: (init.models ?? []).map((m) => ({ value: m.value, displayName: m.displayName, supportedEffortLevels: m.supportedEffortLevels }))
    }
  } finally {
    clearTimeout(timer)
    q.close()
  }
}

/** Asks the API for one model, which needs a valid key and nothing else. Never throws: not reaching Anthropic says nothing about the key. */
async function verifyKey(key: string, env: Env): Promise<'ok' | 'rejected' | 'unknown'> {
  try {
    const base = (env['ANTHROPIC_BASE_URL'] || 'https://api.anthropic.com').replace(/\/+$/, '')
    const res = await fetch(`${base}/v1/models?limit=1`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000)
    })
    if (res.status === 401 || res.status === 403) return 'rejected'
    return res.ok ? 'ok' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface ClaudeOptions {
  /** Where the program was found beside the SDK, as `require.resolve.paths` gives them. */
  installedAt?: string[]
  /** Where Celeste keeps what it downloads. Without it the program is only looked for beside the SDK. */
  dataDir?: string
  /** An npm registry other than npmjs.org (a company mirror, or a stand-in for a check). */
  registry?: string
  getKey: () => Promise<string | null>
  /** Claude Code's own settings folder for Celeste. Left out to use the person's own, for development. */
  configDir?: string
  allowSubscription?: boolean
}

export function createClaudeHost(options: ClaudeOptions): ClaudeHost {
  // Looked for each time, not once: the download can finish while Celeste is running.
  const program = () => findProgram({ installedAt: options.installedAt, dataDir: options.dataDir })
  const host = new ClaudeHost({
    program,
    ...(options.dataDir ? { download: (onProgress, signal) => downloadClaudeProgram({ dataDir: options.dataDir as string, onProgress, signal, ...(options.registry ? { registry: options.registry } : {}) }) } : {}),
    probe: (env) => probe(env, program()),
    getKey: options.getKey,
    verifyKey,
    baseEnv: process.env,
    configDir: options.configDir,
    allowSubscription: options.allowSubscription,
    startLogin: (env) => {
      const file = program()
      if (!file) throw new Error('Claude’s program is not installed.')
      const child = spawn(file, ['auth', 'login', '--console'], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      return {
        onExit: (cb) => {
          child.once('exit', cb)
          child.once('error', () => cb(null))
        },
        kill: () => {
          if (!child.killed && child.exitCode === null) child.kill()
        }
      }
    }
  })
  return host
}

/**
 * Asks Claude's smallest model for a title, once: no tools, Celeste's own two-line instructions in place of Claude Code's long
 * ones, nothing saved as a session. Gives up quietly (undefined) when Claude is not ready, has no small model, or does not
 * answer within half a minute.
 */
export function createClaudeTitler(host: ClaudeHost): (text: string) => Promise<string | undefined> {
  return async (text) => {
    try {
      if (!host.hasProgram()) return undefined
      const models = host.knownModels().length ? host.knownModels() : await host.models()
      const small = cheapest(models)
      if (!small) return undefined
      const { query } = await loadSdk()
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 30_000)
      const executable = host.programPath()
      try {
        const q = query({
          prompt: titlePrompt(text),
          options: {
            model: small.id.replace(/^claude:/, ''),
            maxTurns: 1,
            tools: [],
            systemPrompt: TITLE_SYSTEM,
            persistSession: false,
            settingSources: [],
            env: await host.env(),
            abortController: abort,
            ...(executable ? { pathToClaudeCodeExecutable: executable } : {})
          }
        })
        for await (const message of q) {
          const m = message as unknown as { type?: string; subtype?: string; is_error?: boolean; result?: string }
          if (m.type === 'result') return m.subtype === 'success' && !m.is_error ? m.result : undefined
        }
        return undefined
      } finally {
        clearTimeout(timer)
        abort.abort()
      }
    } catch {
      return undefined
    }
  }
}

export function createClaudeSession(
  host: ClaudeHost,
  ctx: AdapterContext,
  deviceServer?: (sessionId: string) => { url: string; token: string } | undefined
): ClaudeAgentSession {
  const start: StartQuery = ({ prompt, options }) => {
    // The SDK loads on first use, so the query is created once it has: this wrapper hands the messages through.
    const ready = loadSdk().then(({ query }) => query({ prompt, options }) as unknown as ClaudeQuery)
    return {
      [Symbol.asyncIterator]: () => {
        let it: AsyncIterator<unknown> | undefined
        return {
          next: async () => {
            it ??= (await ready)[Symbol.asyncIterator]()
            return it.next() as never
          }
        }
      },
      interrupt: async () => (await ready).interrupt(),
      setModel: async (m) => (await ready).setModel(m),
      applyFlagSettings: async (s) => (await ready).applyFlagSettings(s),
      close: () => void ready.then((q) => q.close(), () => undefined)
    }
  }
  return new ClaudeAgentSession({
    ctx,
    start,
    launch: async () => {
      const executable = host.programPath()
      return { env: await host.env(), ...(executable ? { executable } : {}) }
    },
    resolveModel: (model, effort) => host.resolve(model, effort),
    ...(deviceServer ? { deviceServer: () => deviceServer(ctx.sessionId) } : {})
  })
}

