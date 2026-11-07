import type { SessionEvent } from '@github/copilot-sdk'
import type { AgentError, AgentEvent, FileDiff, ToolKind, Usage } from '@shared/agent'
import { displayPath, parseUnifiedDiff } from './diff'

/*
 * Copilot's events to Celeste's. Pure: it holds only what it must remember between events (which tool is
 * which, the diff of an edit that was asked about), so it can be tested on recorded turns.
 */

const KIND_BY_TOOL: Record<string, ToolKind> = {
  view: 'read',
  read: 'read',
  read_file: 'read',
  edit: 'edit',
  str_replace: 'edit',
  str_replace_editor: 'edit',
  apply_patch: 'edit',
  create: 'write',
  write: 'write',
  powershell: 'shell',
  bash: 'shell',
  shell: 'shell',
  read_powershell: 'shell',
  write_powershell: 'shell',
  stop_powershell: 'shell',
  read_bash: 'shell',
  write_bash: 'shell',
  stop_bash: 'shell',
  grep: 'search',
  glob: 'search',
  rg: 'search',
  web_fetch: 'web',
  web_search: 'web',
  task: 'agent',
  subagent: 'agent'
}

/** Tools that are plumbing, or that Celeste shows another way (the question card for `ask_user`). */
const HIDDEN_TOOLS = new Set(['ask_user', 'report_intent', 'update_todo', 'todo', 'sql', 'store_memory', 'skill'])

/** The most of a tool's result kept as its output when nothing was streamed. The agent still sees all of it. */
const RESULT_LIMIT = 4000

export function toolKind(toolName: string, isMcp: boolean): ToolKind {
  if (isMcp) return 'mcp'
  return KIND_BY_TOOL[toolName] ?? 'other'
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

export function errorFrom(data: { errorType?: string; errorCode?: string; statusCode?: number; message: string }): AgentError {
  const kind = `${data.errorType ?? ''} ${data.errorCode ?? ''}`.toLowerCase()
  const message = data.message || 'Copilot reported an error.'
  if (data.statusCode === 401 || data.statusCode === 403 || /auth|unauthor|forbidden|token|sign.?in|login/.test(kind)) {
    return { code: 'auth', message, retryable: false }
  }
  if (data.statusCode === 429 || /rate|quota|limit|too.?many/.test(kind)) return { code: 'rate_limit', message, retryable: true }
  if (/network|timeout|econn|enotfound|fetch|offline|connect/.test(kind) || /ECONN|ENOTFOUND|network|timed? ?out/i.test(message)) {
    return { code: 'network', message, retryable: true }
  }
  return { code: 'unknown', message, retryable: false }
}

interface Known {
  kind: ToolKind
  streamed: boolean
}

export class Translator {
  private readonly tools = new Map<string, Known>()
  private readonly diffs = new Map<string, FileDiff[]>()
  private readonly streamedMessages = new Set<string>()
  private readonly streamedReasoning = new Set<string>()
  private ended = true
  private aborted = false
  private turnId = ''

  constructor(private cwd?: string) {}

  setCwd(cwd: string | undefined): void {
    this.cwd = cwd
  }

  /** Called when a message is sent. The turn ends at the next idle or error. */
  begin(turnId: string): AgentEvent {
    this.ended = false
    this.aborted = false
    this.turnId = turnId
    this.streamedMessages.clear()
    this.streamedReasoning.clear()
    return { type: 'turn.started', turnId }
  }

  /** The turn ended without Copilot saying so: the connection dropped, or sending failed. */
  fail(error: AgentError): AgentEvent[] {
    if (this.ended) return []
    this.ended = true
    return [{ type: 'turn.failed', turnId: this.turnId, error }]
  }

  /** The turn was stopped before Copilot took part, so there is no idle event to wait for. */
  interrupted(): AgentEvent[] {
    if (this.ended) return []
    this.ended = true
    return [{ type: 'turn.interrupted', turnId: this.turnId }]
  }

  handle(event: SessionEvent): AgentEvent[] {
    // Everything here is typed by `event.type`, but a newer runtime may send shapes this version does not know. Be strict about what is read.
    const e = event as { type: string; data: Record<string, unknown> }
    const d = e.data ?? {}
    switch (e.type) {
      case 'assistant.message_delta': {
        if (d.parentToolCallId || this.ended) return []
        const text = str(d.deltaContent)
        if (!text) return []
        if (str(d.messageId)) this.streamedMessages.add(d.messageId as string)
        return [{ type: 'message.delta', text }]
      }
      case 'assistant.message': {
        // Without streaming the whole message arrives at once.
        const id = str(d.messageId)
        const text = str(d.content)
        if (this.ended || d.parentToolCallId || !text || (id && this.streamedMessages.has(id))) return []
        return [{ type: 'message.delta', text }]
      }
      case 'assistant.reasoning_delta': {
        const text = str(d.deltaContent)
        if (this.ended || !text) return []
        if (str(d.reasoningId)) this.streamedReasoning.add(d.reasoningId as string)
        return [{ type: 'thinking.delta', text }]
      }
      case 'assistant.reasoning': {
        const id = str(d.reasoningId)
        const text = str(d.content)
        if (this.ended || !text || (id && this.streamedReasoning.has(id))) return []
        return [{ type: 'thinking.delta', text }]
      }
      case 'assistant.usage': {
        const usage: Usage = { inputTokens: Number(d.inputTokens ?? 0), outputTokens: Number(d.outputTokens ?? 0) }
        return this.ended ? [] : [{ type: 'usage.updated', usage }]
      }
      case 'permission.requested': {
        // Remember what an edit will change, so the finished tool can show it.
        const request = d.permissionRequest as { kind?: string; toolCallId?: string; diff?: string; fileName?: string } | undefined
        if (request?.kind === 'write' && request.toolCallId && request.diff && request.fileName) {
          this.diffs.set(request.toolCallId, [parseUnifiedDiff(request.diff, displayPath(request.fileName, this.cwd))])
        }
        return []
      }
      case 'tool.execution_start':
        return this.toolStarted(d)
      case 'tool.shell_output': {
        const id = str(d.toolCallId)
        const known = id ? this.tools.get(id) : undefined
        const text = str(d.text)
        if (!id || !known || !text) return []
        known.streamed = true
        return [{ type: 'tool.output', id, text: text.replace(/\r\n/g, '\n') }]
      }
      case 'tool.execution_complete':
        return this.toolCompleted(d)
      case 'abort':
        this.aborted = true
        return []
      case 'session.idle': {
        if (this.ended) return []
        this.ended = true
        const interrupted = this.aborted || d.aborted === true
        return [interrupted ? { type: 'turn.interrupted', turnId: this.turnId } : { type: 'turn.completed', turnId: this.turnId }]
      }
      case 'session.error': {
        if (this.ended) return []
        this.ended = true
        return [{ type: 'turn.failed', turnId: this.turnId, error: errorFrom(d as { message: string }) }]
      }
      default:
        return []
    }
  }

  private toolStarted(d: Record<string, unknown>): AgentEvent[] {
    const id = str(d.toolCallId)
    const name = str(d.toolName) ?? 'tool'
    if (!id || this.ended || HIDDEN_TOOLS.has(name)) return []
    const args = (d.arguments && typeof d.arguments === 'object' ? d.arguments : {}) as Record<string, unknown>
    const mcp = str(d.mcpServerName)
    const kind = toolKind(name, !!mcp)
    this.tools.set(id, { kind, streamed: false })

    const path = str(args.path) ?? str(args.file_path) ?? str(args.filePath)
    const shown = path ? displayPath(path, this.cwd) : undefined
    const command = str(args.command)
    let title: string
    let input: unknown
    switch (kind) {
      case 'read':
        title = `Read ${shown ?? 'a file'}`
        input = shown
        break
      case 'edit':
        title = `Edit ${shown ?? 'a file'}`
        input = shown
        break
      case 'write':
        title = `Create ${shown ?? 'a file'}`
        input = shown
        break
      case 'shell':
        title = str(args.description) ?? (command ? `Run ${command.split('\n')[0]}` : (str(d.toolTitle) ?? 'Run a command'))
        input = command
        break
      case 'search': {
        const pattern = str(args.pattern) ?? str(args.query)
        title = pattern ? `Search for "${pattern}"${shown ? ` in ${shown}` : ''}` : (str(d.toolTitle) ?? 'Search')
        input = pattern
        break
      }
      case 'web': {
        const target = str(args.url) ?? str(args.query)
        title = target ? `${name === 'web_search' ? 'Search the web for' : 'Fetch'} ${target}` : (str(d.toolTitle) ?? 'Use the web')
        input = target
        break
      }
      case 'mcp':
        title = `${str(d.mcpServerDisplayName) ?? mcp}: ${str(d.mcpToolName) ?? name}`
        input = Object.keys(args).length ? JSON.stringify(args) : undefined
        break
      default:
        title = str(args.description) ?? str(d.toolTitle) ?? name
        input = Object.keys(args).length ? JSON.stringify(args) : undefined
    }
    return [{ type: 'tool.started', id, kind, title, ...(input !== undefined ? { input } : {}) }]
  }

  private toolCompleted(d: Record<string, unknown>): AgentEvent[] {
    const id = str(d.toolCallId)
    const known = id ? this.tools.get(id) : undefined
    if (!id || !known) return []
    this.tools.delete(id)
    const ok = d.success === true
    const result = (d.result as { content?: string } | undefined)?.content
    const error = (d.error as { message?: string } | undefined)?.message

    let diff = this.diffs.get(id)
    this.diffs.delete(id)
    if (!diff && ok && Array.isArray(d.fileEdits)) {
      // No diff came with the question (the agent was allowed to edit without asking): say which files, without the lines.
      diff = (d.fileEdits as { path: string; kind: string }[]).map((f) => ({
        path: displayPath(f.path, this.cwd),
        status: f.kind === 'create' ? 'added' : f.kind === 'delete' ? 'deleted' : 'modified',
        added: 0,
        removed: 0,
        hunks: []
      }))
    }

    let text = ok ? result : (error ?? result)
    // What was read or streamed already shows. A read's content is the file, which the card does not need to repeat.
    if (known.streamed || (ok && known.kind === 'read')) text = ok ? undefined : text
    if (text && text.length > RESULT_LIMIT) text = `${text.slice(0, RESULT_LIMIT)}\n… (cut)`
    return [{ type: 'tool.completed', id, ok, ...(text ? { result: text } : {}), ...(diff?.length ? { diff } : {}) }]
  }
}
