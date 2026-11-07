import type { Effort, ModelInfo } from '@shared/agent'
import type { VendorConnection, VendorProgress } from '@shared/api'

/*
 * Claude as a whole: who is signed in, which models there are, and signing in. Celeste gives Claude Code its own
 * settings folder, so signing in here never signs anyone out of the `claude` they use in a terminal, and an API key
 * the person pasted is handed to it through its environment. A Claude subscription login is not offered: Anthropic
 * does not let other apps sign people in with one, so it is accepted only when development turns it on.
 */

export type Env = Record<string, string | undefined>

/** What Claude Code reports about the account it would use, with no message sent. */
export interface Account {
  tokenSource?: string
  apiKeySource?: string
  subscriptionType?: string
  email?: string
  organization?: string
}

export interface SdkModel {
  value: string
  displayName: string
  supportedEffortLevels?: Effort[]
}

export interface Probe {
  account: Account
  models: SdkModel[]
}

/** `claude auth login`, running. */
export interface LoginProcess {
  onExit(callback: (code: number | null) => void): void
  kill(): void
}

export interface ClaudeHostDeps {
  /** Starts Claude Code briefly, reads who it would be and which models it has, and stops it. Rejects when it cannot start. */
  probe: (env: Env) => Promise<Probe>
  /** The API key the person pasted, from the secret store. */
  getKey: () => Promise<string | null>
  baseEnv: Env
  /** Asks Anthropic whether it accepts a key. `unknown` when it could not be reached, which is not the key's fault. */
  verifyKey?: (key: string, env: Env) => Promise<'ok' | 'rejected' | 'unknown'>
  /** Claude Code's own settings folder for Celeste. Absent when development uses the person's own. */
  configDir?: string
  /** Development only: accept a Claude subscription login. */
  allowSubscription?: boolean
  startLogin: (env: Env) => LoginProcess
}

const PREFIX = 'claude:'
const LOGIN_LIMIT_MS = 10 * 60_000

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** A model name saved before Claude was real (`claude-sonnet`, `claude-opus`) stands for the same family now. */
function legacy(model: string): string {
  if (/opus/i.test(model)) return 'opus'
  if (/haiku/i.test(model)) return 'haiku'
  if (/sonnet/i.test(model)) return 'sonnet'
  return 'default'
}

export function toModels(models: SdkModel[]): ModelInfo[] {
  return models.map((m) => ({
    id: `${PREFIX}${m.value}`,
    vendor: 'claude' as const,
    label: m.displayName.replace(/\s*\(recommended\)\s*$/i, ''),
    efforts: (m.supportedEffortLevels ?? []).filter((e) => EFFORTS.includes(e)),
    images: true
  }))
}

export class ClaudeHost {
  private cached: SdkModel[] = []
  private login: { proc: LoginProcess; timer: ReturnType<typeof setTimeout>; cancelled: boolean } | undefined

  constructor(private readonly deps: ClaudeHostDeps) {}

  /** The environment Claude Code runs in: its settings folder, and the pasted key if there is one. */
  async env(): Promise<Env> {
    const key = await this.deps.getKey().catch(() => null)
    return {
      ...this.deps.baseEnv,
      ...(this.deps.configDir ? { CLAUDE_CONFIG_DIR: this.deps.configDir } : {}),
      // An empty key keeps a key in the person's own environment from being used for a session they signed in for.
      ANTHROPIC_API_KEY: key ?? '',
      // Claude Code retries a failed request ten times with growing waits, so a wrong key looks like a hang for minutes.
      CLAUDE_CODE_MAX_RETRIES: this.deps.baseEnv['CLAUDE_CODE_MAX_RETRIES'] ?? '3',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'celeste'
    }
  }

  async status(): Promise<VendorConnection> {
    let probe: Probe
    try {
      probe = await this.deps.probe(await this.env())
    } catch (err) {
      return { state: 'unavailable', message: err instanceof Error ? err.message : String(err) }
    }
    this.cached = probe.models
    const key = await this.deps.getKey().catch(() => null)
    const a = probe.account
    if (key) {
      // A wrong key would otherwise only show on the first message, after a long wait.
      if ((await this.deps.verifyKey?.(key, await this.env())) === 'rejected') return { state: 'unavailable', message: 'Anthropic did not accept this API key.' }
      return { state: 'signed-in', account: `API key ending ${key.slice(-4)}` }
    }
    if (a.apiKeySource && a.apiKeySource !== 'none') return { state: 'signed-in', account: 'API key' }
    if (!a.tokenSource || a.tokenSource === 'none') return { state: 'signed-out' }
    if (a.subscriptionType) {
      return this.deps.allowSubscription ? { state: 'signed-in', account: `Claude ${a.subscriptionType} (development)` } : { state: 'signed-out' }
    }
    return { state: 'signed-in', account: `Console · ${a.organization ?? a.email ?? 'Anthropic'}` }
  }

  async models(): Promise<ModelInfo[]> {
    const probe = await this.deps.probe(await this.env())
    this.cached = probe.models
    return toModels(probe.models)
  }

  /** The model Claude Code is given for the session's choice, and the effort when that model takes one. */
  resolve(model: string, effort: Effort | null): { model?: string; effort?: Effort } {
    const value = model.startsWith(PREFIX) ? model.slice(PREFIX.length) : legacy(model)
    const known = this.cached.find((m) => m.value === value)
    const takes = effort && (known?.supportedEffortLevels ?? []).includes(effort)
    return { ...(value === 'default' ? {} : { model: value }), ...(takes ? { effort } : {}) }
  }

  // --- signing in -------------------------------------------------------------------------------------

  /**
   * Console sign-in: Claude Code opens the browser itself and finishes when the person does. Progress goes to `on`, and the
   * result is read from Claude Code afterwards, not taken from the process's word.
   */
  async signIn(on: (p: VendorProgress) => void): Promise<void> {
    if (this.login) throw new Error('Signing in is already under way.')
    // Someone already signed in here has nothing to do: the card just connects.
    const current = await this.status()
    if (current.state === 'signed-in') return on({ state: 'done', account: current.account })
    if (current.state === 'unavailable') return on({ state: 'failed', message: current.message })
    const proc = this.deps.startLogin(await this.env())
    const login = { proc, cancelled: false, timer: setTimeout(() => this.finish(login, () => on({ state: 'failed', message: 'Signing in took too long. Try again.' })), LOGIN_LIMIT_MS) }
    this.login = login
    proc.onExit((code) => {
      this.finish(login, () => {
        void this.report(code, on)
      })
    })
  }

  private finish(login: NonNullable<ClaudeHost['login']>, then: () => void): void {
    clearTimeout(login.timer)
    if (this.login !== login) return
    this.login = undefined
    if (!login.cancelled) then()
    login.proc.kill()
  }

  private async report(code: number | null, on: (p: VendorProgress) => void): Promise<void> {
    if (code !== 0) return on({ state: 'failed', message: 'Signing in was not completed.' })
    const s = await this.status()
    if (s.state === 'signed-in') on({ state: 'done', account: s.account })
    else if (s.state === 'unavailable') on({ state: 'failed', message: s.message })
    else on({ state: 'failed', message: 'Signed in, but Claude did not report an account Celeste can use. A Claude subscription cannot be used here: choose Console, or paste an API key.' })
  }

  async cancelSignIn(): Promise<void> {
    const login = this.login
    if (!login) return
    login.cancelled = true
    this.finish(login, () => undefined)
  }

  async stop(): Promise<void> {
    await this.cancelSignIn()
  }
}
