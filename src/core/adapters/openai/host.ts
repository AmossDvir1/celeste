import type { Effort, ModelInfo } from '@shared/agent'
import type { VendorConnection, VendorProgress } from '@shared/api'
import { AuthError, ChatgptAuth, type SignInHandle } from './auth'

/*
 * OpenAI as a whole: who is signed in, which models there are, and how Codex is started. Two ways in, both billed by OpenAI:
 *  - "Continue with ChatGPT": the person's own plan, through OpenAI's route for open-source local apps (./auth.ts).
 *  - A pasted OpenAI API key, billed to the person's API account.
 * Either way Codex is run with Celeste's own settings folder, so nothing touches the `codex` the person uses in a terminal, and is
 * told to send its requests to OpenAI's Responses API with the credential from an environment variable. It never signs in itself.
 */

export type Env = Record<string, string | undefined>

/** The name of the variable that carries the credential to Codex. */
export const TOKEN_VAR = 'CELESTE_OPENAI_TOKEN'
const PROVIDER = 'celeste_openai'
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const PROGRAM_MISSING = 'OpenAI’s program is not on this computer yet. Open Settings and choose Connect to download it.'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const PREFIX = 'openai:'

/** One model as Codex lists it. */
export interface CodexModel {
  id: string
  model: string
  displayName: string
  hidden: boolean
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts: { reasoningEffort: string }[]
  inputModalities?: string[]
}

export function toModels(models: CodexModel[]): ModelInfo[] {
  return models
    .filter((m) => !m.hidden)
    .map((m) => {
      const efforts = m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter((e): e is Effort => (EFFORTS as string[]).includes(e))
      const def = m.defaultReasoningEffort
      return {
        id: `${PREFIX}${m.model}`,
        vendor: 'openai' as const,
        label: m.displayName || m.model,
        efforts,
        ...(def && (EFFORTS as string[]).includes(def) ? { defaultEffort: def as Effort } : {}),
        images: (m.inputModalities ?? ['text', 'image']).includes('image')
      }
    })
}

/** What Codex is started with: the file, its arguments and its environment. */
export interface Launch {
  file: string
  args: string[]
  env: Env
  /** Which credential it carries. */
  via: 'plan' | 'key'
}

export interface OpenAiHostDeps {
  /** Codex's program, when it is on this computer. Left out where there is nothing to look for. */
  program?: () => string | undefined
  /** Fetches the program. Left out where there is nowhere to keep one. */
  download?: (onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<string>
  auth: ChatgptAuth
  /** The API key the person pasted, from the secret store. */
  getKey: () => Promise<string | null>
  /** Asks OpenAI whether it accepts a key. `unknown` when it could not be reached, which is not the key's fault. */
  verifyKey?: (key: string, baseUrl: string) => Promise<'ok' | 'rejected' | 'unknown'>
  /** Codex's own settings folder for Celeste. */
  codexHome: string
  baseEnv: Env
  baseUrl?: string
  /** Starts the program briefly, asks it for its model list, and stops it. Rejects when it cannot start. */
  listModels: (launch: Launch) => Promise<CodexModel[]>
}

interface Fetching {
  abort: AbortController
  done: Promise<boolean>
  listeners: Set<(p: VendorProgress) => void>
  last: number
}

export class OpenAiHost {
  private cached: CodexModel[] = []
  private login: { handle: SignInHandle; cancelled: boolean } | undefined
  private fetching: Fetching | undefined

  constructor(private readonly deps: OpenAiHostDeps) {}

  get baseUrl(): string {
    return (this.deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  hasProgram(): boolean {
    return !this.deps.program || this.deps.program() !== undefined
  }

  /** The program to start. Throws a message fit to show when it has not been downloaded. */
  programPath(): string {
    const file = this.deps.program?.()
    if (!file) throw new Error(PROGRAM_MISSING)
    return file
  }

  // --- the program ------------------------------------------------------------------------------------

  /** Makes sure the program is on this computer, downloading it when it is not (progress goes to `on`). Resolves true when it is there. */
  async prepare(on: (p: VendorProgress) => void): Promise<boolean> {
    if (this.hasProgram()) return true
    if (!this.deps.download) {
      on({ state: 'failed', message: 'OpenAI’s program is not installed.' })
      return false
    }
    if (this.fetching) {
      this.fetching.listeners.add(on)
      on({ state: 'downloading', progress: this.fetching.last })
      return this.fetching.done
    }
    const download = this.deps.download
    const abort = new AbortController()
    const listeners = new Set([on])
    const say = (p: VendorProgress) => listeners.forEach((l) => l(p))
    const job: Fetching = { abort, listeners, last: 0, done: Promise.resolve(false) }
    job.done = (async () => {
      say({ state: 'downloading', progress: 0 })
      try {
        await download((progress) => {
          job.last = progress
          say({ state: 'downloading', progress })
        }, abort.signal)
        return !abort.signal.aborted
      } catch (err) {
        if (!abort.signal.aborted) say({ state: 'failed', message: err instanceof Error ? err.message : String(err) })
        return false
      } finally {
        if (this.fetching === job) this.fetching = undefined
      }
    })()
    this.fetching = job
    return job.done
  }

  // --- credentials ------------------------------------------------------------------------------------

  /** The credential Codex is given, renewed first when it is about to end. Rejects with a message fit to show. */
  async credential(): Promise<{ token: string; via: 'plan' | 'key' }> {
    if (await this.deps.auth.record()) return { token: await this.deps.auth.accessToken(), via: 'plan' }
    const key = await this.deps.getKey().catch(() => null)
    if (key) return { token: key, via: 'key' }
    throw new AuthError('You are not signed in to OpenAI. Open Settings and choose Connect.', true)
  }

  /** How Codex is started for this account: the program, the settings that point it at OpenAI, and the credential. */
  async launch(extraConfig: string[] = []): Promise<Launch> {
    const file = this.programPath()
    const { token, via } = await this.credential()
    const p = `model_providers.${PROVIDER}`
    const config = [
      `model_provider=${toml(PROVIDER)}`,
      `${p}.name=${toml('OpenAI')}`,
      `${p}.base_url=${toml(this.baseUrl)}`,
      `${p}.env_key=${toml(TOKEN_VAR)}`,
      `${p}.wire_api="responses"`,
      // Codex asks for sign-in itself unless told the provider takes the bearer token from the variable.
      `${p}.requires_openai_auth=false`,
      // OpenAI's route for plan usage answers over HTTP only.
      `${p}.supports_websockets=false`,
      ...extraConfig
    ]
    const env: Env = { ...this.deps.baseEnv, CODEX_HOME: this.deps.codexHome, [TOKEN_VAR]: token }
    // A key in the person's own environment must not be used for a session they signed in for.
    delete env['OPENAI_API_KEY']
    delete env['CODEX_API_KEY']
    return { file, args: ['app-server', '--listen', 'stdio://', ...config.flatMap((c) => ['-c', c])], env, via }
  }

  async status(): Promise<VendorConnection> {
    if (!this.hasProgram()) return { state: 'runtime-missing' }
    const record = await this.deps.auth.record()
    if (record) {
      // A sign-in that has gone bad (revoked in ChatGPT's settings, say) is found out here, so the card does not claim to be connected.
      try {
        if ((await this.deps.auth.remaining()) < 0) await this.deps.auth.refresh(record)
      } catch (err) {
        if (err instanceof AuthError && err.reauthenticate) return { state: 'signed-out' }
        return { state: 'unavailable', message: err instanceof Error ? err.message : String(err) }
      }
      return { state: 'signed-in', account: `ChatGPT · ${record.email ?? 'your plan'}` }
    }
    const key = await this.deps.getKey().catch(() => null)
    if (!key) return { state: 'signed-out' }
    // A wrong key would otherwise only show on the first message.
    if ((await this.deps.verifyKey?.(key, this.baseUrl)) === 'rejected') return { state: 'unavailable', message: 'OpenAI did not accept this API key.' }
    return { state: 'signed-in', account: `API key ending ${key.slice(-4)}` }
  }

  // --- models -----------------------------------------------------------------------------------------

  knownModels(): ModelInfo[] {
    return toModels(this.cached)
  }

  async models(): Promise<ModelInfo[]> {
    this.cached = await this.deps.listModels(await this.launch())
    return toModels(this.cached)
  }

  /** The model Codex is given for the session's choice, and the effort when that model takes one. */
  resolve(model: string, effort: Effort | null): { model?: string; effort?: Effort } {
    const name = model.startsWith(PREFIX) ? model.slice(PREFIX.length) : undefined
    const known = this.cached.find((m) => m.model === name)
    const takes = effort && known?.supportedReasoningEfforts.some((e) => e.reasoningEffort === effort)
    return { ...(name ? { model: name } : {}), ...(takes ? { effort } : {}) }
  }

  // --- signing in -------------------------------------------------------------------------------------

  /** "Continue with ChatGPT": the program first (so models can be read afterwards), then the browser. Progress goes to `on`. */
  async signIn(on: (p: VendorProgress) => void): Promise<void> {
    if (this.login) throw new Error('Signing in is already under way.')
    if (!(await this.prepare(on))) return
    const current = await this.status()
    if (current.state === 'signed-in') return on({ state: 'done', account: current.account })
    let handle: SignInHandle
    try {
      handle = await this.deps.auth.begin()
    } catch (err) {
      return on({ state: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
    const login = { handle, cancelled: false }
    this.login = login
    on({ state: 'step', step: { kind: 'open-url', url: handle.url } })
    try {
      await handle.done
      if (login.cancelled) return
      const s = await this.status()
      if (s.state === 'signed-in') on({ state: 'done', account: s.account })
      else on({ state: 'failed', message: s.state === 'unavailable' ? s.message : 'Signed in, but OpenAI did not report an account Celeste can use.' })
    } catch (err) {
      if (!login.cancelled) on({ state: 'failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (this.login === login) this.login = undefined
    }
  }

  async cancelSignIn(): Promise<void> {
    this.fetching?.abort.abort()
    const login = this.login
    if (!login) return
    login.cancelled = true
    this.login = undefined
    login.handle.cancel()
  }

  /** Signs out of ChatGPT. A pasted key is removed by the window, which holds the secret store's controls. */
  async signOut(): Promise<{ revoked: boolean }> {
    return this.deps.auth.signOut()
  }

  async stop(): Promise<void> {
    await this.cancelSignIn()
  }
}

/** A string as a TOML value. JSON's escapes are TOML's for everything a path, a URL or a name can hold. */
export const toml = (value: string): string => JSON.stringify(value)
