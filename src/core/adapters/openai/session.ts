import { statSync } from 'node:fs'
import type { AgentError, AgentEvent, AgentSession, ApprovalAnswer, AskAnswers, Effort, ToolKind, UserInput } from '@shared/agent'
import type { AdapterContext } from '../types'
import { EventQueue } from '../event-queue'
import type { ResolvedMcpServer } from '../../mcp'
import { TOKEN_VAR, type Launch } from './host'
import { DEVICE_SERVER, decide, mcpConfig, policyFor, questionsFrom } from './permissions'
import type { RpcClient, RpcHandlers } from '../rpc'
import { Translator, errorFrom } from './translate'

export interface OpenAiDeps {
  ctx: AdapterContext
  /** How Codex is started for this session: its program, and the credential. Rejects with a readable message. `extra` are more `-c` settings. */
  launch: (extra: string[]) => Promise<Launch>
  /** Starts the program and gives the client for it. A test supplies one that plays Codex. */
  connect: (launch: Launch, handlers: RpcHandlers) => RpcClient
  /** Picks the model Codex is given for the session's choice, and whether it takes an effort setting. */
  resolveModel: (model: string, effort: Effort | null) => { model?: string; effort?: Effort }
  /** The credential Codex would be given now. When it differs from the one the running program has, the program is started again. */
  currentToken?: () => Promise<string>
  /** The outside tools (MCP servers) the person added, with their secrets filled in. Read when the program starts. */
  mcpServers?: () => Promise<ResolvedMcpServer[]>
  /** Where the agent reaches Celeste's device tools for this session, when devices are available. */
  deviceServer?: () => { url: string; token: string } | undefined
  version?: string
}

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MISSING = /no rollout found|thread not found|no thread|could not find (the )?thread|not found/i

/** What the user sees when a vendor session could not be resumed and a new one was started in its place. */
export const RESUME_NOTICE = '*OpenAI no longer had this conversation, so I continued from what was said here.*\n\n'

function failure(err: unknown): AgentError {
  return errorFrom(undefined, err instanceof Error ? err.message : String(err))
}

const sandboxMode = (type: string): 'read-only' | 'danger-full-access' => (type === 'readOnly' ? 'read-only' : 'danger-full-access')

export class OpenAiAgentSession implements AgentSession {
  readonly events = new EventQueue<AgentEvent>()
  private readonly translator: Translator
  private client: RpcClient | undefined
  private token: string | undefined
  private threadId = ''
  private id: string
  private closed = false
  private stopped = false
  private needsSeed = false
  private notice = ''
  private onResult: (() => void) | undefined
  private chain: Promise<void> = Promise.resolve()
  private readonly asking = new Map<string, (answer: ApprovalAnswer | AskAnswers) => void>()

  constructor(private readonly deps: OpenAiDeps) {
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
    this.stopped = false
    this.push([this.translator.begin(nextId('turn'))])
    try {
      await this.deliver(input)
    } catch (err) {
      this.push(this.translator.fail(failure(err)))
    }
  }

  /** Starts Codex if it is not running, and hands it the message with what the window has set. */
  private async deliver(input: UserInput): Promise<void> {
    const client = await this.ensure()
    // Stop was pressed while the session was still starting: the turn has already been closed, so send nothing.
    if (this.stopped) return
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
    const options = this.deps.ctx.options()
    const resolved = this.deps.resolveModel(options.model, options.effort)
    const policy = policyFor(this.deps.ctx.getApproval())
    const result = await client.request<{ turn?: { id?: string } }>(
      'turn/start',
      {
        threadId: this.threadId,
        input: this.content(text, input),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(resolved.model ? { model: resolved.model } : {}),
        ...(resolved.effort ? { effort: resolved.effort } : {})
      },
      120_000
    )
    if (result.turn?.id && this.translator.running) this.translator.codexTurnId ??= result.turn.id
  }

  /** The message as Codex takes it: the text, with images by their place on disk and other files named in the text. */
  private content(text: string, input: UserInput): unknown[] {
    const items: unknown[] = []
    const files: string[] = []
    for (const a of input.attachments) {
      const path = this.deps.ctx.attachmentPath(a.id)
      if (!path) continue
      try {
        statSync(path)
      } catch {
        continue
      }
      if (IMAGES.has(a.mime)) items.push({ type: 'localImage', path })
      else files.push(`${a.name}: ${path}`)
    }
    return [{ type: 'text', text: files.length ? `${text}\n\nAttached files:\n${files.join('\n')}` : text, text_elements: [] }, ...items]
  }

  // --- the program ------------------------------------------------------------------------------------

  /** Runs Codex for this session, and opens (or reopens) the conversation it had. */
  private async ensure(): Promise<RpcClient> {
    if (this.client?.running) {
      // A sign-in that was renewed since the program started is only picked up by starting it again. Between turns that is safe:
      // the conversation lives in Codex's own files and is resumed.
      const now = await this.deps.currentToken?.().catch(() => undefined)
      if (!now || now === this.token) return this.client
      this.dropClient()
    }
    const own = await this.deps.mcpServers?.().catch(() => [] as ResolvedMcpServer[])
    const launch = await this.deps.launch(mcpConfig(own ?? [], this.deps.deviceServer?.()))
    this.token = launch.env[TOKEN_VAR]
    const client = this.deps.connect(launch, {
      notification: (method, params) => this.onNotification(client, method, params),
      request: (method, params) => this.onRequest(client, method, params),
      exit: (code, stderr) => this.onExit(client, code, stderr)
    })
    this.client = client
    await client.request('initialize', { clientInfo: { name: 'celeste', title: 'Celeste', version: this.deps.version ?? '0.0.0' }, capabilities: null }, 60_000)
    client.notify('initialized')
    await this.openThread(client)
    this.translator.setCwd(this.deps.ctx.options().cwd)
    return client
  }

  private async openThread(client: RpcClient): Promise<void> {
    const { ctx } = this.deps
    const options = ctx.options()
    const resolved = this.deps.resolveModel(options.model, options.effort)
    const policy = policyFor(ctx.getApproval())
    const common = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(resolved.model ? { model: resolved.model } : {}),
      approvalPolicy: policy.approvalPolicy,
      sandbox: sandboxMode(policy.sandboxPolicy.type)
    }
    if (this.id) {
      try {
        const resumed = await client.request<{ thread: { id: string } }>('thread/resume', { threadId: this.id, ...common }, 60_000)
        this.threadId = resumed.thread.id
        return
      } catch (err) {
        if (!MISSING.test(err instanceof Error ? err.message : String(err))) throw err
        // The conversation Codex had is gone: a new one starts from Celeste's own log.
        this.id = ''
        this.notice = RESUME_NOTICE
      }
    }
    const started = await client.request<{ thread: { id: string } }>('thread/start', { ...common, ephemeral: false, serviceName: 'celeste' }, 60_000)
    this.threadId = started.thread.id
    this.id = started.thread.id
    this.needsSeed = true
    ctx.remember(this.id)
  }

  private dropClient(): void {
    const client = this.client
    this.client = undefined
    this.token = undefined
    this.releaseQuestions()
    client?.close()
  }

  private onNotification(client: RpcClient, method: string, params: Record<string, unknown>): void {
    if (client !== this.client || this.closed) return
    const events = this.translator.handle(method, params)
    this.push(events)
    if (method === 'turn/completed') this.onResult?.()
  }

  private onExit(client: RpcClient, _code: number | null, stderr: string): void {
    if (client !== this.client) return
    this.client = undefined
    this.releaseQuestions()
    if (!this.closed) {
      const tail = stderr.trim().split('\n').filter(Boolean).pop()
      this.push(this.translator.fail({ code: 'unknown', message: `OpenAI’s program stopped unexpectedly${tail ? `: ${tail.slice(0, 200)}` : '.'}`, retryable: true }))
    }
    this.onResult?.()
  }

  // --- questions Codex asks ---------------------------------------------------------------------------

  private ask(card: { kind: ToolKind; title: string; detail?: string }): Promise<ApprovalAnswer> {
    const requestId = nextId('req')
    return new Promise<ApprovalAnswer>((resolve) => {
      this.asking.set(requestId, (a) => resolve(a as ApprovalAnswer))
      this.push([{ type: 'approval.requested', requestId, ...card }])
    })
  }

  private async onRequest(client: RpcClient, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (client !== this.client) throw new Error('This session has moved on.')
    const mode = this.deps.ctx.getApproval()
    const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const d = decide('command', mode)
        if (d === 'allow') return { decision: 'accept' }
        if (d === 'deny') return { decision: 'decline' }
        const stdin = params['kind'] === 'writeStdin'
        const answer = await this.ask({ kind: 'shell', title: stdin ? 'Send input to a running command' : (text(params['reason']) ?? 'Run a command'), detail: text(params['command']) })
        return { decision: answer.allow ? (answer.always ? 'acceptForSession' : 'accept') : 'decline' }
      }
      case 'item/fileChange/requestApproval': {
        const d = decide('files', mode)
        if (d === 'allow') return { decision: 'accept' }
        if (d === 'deny') return { decision: 'decline' }
        const answer = await this.ask({ kind: 'edit', title: this.translator.titleOf(String(params['itemId'])) ?? 'Change files', detail: text(params['reason']) })
        return { decision: answer.allow ? (answer.always ? 'acceptForSession' : 'accept') : 'decline' }
      }
      case 'item/permissions/requestApproval': {
        const wanted = (params['permissions'] ?? {}) as Record<string, unknown>
        const granted = Object.fromEntries(Object.entries(wanted).filter(([, v]) => v !== null && v !== undefined))
        const d = decide('permissions', mode)
        let ok = d === 'allow'
        if (d === 'ask') {
          const answer = await this.ask({ kind: 'other', title: 'Allow extra access', detail: [text(params['reason']), JSON.stringify(granted, null, 2)].filter(Boolean).join('\n\n') })
          ok = answer.allow
        }
        return { permissions: ok ? granted : {}, scope: 'turn' }
      }
      case 'mcpServer/elicitation/request': {
        const server = text(params['serverName']) ?? 'a tool'
        // Celeste's own device tools ask for approval themselves, with the device's name on the card.
        if (server === DEVICE_SERVER) return { action: 'accept', content: null, _meta: null }
        if (params['mode'] === 'url') return { action: 'decline', content: null, _meta: null }
        const d = decide('tool', mode)
        let ok = d === 'allow'
        if (d === 'ask') ok = (await this.ask({ kind: 'mcp', title: server, detail: text(params['message']) })).allow
        return { action: ok ? 'accept' : 'decline', content: null, _meta: null }
      }
      case 'item/tool/requestUserInput': {
        const { questions, ids } = questionsFrom(params)
        const requestId = nextId('ask')
        const given = await new Promise<AskAnswers | ApprovalAnswer>((resolve) => {
          this.asking.set(requestId, resolve)
          this.push([{ type: 'ask_user.requested', requestId, questions }])
        })
        // A question that was let go of comes back as `{ allow: false }`, not as answers.
        const answers: Record<string, { answers: string[] }> = {}
        if (!('allow' in given)) {
          questions.forEach((q, i) => {
            const a = (given as AskAnswers)[q.question]
            answers[ids[i] as string] = { answers: Array.isArray(a) ? a : typeof a === 'string' && a ? [a] : [] }
          })
        }
        return { answers }
      }
      default:
        // Celeste offers Codex no tools of its own and signs in outside it, so anything else it asks for is refused.
        throw new Error(`Celeste does not handle ${method}.`)
    }
  }

  respond(requestId: string, answer: ApprovalAnswer | AskAnswers): void {
    const waiting = this.asking.get(requestId)
    if (!waiting) return
    this.asking.delete(requestId)
    waiting(answer)
  }

  /** Lets go of every question Codex is waiting on, so its calls return instead of hanging. */
  private releaseQuestions(): void {
    for (const [id, resolve] of [...this.asking]) {
      this.asking.delete(id)
      resolve({ allow: false } as ApprovalAnswer)
    }
  }

  async setModel(): Promise<void> {
    // Sent with the next message from the session's settings, so the change cannot race a running turn.
  }

  async setApprovalMode(): Promise<void> {
    // Sent with the next message, and read at each question through the context.
  }

  async interrupt(): Promise<void> {
    this.releaseQuestions()
    const client = this.client
    if (!client?.running) {
      // Stopped before the session even started: the turn that was about to begin ends here.
      this.stopped = true
      this.push(this.translator.interrupted())
      return
    }
    if (!this.translator.running) return
    // The turn may still be starting: wait a moment for Codex to name it.
    for (let i = 0; i < 40 && !this.translator.codexTurnId && this.translator.running; i++) await new Promise((r) => setTimeout(r, 50))
    const turnId = this.translator.codexTurnId
    if (!turnId) {
      this.stopped = true
      this.push(this.translator.interrupted())
      return
    }
    const ended = new Promise<void>((resolve) => {
      this.onResult = resolve
      setTimeout(resolve, 4000)
    })
    try {
      await client.request('turn/interrupt', { threadId: this.threadId, turnId }, 10_000)
      await ended
    } catch (err) {
      this.push(this.translator.fail(failure(err)))
    }
    // Codex ends the turn with a notification of its own. If it never came, end it here.
    this.push(this.translator.interrupted())
  }

  async close(): Promise<void> {
    this.closed = true
    this.releaseQuestions()
    this.events.close()
    // The conversation stays in Codex's own files, so the next message in a new process can resume it.
    this.dropClient()
  }
}
