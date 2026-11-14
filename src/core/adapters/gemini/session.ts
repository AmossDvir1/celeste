import { readFileSync, statSync } from 'node:fs'
import type { AgentError, AgentEvent, AgentSession, ApprovalAnswer, ApprovalMode, AskAnswers, ToolKind, UserInput } from '@shared/agent'
import type { AdapterContext } from '../types'
import { EventQueue } from '../event-queue'
import type { ResolvedMcpServer } from '../../mcp'
import type { RpcClient, RpcHandlers } from '../rpc'
import { displayPath } from '../copilot/diff'
import type { Launch } from './host'
import { Translator, errorFrom, toolKind } from './translate'

export interface GeminiDeps {
  ctx: AdapterContext
  /** How the CLI is started for this session: its program and the key. Rejects with a readable message. */
  launch: () => Promise<Launch>
  /** Starts the program and gives the client for it. A test supplies one that plays Gemini. */
  connect: (launch: Launch, handlers: RpcHandlers, options: { jsonrpc: boolean }) => RpcClient
  /** The CLI's id for the model the session's choice stands for. */
  resolveModel: (model: string) => string | undefined
  /** The outside tools (MCP servers) the person added, with their secrets filled in. Read when a session opens. */
  mcpServers?: () => Promise<ResolvedMcpServer[]>
  /** Where the agent reaches Celeste's device tools for this session, when devices are available. */
  deviceServer?: () => { url: string; token: string } | undefined
  version?: string
}

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_LIMIT = 5 * 1024 * 1024
const MISSING = /not found|no such session|could not (find|load|resume)|invalid session|does not exist/i
/** The name Celeste's own tool server goes by in Gemini's list. Its commands ask for approval themselves. */
export const DEVICE_SERVER = 'celeste-devices'

/** What the user sees when a vendor session could not be resumed and a new one was started in its place. */
export const RESUME_NOTICE = '*Gemini no longer had this conversation, so I continued from what was said here.*\n\n'

/** Gemini's own approval modes, which Celeste's four match: it then asks, or does not, by itself. */
export const MODE: Record<ApprovalMode, string> = { auto: 'yolo', edits: 'autoEdit', ask: 'default', plan: 'plan' }

type Decision = 'allow' | 'ask' | 'deny'

/** What to do when Gemini asks to run a tool, given the approval mode. Reading and searching are always fine. */
export function decide(kind: ToolKind, mode: ApprovalMode): Decision {
  const looks = kind === 'read' || kind === 'search'
  if (mode === 'plan') return looks ? 'allow' : 'deny'
  if (mode === 'auto' || looks) return 'allow'
  if (mode === 'edits' && (kind === 'edit' || kind === 'write')) return 'allow'
  return 'ask'
}

function failure(err: unknown): AgentError {
  return errorFrom(err instanceof Error ? err.message : String(err))
}

/** The `mcpServers` of a new session, in the Agent Client Protocol's form. The device server is named first, and no tool of the person's may take its name. */
export function acpServers(servers: ResolvedMcpServer[], device?: { url: string; token: string }): unknown[] {
  const pairs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }))
  const out: unknown[] = []
  if (device) out.push({ type: 'http', name: DEVICE_SERVER, url: device.url, headers: [{ name: 'Authorization', value: `Bearer ${device.token}` }] })
  for (const s of servers) {
    if (s.key === DEVICE_SERVER) continue
    if (s.type === 'http' && s.url) out.push({ type: 'http', name: s.key, url: s.url, headers: pairs(s.headers) })
    else if (s.type === 'stdio' && s.command) out.push({ name: s.key, command: s.command, args: s.args, env: pairs(s.env) })
  }
  return out
}

export class GeminiAgentSession implements AgentSession {
  readonly events = new EventQueue<AgentEvent>()
  private readonly translator: Translator
  private client: RpcClient | undefined
  private id: string
  private closed = false
  private stopped = false
  private needsSeed = false
  private notice = ''
  private model: string | undefined
  private mode: string | undefined
  private modes: string[] = []
  private onResult: (() => void) | undefined
  private chain: Promise<void> = Promise.resolve()
  private readonly asking = new Map<string, (answer: ApprovalAnswer | AskAnswers) => void>()

  constructor(private readonly deps: GeminiDeps) {
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

  /** Starts Gemini if it is not running, applies what changed in the window, and hands it the message. Resolves when the turn has ended. */
  private async deliver(input: UserInput): Promise<void> {
    const client = await this.ensure()
    // Stop was pressed while the session was still starting: the turn has already been closed, so send nothing.
    if (this.stopped) return
    await this.apply(client)
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
    try {
      const result = await client.request<Record<string, unknown>>('session/prompt', { sessionId: this.id, prompt: this.content(text, input) })
      this.push(this.translator.finish(result ?? {}))
    } catch (err) {
      // The program ended or the request failed. If the turn was already closed (stopped, or the program's exit said why), nothing more is said.
      this.push(this.translator.fail(failure(err)))
    }
    this.onResult?.()
  }

  /** The message as Gemini takes it: the text, with images inline and other files named in the text by their place on disk. */
  private content(text: string, input: UserInput): unknown[] {
    const blocks: unknown[] = []
    const files: string[] = []
    for (const a of input.attachments) {
      const path = this.deps.ctx.attachmentPath(a.id)
      if (!path) continue
      try {
        if (IMAGES.has(a.mime) && statSync(path).size <= IMAGE_LIMIT) {
          blocks.push({ type: 'image', mimeType: a.mime, data: readFileSync(path).toString('base64') })
          continue
        }
      } catch {
        continue
      }
      files.push(`${a.name}: ${path}`)
    }
    return [{ type: 'text', text: files.length ? `${text}\n\nAttached files:\n${files.join('\n')}` : text }, ...blocks]
  }

  // --- the program ------------------------------------------------------------------------------------

  /** Runs Gemini for this session, and opens (or reopens) the conversation it had. */
  private async ensure(): Promise<RpcClient> {
    if (this.client?.running) return this.client
    const own = await this.deps.mcpServers?.().catch(() => [] as ResolvedMcpServer[])
    const launch = await this.deps.launch()
    const client = this.deps.connect(
      launch,
      {
        notification: (method, params) => this.onNotification(client, method, params),
        request: (method, params) => this.onRequest(client, method, params),
        exit: (code, stderr) => this.onExit(client, code, stderr)
      },
      { jsonrpc: true }
    )
    this.client = client
    this.model = undefined
    this.mode = undefined
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60_000)
    await client.request('authenticate', { methodId: 'gemini-api-key' }, 60_000)
    await this.openSession(client, acpServers(own ?? [], this.deps.deviceServer?.()))
    this.translator.setCwd(this.deps.ctx.options().cwd)
    return client
  }

  private async openSession(client: RpcClient, mcpServers: unknown[]): Promise<void> {
    const { ctx } = this.deps
    const cwd = ctx.options().cwd ?? process.cwd()
    let opened: { models?: { currentModelId?: string }; modes?: { currentModeId?: string; availableModes?: { id: string }[] } } | undefined
    if (this.id) {
      // Gemini replays the whole conversation as it loads it. Celeste has it already, so nothing said meanwhile is shown.
      this.translator.loading = true
      try {
        opened = await client.request('session/load', { sessionId: this.id, cwd, mcpServers }, 60_000)
      } catch (err) {
        if (!MISSING.test(err instanceof Error ? err.message : String(err))) throw err
        // The conversation Gemini had is gone: a new one starts from Celeste's own log.
        this.id = ''
        this.notice = RESUME_NOTICE
      } finally {
        this.translator.loading = false
      }
    }
    if (!this.id) {
      const made = await client.request<{ sessionId: string } & NonNullable<typeof opened>>('session/new', { cwd, mcpServers }, 60_000)
      this.id = made.sessionId
      opened = made
      this.needsSeed = true
      ctx.remember(this.id)
    }
    this.model = opened?.models?.currentModelId
    this.mode = opened?.modes?.currentModeId
    this.modes = (opened?.modes?.availableModes ?? []).map((m) => m.id)
  }

  /** A model or approval mode changed in the window since the last message applies from this one. */
  private async apply(client: RpcClient): Promise<void> {
    const options = this.deps.ctx.options()
    const model = this.deps.resolveModel(options.model)
    if (model && model !== this.model) {
      await client.request('session/set_model', { sessionId: this.id, modelId: model }, 30_000)
      this.model = model
    }
    const mode = MODE[this.deps.ctx.getApproval()]
    if (this.modes.includes(mode) && mode !== this.mode) {
      await client.request('session/set_mode', { sessionId: this.id, modeId: mode }, 30_000)
      this.mode = mode
    }
  }

  private dropClient(): void {
    const client = this.client
    this.client = undefined
    this.releaseQuestions()
    client?.close()
  }

  private onNotification(client: RpcClient, method: string, params: Record<string, unknown>): void {
    if (client !== this.client || this.closed || method !== 'session/update') return
    const update = params['update']
    if (update && typeof update === 'object') this.push(this.translator.handle(update as Record<string, unknown>))
  }

  private onExit(client: RpcClient, _code: number | null, stderr: string): void {
    if (client !== this.client) return
    this.client = undefined
    this.releaseQuestions()
    if (!this.closed) {
      const tail = stderr.trim().split('\n').filter(Boolean).pop()
      this.push(this.translator.fail({ code: 'unknown', message: `Gemini’s program stopped unexpectedly${tail ? `: ${tail.slice(0, 200)}` : '.'}`, retryable: true }))
    }
    this.onResult?.()
  }

  // --- questions Gemini asks --------------------------------------------------------------------------

  private ask(card: { kind: ToolKind; title: string; detail?: string }): Promise<ApprovalAnswer> {
    const requestId = nextId('req')
    return new Promise<ApprovalAnswer>((resolve) => {
      this.asking.set(requestId, (a) => resolve(a as ApprovalAnswer))
      this.push([{ type: 'approval.requested', requestId, ...card }])
    })
  }

  private async onRequest(client: RpcClient, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (client !== this.client) throw new Error('This session has moved on.')
    if (method !== 'session/request_permission') throw new Error(`Celeste does not handle ${method}.`)
    const call = (params['toolCall'] ?? {}) as Record<string, unknown>
    const options = (Array.isArray(params['options']) ? params['options'] : []) as { optionId: string; kind: string }[]
    const pick = (...kinds: string[]) => options.find((o) => kinds.includes(o.kind))?.optionId
    const select = (optionId: string | undefined) => (optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
    const kind = toolKind(call['kind'])
    const title = typeof call['title'] === 'string' ? call['title'] : 'Tool'
    // Celeste's own device tools ask for approval themselves, with the device's name on the card.
    if (`${String(call['toolCallId'] ?? '')} ${title}`.includes(DEVICE_SERVER)) return select(pick('allow_once', 'allow_always'))
    const d = decide(kind, this.deps.ctx.getApproval())
    if (d === 'allow') return select(pick('allow_once', 'allow_always'))
    if (d === 'deny') return select(pick('reject_once', 'reject_always'))
    const path = Array.isArray(call['locations']) ? (call['locations'] as { path?: string }[])[0]?.path : undefined
    const card =
      kind === 'shell'
        ? { kind, title: 'Run a command', detail: title }
        : kind === 'edit' || kind === 'write'
          ? { kind, title: this.translator.titleOf(String(call['toolCallId'])) ?? title, ...(path ? { detail: displayPath(path, this.deps.ctx.options().cwd) } : {}) }
          : { kind, title }
    const answer = await this.ask(card)
    return answer.allow ? select(pick(answer.always ? 'allow_always' : 'allow_once', 'allow_once')) : select(pick('reject_once', 'reject_always'))
  }

  respond(requestId: string, answer: ApprovalAnswer | AskAnswers): void {
    const waiting = this.asking.get(requestId)
    if (!waiting) return
    this.asking.delete(requestId)
    waiting(answer)
  }

  /** Lets go of every question Gemini is waiting on, so its calls return instead of hanging. */
  private releaseQuestions(): void {
    for (const [id, resolve] of [...this.asking]) {
      this.asking.delete(id)
      resolve({ allow: false } as ApprovalAnswer)
    }
  }

  async setModel(): Promise<void> {
    // Applied with the next message from the session's settings, so the change cannot race a running turn.
  }

  async setApprovalMode(): Promise<void> {
    // Applied with the next message, and read at each question through the context.
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
    const ended = new Promise<void>((resolve) => {
      this.onResult = resolve
      setTimeout(resolve, 4000)
    })
    // The answer to the prompt says "cancelled", which ends the turn. If it never came, it is ended here.
    if (this.id) client.notify('session/cancel', { sessionId: this.id })
    await ended
    this.push(this.translator.interrupted())
  }

  async close(): Promise<void> {
    this.closed = true
    this.releaseQuestions()
    this.events.close()
    // The conversation stays in Gemini's own files, so the next message in a new process can load it.
    this.dropClient()
  }
}
