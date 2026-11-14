import type { AgentError, AgentEvent, DiffLine, FileDiff, ToolKind } from '@shared/agent'
import { displayPath, parseUnifiedDiff } from '../copilot/diff'

/*
 * Codex's notifications to Celeste's events. Pure: it holds only what it must remember between notifications (which item is
 * which, which texts were already streamed), so it can be tested on recorded turns.
 */

const RESULT_LIMIT = 4000

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {})
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Codex's error, as the words and kind the window shows. */
export function errorFrom(info: unknown, message: string): AgentError {
  const text = message || 'OpenAI reported an error.'
  const name = typeof info === 'string' ? info : Object.keys(obj(info))[0]
  if (/subscription_sharing|usage limit|usage_limit/i.test(text) || name === 'usageLimitExceeded') {
    return { code: 'rate_limit', message: 'Your ChatGPT plan’s usage limit has been reached. It comes back when the limit resets, or you can raise it in ChatGPT’s usage settings.', retryable: false }
  }
  if (name === 'unauthorized' || /unauthori[sz]ed|invalid api key|incorrect api key|\b401\b|sign in again|not signed in/i.test(text)) return { code: 'auth', message: text, retryable: false }
  if (name === 'rateLimitExceeded' || name === 'serverOverloaded' || name === 'flexUnavailable' || /rate limit|overloaded|too many requests|\b429\b/i.test(text)) return { code: 'rate_limit', message: text, retryable: true }
  if (name === 'httpConnectionFailed' || name === 'responseStreamConnectionFailed' || name === 'responseStreamDisconnected' || name === 'responseTooManyFailedAttempts' || name === 'internalServerError' || /ECONN|ENOTFOUND|network|timed? ?out|socket|\b5\d\d\b/i.test(text)) {
    return { code: 'network', message: text, retryable: true }
  }
  return { code: 'unknown', message: text, retryable: false }
}

function allLines(text: string, type: 'add' | 'del'): DiffLine[] {
  const lines = text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
  return lines.map((t, i) => (type === 'add' ? { type, text: t, newNo: i + 1 } : { type, text: t, oldNo: i + 1 }))
}

/** The diff view's form of what Codex changed in one file. */
export function diffOf(change: Obj, cwd?: string): FileDiff {
  const path = displayPath(str(change['path']) ?? 'file', cwd)
  const kind = str(obj(change['kind'])['type']) ?? 'update'
  const text = str(change['diff']) ?? ''
  if (/^@@ /m.test(text)) {
    const parsed = parseUnifiedDiff(text, path)
    return { ...parsed, status: kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : parsed.status }
  }
  // An added or deleted file comes as its whole content, not as a patch.
  const lines = allLines(text, kind === 'delete' ? 'del' : 'add')
  const header = kind === 'delete' ? `@@ -1,${lines.length} +0,0 @@` : `@@ -0,0 +1,${lines.length} @@`
  return {
    path,
    status: kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : 'modified',
    added: kind === 'delete' ? 0 : lines.length,
    removed: kind === 'delete' ? lines.length : 0,
    hunks: lines.length ? [{ header, lines }] : []
  }
}

const clip = (text: string): string => (text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…` : text)

function mcpResultText(item: Obj): string {
  const error = str(obj(item['error'])['message'])
  if (error) return error
  const content = list(obj(item['result'])['content'])
  return content
    .map((c) => (obj(c)['type'] === 'text' ? (str(obj(c)['text']) ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

export class Translator {
  private readonly items = new Map<string, { kind: ToolKind; title: string }>()
  private readonly streamed = new Set<string>()
  private ended = true
  private turnId = ''
  private sawMessage = false
  private usage = { inputTokens: 0, outputTokens: 0 }
  private lastError: { info?: unknown; message?: string } = {}
  /** Codex's own id for the turn that is running, for interrupting it. */
  codexTurnId: string | undefined

  constructor(private cwd?: string) {}

  setCwd(cwd: string | undefined): void {
    this.cwd = cwd
  }

  /** Called when a message is sent. The turn ends at `turn/completed`, or at a failure. */
  begin(turnId: string): AgentEvent {
    this.ended = false
    this.turnId = turnId
    this.codexTurnId = undefined
    this.streamed.clear()
    this.sawMessage = false
    this.usage = { inputTokens: 0, outputTokens: 0 }
    this.lastError = {}
    return { type: 'turn.started', turnId }
  }

  get running(): boolean {
    return !this.ended
  }

  /** What an item that is running is doing, as the timeline shows it. For the question that asks to allow it. */
  titleOf(itemId: string): string | undefined {
    return this.items.get(itemId)?.title
  }

  /** The turn ended without Codex saying so: the process stopped, or sending failed. */
  fail(error: AgentError): AgentEvent[] {
    if (this.ended) return []
    this.ended = true
    return [{ type: 'turn.failed', turnId: this.turnId, error }]
  }

  interrupted(): AgentEvent[] {
    if (this.ended) return []
    this.ended = true
    return [{ type: 'turn.interrupted', turnId: this.turnId }]
  }

  handle(method: string, params: Obj): AgentEvent[] {
    if (this.ended) return []
    // What belongs to another turn (the one that was stopped, still winding down) is not this turn's.
    const turn = str(params['turnId']) ?? str(obj(params['turn'])['id'])
    if (turn && this.codexTurnId && turn !== this.codexTurnId) return []
    switch (method) {
      case 'turn/started':
        this.codexTurnId = str(obj(params['turn'])['id']) ?? this.codexTurnId
        return []
      case 'item/started':
        return this.started(obj(params['item']))
      case 'item/completed':
        return this.completed(obj(params['item']))
      case 'item/agentMessage/delta': {
        const id = str(params['itemId'])
        const text = str(params['delta'])
        if (!text) return []
        if (id) this.streamed.add(id)
        this.sawMessage = true
        return [{ type: 'message.delta', text }]
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const id = str(params['itemId'])
        const text = str(params['delta'])
        if (!text) return []
        if (id) this.streamed.add(id)
        return [{ type: 'thinking.delta', text }]
      }
      case 'item/commandExecution/outputDelta': {
        const id = str(params['itemId'])
        const text = str(params['delta'])
        return id && text && this.items.has(id) ? [{ type: 'tool.output', id, text }] : []
      }
      case 'thread/tokenUsage/updated': {
        const last = obj(obj(params['tokenUsage'])['last'])
        this.usage.inputTokens += num(last['inputTokens'])
        this.usage.outputTokens += num(last['outputTokens'])
        return []
      }
      case 'error': {
        // An error Codex is going to retry is not the turn's failure.
        if (params['willRetry'] === true) return []
        const e = obj(params['error'])
        this.lastError = { info: e['codexErrorInfo'], message: str(e['message']) }
        return []
      }
      case 'turn/completed':
        return this.finish(obj(params['turn']))
      default:
        return []
    }
  }

  private title(item: Obj): { kind: ToolKind; title: string; input?: unknown } | undefined {
    switch (item['type']) {
      case 'commandExecution': {
        const command = str(item['command']) ?? 'Run a command'
        return { kind: 'shell', title: command.length > 140 ? `${command.slice(0, 140)}…` : command, input: { command } }
      }
      case 'fileChange': {
        const changes = list(item['changes']).map(obj)
        const paths = changes.map((c) => displayPath(str(c['path']) ?? 'file', this.cwd))
        const adds = changes.length > 0 && changes.every((c) => obj(c['kind'])['type'] === 'add')
        const title = paths.length === 1 ? `${adds ? 'Write' : 'Edit'} ${paths[0]}` : paths.length > 1 ? `Edit ${paths.length} files` : 'Edit files'
        return { kind: adds ? 'write' : 'edit', title }
      }
      case 'mcpToolCall':
        return { kind: 'mcp', title: `${str(item['server']) ?? 'tool'}: ${str(item['tool']) ?? 'call'}`, input: item['arguments'] }
      case 'dynamicToolCall':
        return { kind: 'other', title: str(item['tool']) ?? 'Tool', input: item['arguments'] }
      case 'webSearch':
        return { kind: 'web', title: str(item['query']) ? `Search the web for ${str(item['query'])}` : 'Search the web' }
      case 'imageView':
        return { kind: 'read', title: `View ${displayPath(str(item['path']) ?? 'an image', this.cwd)}` }
      case 'collabAgentToolCall':
      case 'subAgentActivity':
        return { kind: 'agent', title: 'Run an agent' }
      default:
        return undefined
    }
  }

  private started(item: Obj): AgentEvent[] {
    const id = str(item['id'])
    if (!id) return []
    if (item['type'] === 'agentMessage') {
      // A second message in the turn (after tools) must not run into the first.
      return this.sawMessage ? [{ type: 'message.delta', text: '\n\n' }] : []
    }
    const t = this.title(item)
    if (!t) return []
    this.items.set(id, { kind: t.kind, title: t.title })
    return [{ type: 'tool.started', id, kind: t.kind, title: t.title, ...(t.input !== undefined ? { input: t.input } : {}) }]
  }

  private completed(item: Obj): AgentEvent[] {
    const id = str(item['id'])
    if (!id) return []
    const type = item['type']
    if (type === 'agentMessage') {
      const text = str(item['text'])
      if (this.streamed.has(id) || !text) return []
      this.sawMessage = true
      return [{ type: 'message.delta', text }]
    }
    if (type === 'reasoning') {
      if (this.streamed.has(id)) return []
      const text = [...list(item['summary']), ...list(item['content'])].filter((s): s is string => typeof s === 'string' && s.length > 0).join('\n\n')
      return text ? [{ type: 'thinking.delta', text }] : []
    }
    if (!this.items.has(id)) return []
    this.items.delete(id)
    switch (type) {
      case 'commandExecution': {
        const status = str(item['status'])
        const out = str(item['aggregatedOutput'])
        const code = typeof item['exitCode'] === 'number' ? (item['exitCode'] as number) : 0
        const ok = status === 'completed' && code === 0
        const result = out ?? (status === 'declined' ? 'Declined.' : undefined)
        return [{ type: 'tool.completed', id, ok, ...(result ? { result: clip(result) } : {}) }]
      }
      case 'fileChange': {
        const status = str(item['status'])
        const ok = status === 'completed'
        const diff = ok ? list(item['changes']).map((c) => diffOf(obj(c), this.cwd)) : []
        return [{ type: 'tool.completed', id, ok, ...(status === 'declined' ? { result: 'Declined.' } : {}), ...(diff.length ? { diff } : {}) }]
      }
      case 'mcpToolCall': {
        const ok = item['status'] === 'completed' && !item['error']
        const text = mcpResultText(item)
        return [{ type: 'tool.completed', id, ok, ...(text ? { result: clip(text) } : {}) }]
      }
      case 'dynamicToolCall':
        return [{ type: 'tool.completed', id, ok: item['success'] !== false }]
      default:
        return [{ type: 'tool.completed', id, ok: true }]
    }
  }

  private finish(turn: Obj): AgentEvent[] {
    this.ended = true
    const events: AgentEvent[] = []
    if (this.usage.inputTokens || this.usage.outputTokens) events.push({ type: 'usage.updated', usage: { ...this.usage } })
    const status = str(turn['status'])
    if (status === 'interrupted') return [...events, { type: 'turn.interrupted', turnId: this.turnId }]
    if (status === 'failed') {
      const e = obj(turn['error'])
      const message = str(e['message']) ?? this.lastError.message ?? ''
      return [...events, { type: 'turn.failed', turnId: this.turnId, error: errorFrom(e['codexErrorInfo'] ?? this.lastError.info, message) }]
    }
    return [...events, { type: 'turn.completed', turnId: this.turnId }]
  }
}
