import type { Effort, ModelInfo } from '@shared/agent'
import type { SignInStep, VendorConnection, VendorProgress } from '@shared/api'
import type { SdkClient, SdkSession } from './session'

/** The sign-in calls of a Copilot session. The SDK's own types are much wider; this is what is used. */
type LoginStep =
  | { kind: 'open-url'; url: string }
  | { kind: 'device-code'; userCode: string; verificationUri: string; expiresIn: number; interval: number }
  | { kind: 'awaiting' }
  | { kind: 'needs-interaction' }
  | { kind: 'input-required'; prompt: string }
  | { kind: 'completed'; result: { status: string; login?: string; host?: string } }
  | { kind: 'error'; message: string }

export interface LoginSession extends SdkSession {
  rpc: {
    accounts: {
      login: {
        begin(params: { kind: 'githubDotCom'; method: 'web' | 'device-code' }): Promise<{ flowId: string; step: LoginStep }>
        advance(params: { flowId: string; input?: string }): Promise<LoginStep>
        cancel(params: { flowId: string }): Promise<void>
      }
    }
  }
}

/** The part of the SDK's client that the host uses, so tests do not start a runtime. */
export interface SdkClientHandle extends SdkClient {
  start(): Promise<void>
  stop(): Promise<unknown>
  ping(message?: string): Promise<unknown>
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string; host?: string }>
  listModels(): Promise<
    {
      id: string
      name: string
      capabilities?: { supports?: { vision?: boolean; reasoningEffort?: boolean } }
      policy?: { state?: string }
      supportedReasoningEfforts?: string[]
      defaultReasoningEffort?: string
    }[]
  >
  /** Signing in happens inside a session. */
  createLoginSession(): Promise<LoginSession>
  deleteSession(sessionId: string): Promise<void>
}

/** Where the runtime program comes from: found on this computer, or downloaded the first time. */
export interface RuntimeSource {
  find(): string | undefined
  download(onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string>
}

export class RuntimeMissingError extends Error {
  constructor() {
    super('The GitHub Copilot program is not on this computer yet. Open Settings and choose Connect to download it.')
  }
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SIGN_IN_MESSAGE = 'You are not signed in to GitHub Copilot. Open Settings and choose Connect.'
/** Ten minutes is longer than either sign-in lets its code or link live. */
const SIGN_IN_LIMIT_MS = 10 * 60_000

export function toModels(list: Awaited<ReturnType<SdkClientHandle['listModels']>>): ModelInfo[] {
  return list
    .filter((m) => m.policy?.state !== 'disabled')
    .map((m) => {
      const efforts = (m.supportedReasoningEfforts ?? []).filter((e): e is Effort => EFFORTS.includes(e as Effort))
      const fallback = m.defaultReasoningEffort
      return {
        id: m.id,
        vendor: 'copilot' as const,
        label: m.name,
        efforts,
        ...(fallback && efforts.includes(fallback as Effort) ? { defaultEffort: fallback as Effort } : {}),
        images: m.capabilities?.supports?.vision === true
      }
    })
}

/** A sign-in address is opened in the person's browser, so only GitHub's is allowed through. */
function githubUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.github.com')) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function surface(step: LoginStep): SignInStep | { error: string } | undefined {
  if (step.kind === 'open-url') {
    const url = githubUrl(step.url)
    return url ? { kind: 'open-url', url } : { error: 'GitHub sent an address Celeste does not recognise, so it was not opened.' }
  }
  if (step.kind === 'device-code') {
    const url = githubUrl(step.verificationUri)
    return url ? { kind: 'device-code', url, code: step.userCode, expiresIn: step.expiresIn } : { error: 'GitHub sent an address Celeste does not recognise, so it was not opened.' }
  }
  return undefined
}

interface Flow {
  id: string
  session: LoginSession
  cancelled: boolean
  ended?: boolean
  abort: AbortController
  /** Settles when the flow is cancelled, so a call that is blocked on the person can be given up on. */
  stopped: Promise<void>
  stop: () => void
}

function newFlow(id: string, session: LoginSession | undefined, abort: AbortController): Flow {
  let stop: () => void = () => undefined
  const stopped = new Promise<void>((resolve) => (stop = resolve))
  return { id, session: session as LoginSession, cancelled: false, abort, stopped, stop }
}

/**
 * Owns the one Copilot runtime that every Celeste session shares. It starts on first use, so opening Celeste
 * costs nothing for someone who never uses Copilot, and starts again if it died.
 */
export class CopilotHost {
  private client: SdkClientHandle | undefined
  private starting: Promise<SdkClientHandle> | undefined
  private catalog: ModelInfo[] | undefined
  private flow: Flow | undefined

  constructor(
    private readonly create: (runtimePath?: string) => SdkClientHandle,
    private readonly runtime?: RuntimeSource
  ) {}

  private async running(): Promise<SdkClientHandle> {
    if (this.client) {
      try {
        await this.client.ping('alive')
        return this.client
      } catch {
        const dead = this.client
        this.client = undefined
        this.catalog = undefined
        void dead.stop().catch(() => undefined)
      }
    }
    this.starting ??= (async () => {
      const path = this.runtime?.find()
      if (this.runtime && !path) throw new RuntimeMissingError()
      const client = this.create(path)
      try {
        await client.start()
      } catch (err) {
        await Promise.resolve(client.stop()).catch(() => undefined)
        throw err
      }
      this.client = client
      return client
    })().finally(() => (this.starting = undefined))
    return this.starting
  }

  /** The client, once someone is signed in. Throws a message fit to show the user. */
  async ready(): Promise<SdkClientHandle> {
    let client: SdkClientHandle
    try {
      client = await this.running()
    } catch (err) {
      if (err instanceof RuntimeMissingError) throw err
      throw new Error(`GitHub Copilot could not start: ${err instanceof Error ? err.message : String(err)}`)
    }
    const auth = await client.getAuthStatus().catch(() => ({ isAuthenticated: false }))
    if (!auth.isAuthenticated) throw new Error(SIGN_IN_MESSAGE)
    return client
  }

  async status(): Promise<VendorConnection> {
    let client: SdkClientHandle
    try {
      client = await this.running()
    } catch (err) {
      if (err instanceof RuntimeMissingError) return { state: 'runtime-missing' }
      return { state: 'unavailable', message: err instanceof Error ? err.message : String(err) }
    }
    const auth = await client.getAuthStatus().catch(() => undefined)
    if (!auth?.isAuthenticated) return { state: 'signed-out' }
    return { state: 'signed-in', account: auth.login ?? auth.statusMessage ?? 'GitHub' }
  }

  /** The models this account can use, with the effort levels each takes. Cached until the runtime restarts. */
  async models(): Promise<ModelInfo[]> {
    if (this.catalog) return this.catalog
    const client = await this.ready()
    this.catalog = toModels(await client.listModels())
    return this.catalog
  }

  /** Whether the program is on this computer, so connecting needs no download. */
  hasProgram(): boolean {
    return !this.runtime || Boolean(this.runtime.find())
  }

  forgetModels(): void {
    this.catalog = undefined
  }

  /** The model Copilot offers for a session's choice. A choice it does not know (an old name) becomes Auto. */
  async resolve(model: string, effort: Effort | null): Promise<{ model: string; effort?: string }> {
    const list = await this.models()
    const found = list.find((m) => m.id === model) ?? list.find((m) => m.id === 'auto') ?? list[0]
    if (!found) throw new Error('GitHub Copilot offers no models for this account.')
    return { model: found.id, ...(effort && found.efforts.includes(effort) ? { effort } : {}) }
  }

  // --- connecting ------------------------------------------------------------------------------------

  /**
   * Gets the person signed in: downloads the program if it is missing, does nothing more if they already are,
   * and otherwise walks GitHub's sign-in. Progress goes to `on`. Resolves when it is over, whichever way.
   */
  async signIn(method: 'web' | 'code', on: (progress: VendorProgress) => void): Promise<void> {
    await this.cancelSignIn()
    const abort = new AbortController()
    const cancelled = () => abort.signal.aborted
    // Held from the very start, so Cancel works whatever the sign-in is doing: downloading, starting, or waiting.
    const mine = newFlow('', undefined, abort)
    this.flow = mine
    let session: LoginSession | undefined
    let flow: Flow | undefined
    try {
      if (this.runtime && !this.runtime.find()) {
        on({ state: 'downloading', progress: 0 })
        await this.runtime.download((progress) => on({ state: 'downloading', progress }), abort.signal)
        if (cancelled()) return
      }
      const client = await this.running()
      if (cancelled()) return
      const auth = await client.getAuthStatus().catch(() => undefined)
      if (auth?.isAuthenticated) {
        this.forgetModels()
        on({ state: 'done', account: auth.login ?? auth.statusMessage ?? 'GitHub' })
        return
      }
      session = await client.createLoginSession()
      if (cancelled()) return
      const begun = await session.rpc.accounts.login.begin({ kind: 'githubDotCom', method: method === 'code' ? 'device-code' : 'web' })
      flow = newFlow(begun.flowId, session, abort)
      // Cancelled while GitHub was still starting the flow: it is ended below without anything being shown.
      if (cancelled()) return
      this.flow = flow
      await this.walk(flow, begun.step, on)
    } catch (err) {
      if (!cancelled()) on({ state: 'failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (this.flow === mine || this.flow === flow) this.flow = undefined
      if (flow) await this.endFlow(flow)
      else if (session) {
        // A sign-in session that never got as far as a flow still has to go.
        await session.disconnect().catch(() => undefined)
        await this.client?.deleteSession(session.sessionId).catch(() => undefined)
      }
    }
  }

  private async walk(flow: Flow, first: LoginStep, on: (p: VendorProgress) => void): Promise<void> {
    const deadline = Date.now() + SIGN_IN_LIMIT_MS
    let step = first
    while (!flow.cancelled) {
      const shown = surface(step)
      if (shown && 'error' in shown) return on({ state: 'failed', message: shown.error })
      if (shown) on({ state: 'step', step: shown })

      switch (step.kind) {
        case 'completed': {
          const { status, login } = step.result
          if (status === 'completed') {
            this.forgetModels()
            const client = await this.running()
            const auth = await client.getAuthStatus().catch(() => undefined)
            return on(auth?.isAuthenticated ? { state: 'done', account: auth.login ?? login ?? 'GitHub' } : { state: 'failed', message: 'GitHub accepted the sign-in, but Copilot did not keep it.' })
          }
          return on({
            state: 'failed',
            message:
              status === 'needs-plaintext-consent'
                ? 'This computer has nowhere safe to keep the sign-in. Sign in with the GitHub Copilot command line tool instead, then come back.'
                : status === 'declined'
                  ? 'The sign-in was declined.'
                  : 'This GitHub account needs to be chosen in the GitHub Copilot command line tool first.'
          })
        }
        case 'error':
          return on({ state: 'failed', message: step.message })
        case 'input-required':
        case 'needs-interaction':
          return on({ state: 'failed', message: 'This kind of GitHub account needs the GitHub Copilot command line tool to sign in.' })
        default:
          if (Date.now() > deadline) return on({ state: 'failed', message: 'Nobody finished signing in, so Celeste stopped waiting. Choose Connect to try again.' })
          // Resolves once the person has finished in the browser (or the link or code ran out).
          step = await Promise.race([flow.session.rpc.accounts.login.advance({ flowId: flow.id }), flow.stopped.then((): LoginStep => ({ kind: 'error', message: 'Cancelled.' }))])
      }
    }
  }

  private async endFlow(flow: Flow): Promise<void> {
    if (flow.ended) return
    flow.ended = true
    const client = this.client
    await flow.session.rpc.accounts.login.cancel({ flowId: flow.id }).catch(() => undefined)
    await flow.session.disconnect().catch(() => undefined)
    // The sign-in session is not a conversation. It is deleted so it never turns up as one.
    await client?.deleteSession(flow.session.sessionId).catch(() => undefined)
  }

  /** Stops waiting for the person, closes the sign-in page's listener, and stops a download in progress. */
  async cancelSignIn(): Promise<void> {
    const flow = this.flow
    if (!flow) return
    flow.cancelled = true
    flow.stop()
    flow.abort.abort()
    this.flow = undefined
    if (flow.session) await this.endFlow(flow)
  }

  async stop(): Promise<void> {
    await this.cancelSignIn()
    const client = this.client
    this.client = undefined
    this.catalog = undefined
    await Promise.resolve(client?.stop()).catch(() => undefined)
  }
}
