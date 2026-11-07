import { readFileSync, statSync } from 'node:fs'
import type { CanUseTool, McpServerConfig, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentError, AgentEvent, AgentSession, ApprovalAnswer, ApprovalMode, AskAnswers, Effort, UserInput } from '@shared/agent'
import type { AdapterContext } from '../types'
import { EventQueue } from '../event-queue'
import { DEVICE_SERVER, decide, describe, questionsFrom } from './permissions'
import { Translator, errorFrom } from './translate'

/** The part of the SDK's running query that the adapter uses. A test supplies a fake that plays recorded messages. */
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
  applyFlagSettings(settings: { effortLevel?: Effort | null }): Promise<void>
  close(): void
}

export type StartQuery = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery

export interface ClaudeDeps {
  ctx: AdapterContext
  start: StartQuery
  /** How Claude Code is run for this session: its program, and the environment (its sign-in, or an API key). Rejects with a readable message. */
  launch: () => Promise<{ env: Record<string, string | undefined>; executable?: string }>
  /** Picks the model Claude offers for the session's choice, and whether it takes an effort setting. */
  resolveModel: (model: string, effort: Effort | null) => { model?: string; effort?: Effort }
  /** Where the agent reaches Celeste's device tools for this session, when devices are available. */
  deviceServer?: () => { url: string; token: string } | undefined
}

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

const PLAN_FEEDBACK = 'Plan mode is on: change nothing and run nothing. Describe what you would do instead.'
const DENIED_FEEDBACK = 'The user denied this.'
const IMAGE_LIMIT = 5 * 1024 * 1024
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** What the user sees when a vendor session could not be resumed and a new one was started in its place. */
export const RESUME_NOTICE = '*Claude no longer had this conversation, so I continued from what was said here.*\n\n'

const MISSING = /no conversation found|session .*not found|could not (find|resume)|no such session/i

function failure(err: unknown): AgentError {
  const message = err instanceof Error ? err.message : String(err)
  return errorFrom(undefined, message)
}

export class ClaudeAgentSession implements AgentSession {
  readonly events = new EventQueue<AgentEvent>()
  private readonly translator: Translator
  private query: ClaudeQuery | undefined
  private prompt: EventQueue<SDKUserMessage> | undefined
  private abort: AbortController | undefined
  private closed = false
  private stopped = false
  private interrupting = false
  private model: string | undefined
  private effort: Effort | undefined
  private id: string
  /** Set when this run has no vendor conversation behind it, so the first message carries the history. */
  private needsSeed = false
  private notice = ''
  private resuming = false
  private onResult: (() => void) | undefined
  private last: UserInput | undefined
  private chain: Promise<void> = Promise.resolve()
  private readonly asking = new Map<string, (answer: ApprovalAnswer | AskAnswers) => void>()

  constructor(private readonly deps: ClaudeDeps) {
    this.translator = new Translator(deps.ctx.options().cwd)
    this.id = deps.ctx.vendorSessionId ?? ''
  }

  get vendorSessionId(): string {
    return this.id
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
    this.interrupting = false
    this.last = input
    this.push([this.translator.begin(turnId)])
    try {
      await this.deliver(input)
    } catch (err) {
      this.push(this.translator.fail(failure(err)))
    }
  }

  /** Starts Claude Code if it is not running, applies what changed in the window, and hands it the message. */
  private async deliver(input: UserInput): Promise<void> {
    const q = await this.ensure()
    // Stop was pressed while the session was still starting: the turn has already been closed, so send nothing.
    if (this.stopped) return
    await this.applyOptions(q)
    if (this.notice) {
      this.push([{ type: 'message.delta', text: this.notice }])
      this.notice = ''
    }
    let text = input.text
    if (this.needsSeed) {
      const history = this.deps.ctx.transcript()
      // The log already holds this message as its last entry. Everything before it is the history.
      const earlier = history.endsWith(`User: ${input.text}`) ? history.slice(0, history.length - `User: ${input.text}`.length).trim() : history
      if (earlier) text = `Earlier in this conversation (for context; do not repeat it):\n\n${earlier}\n\n---\n\n${input.text}`
      this.needsSeed = false
    }
    this.prompt?.push({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: this.content(text, input) }
    } as SDKUserMessage)
  }

  /** The message's content: the text, with images as image blocks and other files by their place on disk, which Claude can read. */
  private content(text: string, input: UserInput): Exclude<SDKUserMessage['message']['content'], string> {
    const blocks: Record<string, unknown>[] = []
    const files: string[] = []
    for (const a of input.attachments) {
      const path = this.deps.ctx.attachmentPath(a.id)
      if (!path) continue
      try {
        if (IMAGES.has(a.mime) && statSync(path).size <= IMAGE_LIMIT) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: readFileSync(path).toString('base64') } })
          continue
        }
      } catch {
        continue
      }
      files.push(`${a.name}: ${path}`)
    }
    blocks.push({ type: 'text', text: files.length ? `${text}\n\nAttached files:\n${files.join('\n')}` : text })
    return blocks as never
  }

  /** Runs Claude Code for this session, resuming the conversation it had. */
  private async ensure(): Promise<ClaudeQuery> {
    if (this.query) return this.query
    const { ctx } = this.deps
    const options = ctx.options()
    const launch = await this.deps.launch()
    const resolved = this.deps.resolveModel(options.model, options.effort)
    const device = this.deps.deviceServer?.()
    const abort = new AbortController()
    const prompt = new EventQueue<SDKUserMessage>()
    const resume = this.id || undefined
    const mcpServers: Record<string, McpServerConfig> | undefined = device
      ? { [DEVICE_SERVER]: { type: 'http', url: device.url, headers: { Authorization: `Bearer ${device.token}` } } }
      : undefined
    const q = this.deps.start({
      prompt,
      options: {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(resolved.model ? { model: resolved.model } : {}),
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(resume ? { resume } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(launch.executable ? { pathToClaudeCodeExecutable: launch.executable } : {}),
        env: launch.env,
        permissionMode: 'default',
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        // Celeste's approval modes are the only rule. A person's own allow rules in ~/.claude must not skip them, and a Develop
        // session reads the project's own settings and CLAUDE.md.
        settingSources: ctx.mode === 'develop' ? ['project'] : [],
        abortController: abort
      }
    })
    this.query = q
    this.prompt = prompt
    this.abort = abort
    this.resuming = Boolean(resume)
    this.model = resolved.model
    this.effort = resolved.effort
    if (!resume) this.needsSeed = true
    this.translator.setCwd(options.cwd)
    void this.read(q)
    return q
  }

  /** Reads what Claude Code says until it stops, one query for the life of the process. */
  private async read(q: ClaudeQuery): Promise<void> {
    try {
      for await (const message of q) {
        if (q !== this.query || this.closed) return
        const m = message as unknown as { type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string; errors?: unknown }
        // Once Claude has said anything of its own, the conversation was found.
        if (m.type === 'assistant' || m.type === 'stream_event') this.resuming = false
        if (m.session_id && m.session_id !== this.id && (m.type === 'system' || m.type === 'result')) {
          this.id = m.session_id
          this.deps.ctx.remember(this.id)
        }
        if (m.type === 'result') {
          // Resuming a conversation that is gone fails before anything is said. Start a new one in its place.
          const words = `${m.result ?? ''} ${Array.isArray(m.errors) ? m.errors.join(' ') : ''}`
          if (this.resuming && MISSING.test(words)) {
            await this.recover()
            return
          }
          if (this.interrupting) {
            this.interrupting = false
            this.push(this.translator.interrupted())
          } else {
            this.push(this.translator.handle(message))
          }
          this.onResult?.()
          continue
        }
        this.push(this.translator.handle(message))
      }
    } catch (err) {
      if (q !== this.query || this.closed) return
      const text = err instanceof Error ? err.message : String(err)
      if (this.resuming && MISSING.test(text)) {
        await this.recover()
        return
      }
      this.push(this.translator.fail(failure(err)))
    }
    // The process ended, whatever the reason. The next message starts it again and resumes the conversation.
    if (q === this.query) {
      this.query = undefined
      this.prompt = undefined
      this.push(this.translator.fail({ code: 'unknown', message: 'Claude stopped unexpectedly.', retryable: true }))
    }
    this.onResult?.()
  }

  /** The conversation to resume was gone: start a new one from Celeste's own log and say so. */
  private async recover(): Promise<void> {
    this.dropQuery()
    this.id = ''
    this.notice = RESUME_NOTICE
    this.resuming = false
    const input = this.last
    if (!input || this.closed) return
    try {
      await this.deliver(input)
    } catch (err) {
      this.push(this.translator.fail(failure(err)))
    }
  }

  private dropQuery(): void {
    const q = this.query
    this.query = undefined
    this.prompt?.close()
    this.prompt = undefined
    this.abort?.abort()
    this.abort = undefined
    try {
      q?.close()
    } catch {
      /* already gone */
    }
  }

  /** A model or effort changed in the window since the last message applies from this one. */
  private async applyOptions(q: ClaudeQuery): Promise<void> {
    const options = this.deps.ctx.options()
    const resolved = this.deps.resolveModel(options.model, options.effort)
    if (resolved.model !== this.model) {
      await q.setModel(resolved.model)
      this.model = resolved.model
    }
    if (resolved.effort !== this.effort) {
      await q.applyFlagSettings({ effortLevel: resolved.effort ?? null })
      this.effort = resolved.effort
    }
  }

  // --- questions the agent asks -----------------------------------------------------------------------

  private readonly canUseTool: CanUseTool = async (toolName, input, extra): Promise<PermissionResult> => {
    if (toolName === 'AskUserQuestion') return this.askUser(input)
    const mode: ApprovalMode = this.deps.ctx.getApproval()
    const decision = decide(toolName, mode)
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input }
    if (decision === 'deny') return { behavior: 'deny', message: PLAN_FEEDBACK }
    const card = describe(toolName, input, this.deps.ctx.options().cwd, { title: extra.title, description: extra.description })
    const requestId = nextId('req')
    const answer = await new Promise<ApprovalAnswer>((resolve) => {
      this.asking.set(requestId, (a) => resolve(a as ApprovalAnswer))
      this.push([{ type: 'approval.requested', requestId, ...card }])
    })
    return answer.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: DENIED_FEEDBACK }
  }

  private async askUser(input: Record<string, unknown>): Promise<PermissionResult> {
    const questions = questionsFrom(input)
    const requestId = nextId('ask')
    const given = await new Promise<AskAnswers | ApprovalAnswer>((resolve) => {
      this.asking.set(requestId, resolve)
      this.push([{ type: 'ask_user.requested', requestId, questions }])
    })
    // A question that was let go of comes back as `{ allow: false }`, not as answers.
    if ('allow' in given) return { behavior: 'deny', message: 'The user did not answer.' }
    const answers: Record<string, string> = {}
    for (const q of questions) {
      const a = (given as AskAnswers)[q.question]
      answers[q.question] = Array.isArray(a) ? a.join(', ') : typeof a === 'string' ? a : ''
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } }
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
    const q = this.query
    if (!q) {
      // Stopped before the session even started: the turn that was about to begin ends here.
      this.stopped = true
      this.push(this.translator.interrupted())
      return
    }
    if (!this.translator.running) return
    this.interrupting = true
    const ended = new Promise<void>((resolve) => {
      this.onResult = resolve
      setTimeout(resolve, 4000)
    })
    try {
      await q.interrupt()
      await ended
    } catch (err) {
      this.push(this.translator.fail(failure(err)))
    }
    // Claude Code ends the turn with a result of its own. If it never came, end it here.
    this.interrupting = false
    this.push(this.translator.interrupted())
  }

  async close(): Promise<void> {
    this.closed = true
    this.releaseQuestions()
    this.events.close()
    // The conversation stays on disk, so the next message in a new process can resume it.
    this.dropQuery()
  }
}
