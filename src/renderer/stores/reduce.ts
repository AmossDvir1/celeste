import type { AskAnswers, ToolKind } from '@shared/agent'
import type { LogEvent, StoredEvent } from '@shared/api'
import { basename } from '@/lib/format'
import type { Activity, Session, TimelineItem } from './types'

let counter = 0
export const itemId = (): string => `i${Date.now().toString(36)}${(counter++).toString(36)}`

/** The shimmering line while a tool runs, for example "Reading auth.ts". */
export function activityLabel(kind: ToolKind, title: string): string {
  const short = (t: string, n = 38) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
  switch (kind) {
    case 'read':
      return `Reading ${basename(title.replace(/^Read\s+/, ''))}`
    case 'edit':
      return 'Editing files'
    case 'write':
      return 'Creating a file'
    case 'shell':
      return `Running ${short(title)}`
    case 'web':
      return /fetch|read/i.test(title) ? 'Reading a web page' : 'Searching the web'
    case 'search':
      return 'Searching the project'
    case 'mcp':
      return `Calling ${short(title.split('·')[0].trim(), 26)}`
    case 'agent':
      return 'Working with a helper'
    default:
      return 'Working'
  }
}

const THINKING: Activity = { label: 'Thinking', working: true }

function closeThinking(items: TimelineItem[], now: number): TimelineItem[] {
  const last = items[items.length - 1]
  if (last?.kind === 'thinking' && last.endedAt === undefined) {
    return [...items.slice(0, -1), { ...last, endedAt: now }]
  }
  return items
}

function failRunningTools(items: TimelineItem[], now: number): TimelineItem[] {
  return items.map((it) => (it.kind === 'tool' && it.status === 'running' ? { ...it, status: 'failed', endedAt: now } : it))
}

/** Applies one logged event, which happened at time `at`, to a session. Pure: returns a new session. */
export function reduceEvent(s: Session, e: LogEvent, at: number): Session {
  const now = at
  switch (e.type) {
    case 'user.message':
      return { ...s, items: [...s.items, { kind: 'user', id: itemId(), text: e.text, attachments: e.attachments, ...(e.context?.length ? { context: e.context } : {}), at: now }], updatedAt: now }

    case 'checkpoint.created': {
      // It is written right after the message it belongs to.
      const at = s.items.map((it) => it.kind).lastIndexOf('user')
      if (at < 0) return s
      return { ...s, items: s.items.map((it, i) => (i === at && it.kind === 'user' ? { ...it, checkpoint: { id: e.id } } : it)) }
    }

    case 'checkpoint.summary':
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'user' && it.checkpoint?.id === e.id ? { ...it, checkpoint: { id: e.id, files: e.files, more: e.more } } : it))
      }

    case 'workflow.started':
      return { ...s, items: [...s.items, { kind: 'workflow', id: itemId(), runId: e.runId, workflowId: e.workflowId, name: e.name }] }

    // The card already shows how it ended: it reads the run itself.
    case 'workflow.finished':
      return s

    case 'desktop.started':
      return { ...s, items: [...s.items, { kind: 'desktop', id: itemId(), grantId: e.grantId, reason: e.reason, until: e.until, ...(e.where ? { where: e.where } : {}), actions: [] }] }

    case 'desktop.action':
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === 'desktop' && it.grantId === e.grantId ? { ...it, until: e.until ?? it.until, actions: e.until ? it.actions : [...it.actions, { text: e.text, ok: e.ok, note: e.note }] } : it
        )
      }

    case 'desktop.ended':
      return { ...s, items: s.items.map((it) => (it.kind === 'desktop' && it.grantId === e.grantId ? { ...it, ended: { why: e.why, actions: e.actions } } : it)) }

    case 'files.produced':
      return { ...s, items: [...s.items, { kind: 'files', id: itemId(), files: e.files, more: e.more }] }

    case 'checkpoint.skipped':
      return { ...s, items: [...s.items, { kind: 'notice', id: itemId(), text: `Celeste could not save the folder before this message, so it cannot be reverted. ${e.reason}` }] }

    case 'checkpoint.reverted':
      return { ...s, items: [...s.items, { kind: 'reverted', id: itemId(), restored: e.restored, removed: e.removed, undoId: e.undoId }], updatedAt: now }

    case 'approval.resolved':
      return resolveApproval(s, e.requestId, e.allow)

    case 'ask.answered':
      return resolveAsk(s, e.requestId, e.answers)

    case 'turn.abandoned':
      return {
        ...s,
        items: [
          ...failRunningTools(closeThinking(s.items, now), now),
          { kind: 'notice', id: itemId(), text: 'Celeste was closed while this was running. Send a message to continue.' }
        ],
        status: 'idle',
        activity: null,
        updatedAt: now
      }

    case 'turn.started':
      return { ...s, status: 'working', activity: THINKING, updatedAt: now }

    case 'thinking.delta': {
      const last = s.items[s.items.length - 1]
      const items: TimelineItem[] =
        last?.kind === 'thinking' && last.endedAt === undefined
          ? [...s.items.slice(0, -1), { ...last, text: last.text + e.text }]
          : [...s.items, { kind: 'thinking', id: itemId(), text: e.text, startedAt: now }]
      return { ...s, items, status: 'working', activity: THINKING }
    }

    case 'message.delta': {
      const base = closeThinking(s.items, now)
      const last = base[base.length - 1]
      const items: TimelineItem[] =
        last?.kind === 'assistant'
          ? [...base.slice(0, -1), { ...last, text: last.text + e.text }]
          : [...base, { kind: 'assistant', id: itemId(), text: e.text }]
      return { ...s, items, status: 'working', activity: { label: 'Writing', working: true }, updatedAt: now }
    }

    case 'tool.started': {
      const items = [
        ...closeThinking(s.items, now),
        {
          kind: 'tool' as const,
          id: e.id,
          tool: e.kind,
          title: e.title,
          input: typeof e.input === 'string' ? e.input : undefined,
          output: '',
          status: 'running' as const,
          startedAt: now
        }
      ]
      return { ...s, items, status: 'working', activity: { label: activityLabel(e.kind, e.title), working: true } }
    }

    case 'tool.output':
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'tool' && it.id === e.id ? { ...it, output: it.output + e.text } : it))
      }

    case 'tool.completed':
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === 'tool' && it.id === e.id
            ? { ...it, status: e.ok ? 'ok' : 'failed', endedAt: now, diff: e.diff ?? it.diff, output: it.output || e.result || '' }
            : it
        ),
        activity: THINKING
      }

    case 'approval.requested':
      return {
        ...s,
        items: [
          ...closeThinking(s.items, now),
          { kind: 'approval', id: itemId(), requestId: e.requestId, tool: e.kind, title: e.title, detail: e.detail, status: 'pending' }
        ],
        status: 'waiting',
        activity: { label: 'Waiting for your approval', working: false }
      }

    case 'ask_user.requested':
      return {
        ...s,
        items: [
          ...closeThinking(s.items, now),
          { kind: 'ask', id: itemId(), requestId: e.requestId, questions: e.questions, status: 'pending' }
        ],
        status: 'waiting',
        activity: { label: 'Waiting for your answer', working: false }
      }

    case 'usage.updated':
      return s

    case 'turn.completed':
      return { ...s, items: closeThinking(s.items, now), status: 'idle', activity: null, updatedAt: now }

    case 'turn.interrupted':
      // Tools that were still running stopped with it: none is left spinning under "You stopped this response".
      return {
        ...s,
        items: [...failRunningTools(closeThinking(s.items, now), now), { kind: 'notice', id: itemId(), text: 'You stopped this response.' }],
        status: 'idle',
        activity: null,
        updatedAt: now
      }

    case 'turn.failed':
      return {
        ...s,
        items: [...closeThinking(s.items, now), { kind: 'error', id: itemId(), error: e.error }],
        status: 'idle',
        activity: null,
        updatedAt: now
      }
  }
}

/** The user answered an approval card: mark it and go back to working. */
export function resolveApproval(s: Session, requestId: string, allow: boolean): Session {
  return {
    ...s,
    items: s.items.map((it) =>
      it.kind === 'approval' && it.requestId === requestId ? { ...it, status: allow ? 'allowed' : 'denied' } : it
    ),
    status: 'working',
    activity: THINKING
  }
}

/** The user answered an ask_user card. */
export function resolveAsk(s: Session, requestId: string, answers: AskAnswers): Session {
  return {
    ...s,
    items: s.items.map((it) => (it.kind === 'ask' && it.requestId === requestId ? { ...it, answers, status: 'answered' } : it)),
    status: 'working',
    activity: THINKING
  }
}

/**
 * Replays stored events into a session, skipping any it has already seen. Opening a session replays its
 * whole log, and live events are replayed the same way, so the screen can never differ from the record.
 */
export function foldEvents(s: Session, events: StoredEvent[]): Session {
  let next = s
  for (const { seq, at, event } of events) {
    if (seq <= next.foldedSeq) continue
    next = { ...reduceEvent(next, event, at), updatedAt: at, foldedSeq: seq, lastSeq: Math.max(next.lastSeq, seq) }
  }
  return next
}
