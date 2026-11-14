import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo } from '@shared/agent'
import type { VendorConnection, VendorProgress } from '@shared/api'

/*
 * Google Gemini as a whole: who is signed in, which models there are, and how the Gemini CLI is started. The way in is a Gemini API
 * key from Google AI Studio, which has a free tier (small, Flash models) and paid plans, billed by Google to the person's own account.
 * Google ended the free "sign in with Google" of the Gemini CLI for personal accounts in June 2026, and its replacement (Antigravity)
 * is a separate program whose terms for other apps are not settled, so a key is the one way in for now.
 * The CLI runs with a settings folder of Celeste's own, so nothing touches the `gemini` the person uses in a terminal.
 */

export type Env = Record<string, string | undefined>

export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
export const PROGRAM_MISSING = 'Gemini’s program is not on this computer yet. Open Settings and choose Get a free key to download it.'
const PREFIX = 'gemini:'

/** The model Gemini picks for the task (the CLI chooses between a stronger and a faster one for each request). */
export const AUTO = 'auto'

/** One model as Gemini CLI lists it when a session opens. */
export interface AcpModel {
  modelId: string
  name?: string
  description?: string
}

/** "gemini-3.1-pro-preview" as "Gemini 3.1 Pro Preview". */
export function labelOf(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

export function toModels(models: AcpModel[]): ModelInfo[] {
  return models.map((m) => ({
    id: `${PREFIX}${m.modelId}`,
    vendor: 'gemini' as const,
    label: m.modelId === AUTO ? 'Auto' : labelOf(m.name ?? m.modelId),
    // Gemini CLI has no effort setting, so the slider is shown disabled.
    efforts: [],
    images: true
  }))
}

/** What the Gemini CLI is started with: the file, its arguments and its environment. */
export interface Launch {
  file: string
  args: string[]
  env: Env
}

export interface GeminiHostDeps {
  /** The CLI's file, when it is on this computer. Left out where there is nothing to look for. */
  program?: () => string | undefined
  /** Fetches the program. Left out where there is nowhere to keep one. */
  download?: (onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<string>
  /** The API key the person pasted, from the secret store. */
  getKey: () => Promise<string | null>
  /** Asks Google whether it accepts a key. `unknown` when it could not be reached, which is not the key's fault. */
  verifyKey?: (key: string, baseUrl: string) => Promise<'ok' | 'rejected' | 'unknown'>
  /** The CLI's own settings folder for Celeste. */
  geminiHome: string
  baseEnv: Env
  baseUrl?: string
  /** What runs the file: Electron's own Node, which is the program running Core. */
  node?: string
  /** Opens a session briefly, reads the models, and stops. Rejects when the CLI cannot start. */
  listModels: (launch: Launch) => Promise<AcpModel[]>
}

interface Fetching {
  abort: AbortController
  done: Promise<boolean>
  listeners: Set<(p: VendorProgress) => void>
  last: number
}

export class GeminiAuthError extends Error {}

/**
 * What Celeste keeps in the CLI's settings: no usage statistics sent to Google, no updating itself (Celeste pins the version it was
 * tried with), and few retries, so a wrong key or an empty quota is reported soon and not after minutes of waiting.
 * The CLI's own folder trust is off: it refuses its automatic approval modes in a folder it has not been told to trust, and Celeste's
 * approval modes are what decide, for a folder the person chose to open in Celeste.
 */
export function settingsFor(): Record<string, unknown> {
  return {
    privacy: { usageStatisticsEnabled: false },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false, maxAttempts: 3 },
    security: { folderTrust: { enabled: false } }
  }
}

export class GeminiHost {
  private cached: AcpModel[] = []
  private fetching: Fetching | undefined

  constructor(private readonly deps: GeminiHostDeps) {}

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

  /** Makes sure the program is on this computer, downloading it when it is not (progress goes to `on`). Resolves true when it is there. */
  async prepare(on: (p: VendorProgress) => void): Promise<boolean> {
    if (this.hasProgram()) return true
    if (!this.deps.download) {
      on({ state: 'failed', message: 'Gemini’s program is not installed.' })
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

  /** How the CLI is started for this account: its program run by Electron's own Node, the settings folder, and the key. */
  async launch(): Promise<Launch> {
    const entry = this.programPath()
    const key = await this.deps.getKey().catch(() => null)
    if (!key) throw new GeminiAuthError('You are not connected to Gemini. Open Settings and choose Get a free key.')
    mkdirSync(join(this.deps.geminiHome, '.gemini'), { recursive: true })
    writeFileSync(join(this.deps.geminiHome, '.gemini', 'settings.json'), JSON.stringify(settingsFor(), null, 2))
    const env: Env = {
      ...this.deps.baseEnv,
      // Core runs inside Electron, whose program is run as plain Node with this.
      ELECTRON_RUN_AS_NODE: '1',
      GEMINI_CLI_HOME: this.deps.geminiHome,
      GEMINI_API_KEY: key,
      // One process, so stopping it stops everything (the CLI otherwise starts itself again with more memory).
      GEMINI_CLI_NO_RELAUNCH: 'true',
      NO_COLOR: '1',
      ...(this.deps.baseUrl ? { GOOGLE_GEMINI_BASE_URL: this.deps.baseUrl } : {})
    }
    // What the person has set up for other tools must not change how this key is used: no Vertex AI, no sandbox, no other key.
    for (const name of ['GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'GEMINI_SANDBOX', 'GEMINI_MODEL']) delete env[name]
    return { file: this.deps.node ?? process.execPath, args: [entry, '--acp'], env }
  }

  async status(): Promise<VendorConnection> {
    if (!this.hasProgram()) return { state: 'runtime-missing' }
    const key = await this.deps.getKey().catch(() => null)
    if (!key) return { state: 'signed-out' }
    // A wrong key would otherwise only show on the first message.
    if ((await this.deps.verifyKey?.(key, this.baseUrl)) === 'rejected') return { state: 'unavailable', message: 'Google did not accept this API key.' }
    return { state: 'signed-in', account: `API key ending ${key.slice(-4)}` }
  }

  knownModels(): ModelInfo[] {
    return toModels(this.cached)
  }

  async models(): Promise<ModelInfo[]> {
    this.cached = await this.deps.listModels(await this.launch())
    return toModels(this.cached)
  }

  /** The model Gemini is given for the session's choice: its id, or `undefined` for a name that is not one of Gemini's. */
  resolve(model: string): string | undefined {
    return model.startsWith(PREFIX) ? model.slice(PREFIX.length) || undefined : undefined
  }

  async cancelSignIn(): Promise<void> {
    this.fetching?.abort.abort()
  }

  async stop(): Promise<void> {
    await this.cancelSignIn()
  }
}
