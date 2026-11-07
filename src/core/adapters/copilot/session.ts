import type { ResumeSessionConfig, SessionConfig, SessionEvent } from '@github/copilot-sdk'
import type { AgentError, AgentEvent, AgentSession, ApprovalAnswer, ApprovalMode, AskAnswers, Effort, UserInput } from '@shared/agent'
import type { AdapterContext } from '../types'
import { EventQueue } from '../event-queue'
import { DEVICE_SERVER, decide, describe, type PermissionLike } from './permissions'
import { Translator } from './translate'

/** The part of the SDK's session that the adapter uses. A test supplies a fake that plays recorded events. */
export interface SdkSession {
  readonly sessionId: string
  on(handler: (event: SessionEvent) => void): () => void
  send(options: { prompt: string; attachments?: { type: 'file'; path: string; displayName?: string }[] }): Promise<string>
  abort(): Promise<void>
  setModel(model: string, options?: { reasoningEffort?: string }): Promise<void>
  disconnect(): Promise<void>
}

export interface SdkClient {
  createSession(config: SessionConfig): Promise<SdkSession>
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<SdkSession>
}

export interface CopilotDeps {
  ctx: AdapterContext
  /** The running Copilot runtime. Rejects with a readable message when it cannot start or nobody is signed in. */
  client: () => Promise<SdkClient>
  /** Picks the model Copilot offers for the session's choice, and whether it takes an effort setting. */
  resolveModel: (model: string, effort: Effort | null) => Promise<{ model: string; effort?: string }>
  /** Where the agent reaches Celeste's device tools for this session, when devices are available. */
  deviceServer?: () => { url: string; token: string } | undefined
}

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

const PLAN_FEEDBACK = 'Plan mode is on: change nothing and run nothing. Describe what you would do instead.'
const DENIED_FEEDBACK = 'The user denied this.'

/** What the user sees when a vendor session could not be resumed and a new one was started in its place. */
export const RESUME_NOTICE = '*Copilot no longer had this conversation, so I continued from what was said here.*\n\n'

function failure(err: unknown): AgentError {
  const message = err instanceof Error ? err.message : String(err)
  if (/not (signed|logged) in|sign in|login|authenticat|unauthor/i.test(message)) return { code: 'auth', message, retryable: false }
  if (/ECONN|ENOTFOUND|network|timed? ?out|EPIPE|connection/i.test(message)) return { code: 'network', message, retryable: true }
  return { code: 'unknown', message, retryable: false }
}

export class CopilotAgentSession implements AgentSession {
  readonly events = new EventQueue<AgentEvent>()
  private readonly translator: Translator
  private sdk: SdkSession | undefined
  private stopListening: (() => void) | undefined
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  private stopped = false
  private model = ''
  private effort: string | undefined
  /** Set when this run has no vendor conversation behind it, so the first message carries the history. */
  private needsSeed = false
  private notice = ''
  private readonly asking = new Map<string, (answer: ApprovalAnswer | AskAnswers) => void>()

  constructor(private readonly deps: CopilotDeps) {
    this.translator = new Translator(deps.ctx.options().cwd)
  }

  get vendorSessionId(): string {
    return this.sdk?.sessionId ?? this.deps.ctx.vendorSessionId ?? ''
  }

  send(input: UserInput): void {
    this.chain = this.chain.then(() => this.run(input)).catch(() => undefined)
  }

  private push(events: AgentEvent[]): void {
    for (const e of events) this.events.push(e)
  }

  private async run(input: UserInput): Promise<void> {
    if (this.closed) return
    const turnId = nextId('turn')
    this.stopped = false
    this.push([this.translator.begin(turnId)])
    try {
      const sdk = await this.ensure()
      await this.applyOptions(sdk)
      // Stop was pressed while the session was still starting: the turn has already been closed, so send nothing.
      if (this.stopped) return
      if (this.notice) {
        this.push([{ type: 'message.delta', text: this.notice }])
        this.notice = ''
      }
      const attachments = input.attachments.flatMap((a) => {
        const path = this.deps.ctx.attachmentPath(a.id)
        return path ? [{ type: 'file' as const, path, displayName: a.name }] : []
      })
      let prompt = input.text
      if (this.needsSeed) {
        const history = this.deps.ctx.transcript()
        // The log already holds this message as its last entry. Everything before it is the history.
        const earlier = history.endsWith(`User: ${input.text}`) ? history.slice(0, history.length - `User: ${input.text}`.length).trim() : history
        if (earlier) prompt = `Earlier in this conversation (for context; do not repeat it):\n\n${earlier}\n\n---\n\n${input.text}`
        this.needsSeed = false
      }
      await sdk.send({ prompt, ...(attachments.length ? { attachments } : {}) })
    } catch (err) {
      this.push(this.translator.fail(failure(err)))
    }
  }

  /** Creates the Copilot session, or resumes the one this conversation had. */
  private async ensure(): Promise<SdkSession> {
    if (this.sdk) return this.sdk
    const { ctx } = this.deps
    const client = await this.deps.client()
    const options = ctx.options()
    const resolved = await this.deps.resolveModel(options.model, options.effort)
    const device = this.deps.deviceServer?.()
    const common = {
      model: resolved.model,
      ...(resolved.effort ? { reasoningEffort: resolved.effort } : {}),
      ...(options.cwd ? { workingDirectory: options.cwd } : {}),
      streaming: true,
      onPermissionRequest: (request: unknown) => this.onPermission(request as PermissionLike),
      onUserInputRequest: (request: { question: string; choices?: string[] }) => this.onUserInput(request),
      ...(device
        ? { mcpServers: { [DEVICE_SERVER]: { type: 'http' as const, url: device.url, headers: { Authorization: `Bearer ${device.token}` }, tools: ['*'] } } }
        : {})
    }

    let sdk: SdkSession | undefined
    if (ctx.vendorSessionId) {
      try {
        sdk = await client.resumeSession(ctx.vendorSessionId, common as ResumeSessionConfig)
      } catch {
        // Gone: cleaned up, or made by another version. Start fresh and say so.
        this.notice = RESUME_NOTICE
      }
    }
    if (!sdk) {
      sdk = await client.createSession(common as SessionConfig)
      this.needsSeed = true
    }
    this.model = resolved.model
    this.effort = resolved.effort
    this.translator.setCwd(options.cwd)
    this.sdk = sdk
    ctx.remember(sdk.sessionId)
    this.stopListening = sdk.on((e) => {
      if (!this.closed) this.push(this.translator.handle(e))
    })
    return sdk
  }

  /** A model or effort changed in the window since the last message applies from this one. */
  private async applyOptions(sdk: SdkSession): Promise<void> {
    const options = this.deps.ctx.options()
    const resolved = await this.deps.resolveModel(options.model, options.effort)
    if (resolved.model !== this.model || resolved.effort !== this.effort) {
      await sdk.setModel(resolved.model, resolved.effort ? { reasoningEffort: resolved.effort } : undefined)
      this.model = resolved.model
      this.effort = resolved.effort
    }
  }

  // --- questions the agent asks -----------------------------------------------------------------------

  private async onPermission(request: PermissionLike): Promise<{ kind: 'approve-once' } | { kind: 'reject'; feedback?: string }> {
    const mode: ApprovalMode = this.deps.ctx.getApproval()
    const decision = decide(request, mode)
    if (decision === 'allow') return { kind: 'approve-once' }
    if (decision === 'deny') return { kind: 'reject', feedback: PLAN_FEEDBACK }
    const card = describe(request, this.deps.ctx.options().cwd)
    const requestId = nextId('req')
    const answer = await new Promise<ApprovalAnswer>((resolve) => {
      this.asking.set(requestId, (a) => resolve(a as ApprovalAnswer))
      this.push([{ type: 'approval.requested', requestId, ...card }])
    })
    return answer.allow ? { kind: 'approve-once' } : { kind: 'reject', feedback: DENIED_FEEDBACK }
  }

  private async onUserInput(request: { question: string; choices?: string[] }): Promise<{ answer: string; wasFreeform: boolean }> {
    const requestId = nextId('ask')
    const choices = request.choices ?? []
    const answers = await new Promise<AskAnswers>((resolve) => {
      this.asking.set(requestId, (a) => resolve(a as AskAnswers))
      this.push([
        {
          type: 'ask_user.requested',
          requestId,
          questions: [{ header: 'Question', question: request.question, options: choices.map((label) => ({ label })), multiSelect: false }]
        }
      ])
    })
    // A question that was let go of comes back as `{ allow: false }`, not as answers.
    const given = answers[request.question] ?? Object.values(answers).find((v) => typeof v === 'string' || Array.isArray(v))
    const answer = (Array.isArray(given) ? given.join(', ') : typeof given === 'string' ? given : '').trim()
    return { answer, wasFreeform: !choices.includes(answer) }
  }

  respond(requestId: string, answer: ApprovalAnswer | AskAnswers): void {
    const waiting = this.asking.get(requestId)
    if (!waiting) return
    this.asking.delete(requestId)
    waiting(answer)
  }

  /** Lets go of every question the agent is waiting on, so its calls return instead of hanging. */
  private releaseQuestions(): void {
    for (const [id, resolve] of [...this.asking]) {
      this.asking.delete(id)
      // An approval takes `allow`, a question takes answers: one object that says "no" and "nothing" to both.
      resolve({ allow: false } as ApprovalAnswer)
    }
  }

  async setModel(): Promise<void> {
    // Applied at the next message from the session's settings, so the change cannot race a running turn.
  }

  async setApprovalMode(): Promise<void> {
    // Read at each request through the context.
  }

  async interrupt(): Promise<void> {
    this.releaseQuestions()
    const sdk = this.sdk
    if (!sdk) {
      // Stopped before the session even started: the turn that was about to begin ends here.
      this.stopped = true
      this.push(this.translator.interrupted())
      return
    }
    try {
      await sdk.abort()
    } catch (err) {
      this.push(this.translator.fail(failure(err)))
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.releaseQuestions()
    this.stopListening?.()
    this.events.close()
    const sdk = this.sdk
    this.sdk = undefined
    // Disconnecting keeps the conversation on disk, so the next message can resume it.
    await sdk?.disconnect().catch(() => undefined)
  }
}
