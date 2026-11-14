import type { AgentError, AgentEvent, DiffLine, FileDiff, ToolKind } from '@shared/agent'
import { displayPath } from '../copilot/diff'

/*
 * Gemini's updates (the Agent Client Protocol's `session/update`) to Celeste's events. Pure: it holds only what it must remember
 * between updates (which tool call is which, which was already shown), so it can be tested on recorded turns.
 */

const RESULT_LIMIT = 4000

type Obj = Record<string, unknown>
const obj = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {})
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Gemini's own words for what a call does, as the kinds the timeline knows. */
const KIND: Record<string, ToolKind> = { read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search', execute: 'shell', fetch: 'web', think: 'other', other: 'other' }
export const toolKind = (kind: unknown): ToolKind => KIND[String(kind)] ?? 'other'

/** An error from Gemini or from the program, as the words and kind the window shows. */
export function errorFrom(message: string): AgentError {
  const text = message || 'Gemini reported an error.'
  if (/api key not valid|api_key_invalid|invalid api key|permission denied|unauthori[sz]ed|\b40[13]\b|not connected to gemini/i.test(text)) return { code: 'auth', message: text, retryable: false }
  if (/quota|rate.?limit|resource.?exhausted|too many requests|overloaded|\b429\b|\b503\b/i.test(text)) return { code: 'rate_limit', message: text, retryable: true }
  if (/ECONN|ENOTFOUND|network|timed? ?out|socket|fetch failed|\b5\d\d\b/i.test(text)) return { code: 'network', message: text, retryable: true }
  return { code: 'unknown', message: text, retryable: false }
}

/** How many lines around a change the diff view shows. */
const CONTEXT = 3

/**
 * The change between two texts as hunks the diff view draws. Gemini gives a file's old and new text, not a patch; what is the same
 * at the start and the end is kept as context and what is between is shown as removed and added.
 */
export function diffOfTexts(path: string, oldText: string, newText: string, kind?: string): FileDiff {
  const split = (t: string): string[] => (t ? t.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [])
  const a = kind === 'add' ? [] : split(oldText)
  const b = split(newText)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)
  const before = a.slice(Math.max(0, head - CONTEXT), head)
  const after = a.slice(a.length - tail, a.length - tail + CONTEXT)
  const start = head - before.length
  const lines: DiffLine[] = []
  let oldNo = start + 1
  let newNo = start + 1
  for (const t of before) lines.push({ type: 'ctx', text: t, oldNo: oldNo++, newNo: newNo++ })
  for (const t of removed) lines.push({ type: 'del', text: t, oldNo: oldNo++ })
  for (const t of added) lines.push({ type: 'add', text: t, newNo: newNo++ })
  for (const t of after) lines.push({ type: 'ctx', text: t, oldNo: oldNo++, newNo: newNo++ })
  const status: FileDiff['status'] = kind === 'add' || (a.length === 0 && b.length > 0) ? 'added' : kind === 'delete' || (b.length === 0 && a.length > 0) ? 'deleted' : 'modified'
  const oldCount = before.length + removed.length + after.length
  const newCount = before.length + added.length + after.length
  return {
    path,
    status,
    added: added.length,
    removed: removed.length,
    // Nothing changed: there is nothing to show, not just the lines around where it might have.
    hunks: removed.length || added.length ? [{ header: `@@ -${oldCount ? start + 1 : 0},${oldCount} +${newCount ? start + 1 : 0},${newCount} @@`, lines }] : []
  }
}

interface Known {
  kind: ToolKind
  title: string
}

const clip = (text: string): string => (text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…` : text)

/** The text a tool call's content carries. */
function contentText(content: unknown): string {
  return list(content)
    .map((c) => {
      const inner = obj(obj(c)['content'])
      return obj(c)['type'] === 'content' && inner['type'] === 'text' ? (str(inner['text']) ?? '') : ''
    })
    .filter(Boolean)
    .join('\n')
}

export class Translator {
  private readonly tools = new Map<string, Known>()
  private ended = true
  private turnId = ''
  /** Set while a session is being loaded: Gemini then replays the whole conversation, which Celeste already has. */
  loading = false

  constructor(private cwd?: string) {}

  setCwd(cwd: string | undefined): void {
    this.cwd = cwd
  }

  /** Called when a message is sent. The turn ends with the answer to `session/prompt`, or at a failure. */
  begin(turnId: string): AgentEvent {
    this.ended = false
    this.turnId = turnId
    this.tools.clear()
    return { type: 'turn.started', turnId }
  }

  get running(): boolean {
    return !this.ended
  }

  titleOf(toolCallId: string): string | undefined {
    return this.tools.get(toolCallId)?.title
  }

  /** The turn ended without Gemini saying so: the process stopped, or sending failed. */
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

  /** The answer to `session/prompt`: why Gemini stopped, and what it used. */
  finish(result: Obj): AgentEvent[] {
    if (this.ended) return []
    this.ended = true
    const events: AgentEvent[] = []
    const usage = obj(result['usage'])
    const input = Number(usage['inputTokens'])
    const output = Number(usage['outputTokens'])
    if (Number.isFinite(input) && Number.isFinite(output) && (input || output)) events.push({ type: 'usage.updated', usage: { inputTokens: input, outputTokens: output } })
    switch (result['stopReason']) {
      case 'cancelled':
        return [...events, { type: 'turn.interrupted', turnId: this.turnId }]
      case 'refusal':
        return [...events, { type: 'turn.failed', turnId: this.turnId, error: { code: 'unknown', message: 'Gemini declined to answer that.', retryable: false } }]
      case 'max_tokens':
        return [...events, { type: 'turn.failed', turnId: this.turnId, error: { code: 'unknown', message: 'Gemini ran out of room for its answer.', retryable: false } }]
      case 'max_turn_requests':
        return [...events, { type: 'turn.failed', turnId: this.turnId, error: { code: 'unknown', message: 'Gemini stopped after too many steps in one turn.', retryable: false } }]
      default:
        return [...events, { type: 'turn.completed', turnId: this.turnId }]
    }
  }

  /** One `session/update`'s `update`. */
  handle(update: Obj): AgentEvent[] {
    if (this.ended || this.loading) return []
    switch (update['sessionUpdate']) {
      case 'agent_message_chunk': {
        const text = str(obj(update['content'])['text'])
        // Gemini announces a change of approval mode in the conversation. It is Celeste's own doing, so it is not shown.
        if (text?.startsWith('[MODE_UPDATE]')) return []
        return text ? [{ type: 'message.delta', text }] : []
      }
      case 'agent_thought_chunk': {
        const text = str(obj(update['content'])['text'])
        return text ? [{ type: 'thinking.delta', text }] : []
      }
      case 'tool_call':
        return this.started(update)
      case 'tool_call_update':
        return this.updated(update)
      default:
        return []
    }
  }

  private started(update: Obj): AgentEvent[] {
    const id = str(update['toolCallId'])
    if (!id || this.tools.has(id)) return id ? this.updated(update) : []
    const diff = list(update['content']).map(obj).find((c) => c['type'] === 'diff')
    const adds = diff !== undefined && obj(diff['_meta'])['kind'] === 'add'
    const kind = update['kind'] === 'edit' && adds ? 'write' : toolKind(update['kind'])
    // A call the agent makes only to think or to switch its own mode is not something the person did anything about.
    if (update['kind'] === 'think' || update['kind'] === 'switch_mode') return []
    const title = str(update['title']) ?? 'Tool'
    this.tools.set(id, { kind, title })
    const raw = update['rawInput']
    return [{ type: 'tool.started', id, kind, title, ...(raw !== undefined ? { input: raw } : {}) }]
  }

  private updated(update: Obj): AgentEvent[] {
    const id = str(update['toolCallId'])
    const known = id ? this.tools.get(id) : undefined
    if (!id || !known) return []
    const status = str(update['status'])
    if (status !== 'completed' && status !== 'failed') {
      const text = contentText(update['content'])
      return text && status === 'in_progress' ? [{ type: 'tool.output', id, text }] : []
    }
    this.tools.delete(id)
    const ok = status === 'completed'
    const text = contentText(update['content'])
    const diffs = ok
      ? list(update['content'])
          .map(obj)
          .filter((c) => c['type'] === 'diff')
          .map((c) => diffOfTexts(displayPath(str(c['path']) ?? 'file', this.cwd), str(c['oldText']) ?? '', str(c['newText']) ?? '', str(obj(c['_meta'])['kind'])))
      : []
    return [{ type: 'tool.completed', id, ok, ...(text ? { result: clip(text) } : {}), ...(diffs.length ? { diff: diffs } : {}) }]
  }
}
