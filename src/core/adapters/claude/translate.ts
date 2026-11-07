import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentError, AgentEvent, DiffLine, FileDiff, ToolKind } from '@shared/agent'
import { displayPath } from '../copilot/diff'
import { HIDDEN_TOOLS, toolKind } from './permissions'

/*
 * Claude's messages to Celeste's events. Pure: it holds only what it must remember between messages (which tool
 * call is which, which messages were already streamed), so it can be tested on recorded turns. Text and thinking
 * come from the stream events as they happen; tool calls and their results come from the whole messages.
 */

/** The most of a tool's result kept as its output. The agent still sees all of it. */
const RESULT_LIMIT = 4000

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})

/** An error Claude attached to its own message, or the words of a failed result. */
export function errorFrom(code: string | undefined, message: string): AgentError {
  const text = message || 'Claude reported an error.'
  if (code === 'authentication_failed' || code === 'oauth_org_not_allowed' || /invalid api key|not logged in|please run \/login|authenticat|unauthori[sz]ed|\b401\b/i.test(text)) {
    return { code: 'auth', message: text, retryable: false }
  }
  if (code === 'rate_limit' || /rate limit|overloaded|too many requests|\b429\b|usage limit/i.test(text)) return { code: 'rate_limit', message: text, retryable: true }
  if (code === 'server_error' || /ECONN|ENOTFOUND|network|timed? ?out|socket|\b5\d\d\b/i.test(text)) return { code: 'network', message: text, retryable: true }
  return { code: 'unknown', message: text, retryable: false }
}

interface Known {
  name: string
  kind: ToolKind
  input: Record<string, unknown>
}

/** The text of a tool result, whichever shape it came in. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (obj(b)['type'] === 'text' ? (str(obj(b)['text']) ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

function lineOf(raw: string, oldNo: number, newNo: number): DiffLine {
  const sign = raw[0]
  const text = raw.slice(1)
  if (sign === '+') return { type: 'add', text, newNo }
  if (sign === '-') return { type: 'del', text, oldNo }
  return { type: 'ctx', text, oldNo, newNo }
}

/** The change Claude reports for an edit (its `structuredPatch`), as a diff to show. */
function diffFromPatch(path: string, patches: unknown[], isNew: boolean): FileDiff | undefined {
  const hunks = patches.flatMap((p) => {
    const h = obj(p)
    const lines = Array.isArray(h['lines']) ? (h['lines'] as unknown[]).filter((l): l is string => typeof l === 'string') : []
    if (!lines.length) return []
    let oldNo = Number(h['oldStart']) || 1
    let newNo = Number(h['newStart']) || 1
    const out: DiffLine[] = lines.map((raw) => {
      const line = lineOf(raw, oldNo, newNo)
      if (line.type !== 'add') oldNo++
      if (line.type !== 'del') newNo++
      return line
    })
    return [{ header: `@@ -${h['oldStart']},${h['oldLines']} +${h['newStart']},${h['newLines']} @@`, lines: out }]
  })
  if (!hunks.length) return undefined
  const all = hunks.flatMap((h) => h.lines)
  return {
    path,
    status: isNew ? 'added' : 'modified',
    added: all.filter((l) => l.type === 'add').length,
    removed: all.filter((l) => l.type === 'del').length,
    hunks
  }
}

/** The change an edit asked for, worked out from the call itself, for when Claude gave no patch. */
function diffFromInput(name: string, path: string, input: Record<string, unknown>): FileDiff | undefined {
  const lines = (text: string): string[] => (text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [])
  if (name === 'Write') {
    const added = lines(str(input['content']) ?? '')
    return {
      path,
      status: 'added',
      added: added.length,
      removed: 0,
      hunks: [{ header: `@@ -0,0 +1,${added.length} @@`, lines: added.map((t, i) => ({ type: 'add', text: t, newNo: i + 1 })) }]
    }
  }
  if (name === 'Edit') {
    const del = lines(str(input['old_string']) ?? '')
    const add = lines(str(input['new_string']) ?? '')
    if (!del.length && !add.length) return undefined
    return {
      path,
      status: 'modified',
      added: add.length,
      removed: del.length,
      hunks: [{ header: `@@ -1,${del.length} +1,${add.length} @@`, lines: [...del.map((t, i): DiffLine => ({ type: 'del', text: t, oldNo: i + 1 })), ...add.map((t, i): DiffLine => ({ type: 'add', text: t, newNo: i + 1 }))] }]
    }
  }
  return undefined
}

export class Translator {
  private readonly tools = new Map<string, Known>()
  private readonly streamed = new Set<string>()
  private ended = true
  private turnId = ''
  private lastError: { code?: string; text?: string } = {}
  sessionId: string | undefined

  constructor(private cwd?: string) {}

  setCwd(cwd: string | undefined): void {
    this.cwd = cwd
  }

  /** Called when a message is sent. The turn ends at its result, or at a failure. */
  begin(turnId: string): AgentEvent {
    this.ended = false
    this.turnId = turnId
    this.streamed.clear()
    this.lastError = {}
    return { type: 'turn.started', turnId }
  }

  /** The turn ended without a result: the process stopped, or sending failed. */
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

  /** Whether a turn is running, as far as the messages so far say. */
  get running(): boolean {
    return !this.ended
  }

  handle(message: SDKMessage): AgentEvent[] {
    const m = message as unknown as Record<string, unknown>
    // What a subagent says and does inside its own run is not part of the conversation. Its parent call stands for it.
    if (m['parent_tool_use_id']) return []
    switch (m['type']) {
      case 'system': {
        if (m['subtype'] === 'init' && str(m['session_id'])) this.sessionId = m['session_id'] as string
        return []
      }
      case 'stream_event':
        return this.stream(obj(m['event']))
      case 'assistant':
        return this.assistant(m)
      case 'user':
        return this.user(m)
      case 'result':
        return this.result(m)
      default:
        return []
    }
  }

  private stream(e: Record<string, unknown>): AgentEvent[] {
    if (this.ended) return []
    if (e['type'] === 'message_start') {
      const id = str(obj(e['message'])['id'])
      if (id) this.streamed.add(id)
      return []
    }
    if (e['type'] !== 'content_block_delta') return []
    const delta = obj(e['delta'])
    if (delta['type'] === 'text_delta' && str(delta['text'])) return [{ type: 'message.delta', text: delta['text'] as string }]
    if (delta['type'] === 'thinking_delta' && str(delta['thinking'])) return [{ type: 'thinking.delta', text: delta['thinking'] as string }]
    return []
  }

  private assistant(m: Record<string, unknown>): AgentEvent[] {
    if (this.ended) return []
    const message = obj(m['message'])
    if (str(m['error'])) this.lastError = { code: m['error'] as string }
    const out: AgentEvent[] = []
    const streamedAlready = this.streamed.has(str(message['id']) ?? '\0')
    for (const raw of Array.isArray(message['content']) ? (message['content'] as unknown[]) : []) {
      const block = obj(raw)
      if (block['type'] === 'text' && str(block['text'])) {
        if (this.lastError.code && !this.lastError.text) this.lastError.text = block['text'] as string
        // Without streaming, the whole text arrives here.
        if (!streamedAlready) out.push({ type: 'message.delta', text: block['text'] as string })
      } else if (block['type'] === 'thinking' && str(block['thinking']) && !streamedAlready) {
        out.push({ type: 'thinking.delta', text: block['thinking'] as string })
      } else if (block['type'] === 'tool_use') {
        const name = str(block['name']) ?? 'tool'
        const id = str(block['id'])
        if (!id || HIDDEN_TOOLS.has(name)) continue
        const input = obj(block['input'])
        const kind = toolKind(name)
        this.tools.set(id, { name, kind, input })
        out.push({ type: 'tool.started', id, kind, title: this.title(name, input), input })
      }
    }
    return out
  }

  /** A short line for the tool, as the timeline shows it. */
  private title(name: string, input: Record<string, unknown>): string {
    const path = str(input['file_path']) ?? str(input['notebook_path']) ?? str(input['path'])
    const shown = path ? displayPath(path, this.cwd) : undefined
    switch (name) {
      case 'Read':
      case 'NotebookRead':
        return `Read ${shown ?? 'a file'}`
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return `Edit ${shown ?? 'a file'}`
      case 'Write':
        return `Write ${shown ?? 'a file'}`
      case 'Bash':
      case 'PowerShell':
        return str(input['description']) ?? str(input['command']) ?? 'Run a command'
      case 'Glob':
      case 'Grep':
        return `Search for ${str(input['pattern']) ?? 'files'}`
      case 'WebFetch':
        return `Fetch ${str(input['url']) ?? 'a page'}`
      case 'WebSearch':
        return `Search the web for ${str(input['query']) ?? 'something'}`
      case 'Task':
      case 'Agent':
        return str(input['description']) ?? 'Run a subagent'
      default:
        return name.startsWith('mcp__') ? name.replace(/^mcp__/, '').replace('__', ': ') : name
    }
  }

  private user(m: Record<string, unknown>): AgentEvent[] {
    if (this.ended) return []
    const content = obj(m['message'])['content']
    if (!Array.isArray(content)) return []
    const out: AgentEvent[] = []
    for (const raw of content) {
      const block = obj(raw)
      if (block['type'] !== 'tool_result') continue
      const id = str(block['tool_use_id'])
      const known = id ? this.tools.get(id) : undefined
      if (!id || !known) continue
      this.tools.delete(id)
      const ok = block['is_error'] !== true
      const text = resultText(block['content'])
      const diff = ok ? this.diff(known, obj(m['tool_use_result'])) : undefined
      out.push({
        type: 'tool.completed',
        id,
        ok,
        ...(text ? { result: text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…` : text } : {}),
        ...(diff ? { diff: [diff] } : {})
      })
    }
    return out
  }

  private diff(known: Known, result: Record<string, unknown>): FileDiff | undefined {
    if (known.kind !== 'edit' && known.kind !== 'write') return undefined
    const raw = str(known.input['file_path']) ?? str(known.input['notebook_path'])
    if (!raw) return undefined
    const path = displayPath(raw, this.cwd)
    const patch = Array.isArray(result['structuredPatch']) ? (result['structuredPatch'] as unknown[]) : []
    return diffFromPatch(path, patch, result['type'] === 'create') ?? diffFromInput(known.name, path, known.input)
  }

  private result(m: Record<string, unknown>): AgentEvent[] {
    if (this.ended) return []
    this.ended = true
    const usage = obj(m['usage'])
    const events: AgentEvent[] = []
    const input = Number(usage['input_tokens'])
    const output = Number(usage['output_tokens'])
    if (Number.isFinite(input) && Number.isFinite(output)) events.push({ type: 'usage.updated', usage: { inputTokens: input, outputTokens: output } })
    const failed = m['is_error'] === true || (str(m['subtype']) ?? 'success') !== 'success'
    if (!failed) return [...events, { type: 'turn.completed', turnId: this.turnId }]
    const words = str(m['result']) ?? (Array.isArray(m['errors']) ? (m['errors'] as unknown[]).filter((e): e is string => typeof e === 'string').join(' ') : '') ?? ''
    return [...events, { type: 'turn.failed', turnId: this.turnId, error: errorFrom(this.lastError.code, words || this.lastError.text || '') }]
  }
}
