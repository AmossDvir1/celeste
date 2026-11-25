import type { AskAnswers, ToolKind } from '@shared/agent'
import type { LogEvent, StoredEvent } from '@shared/api'
import { moonName, type MoonStep } from '@shared/moons'
import { movesSession } from '@shared/status'
import { foldQueue } from '@shared/queue'
import { limitNotice } from '@shared/usage'
import { basename } from '@/lib/format'
import type { Activity, MoonsMessage, Session, TimelineItem } from './types'

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

/** What a moon is doing, as the line under the conversation says it: "Reviewer is checking the change". */
const STEP_WORDS: Record<MoonStep, string> = {
  build: 'is building',
  review: 'is checking the change',
  fix: 'is fixing the notes',
  check: 'is checking the fixes',
  plan: 'is writing the plan',
  test: 'is trying to make it happen',
  retest: 'is trying it again',
  compare: 'is comparing the two reviews',
  answer: 'is answering'
}

function moonsActivity(s: Session, seat: 0 | 1, step: MoonStep): Activity {
  return { label: s.moons ? `${moonName(s.moons.pattern, seat)} ${STEP_WORDS[step]}` : 'Working together', working: true }
}

/** The run is over (or was cut off): nobody's turn any more. A session that never had one stays exactly as it was. */
function noMoonsTurn(s: Session): Session {
  if (s.moonsTurn === undefined) return s
  const { moonsTurn: _turn, ...rest } = s
  return rest
}

/** A message was sent into the chat: the assistant has now been told of the helpers that ended before it. */
function tellHelpers(s: Session): Session {
  if (!s.items.some((it) => it.kind === 'helper' && it.finished?.delivered === 'note' && !it.told)) return s
  return { ...s, items: s.items.map((it) => (it.kind === 'helper' && it.finished?.delivered === 'note' && !it.told ? { ...it, told: true } : it)) }
}

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
    case 'user.message': {
      // A note from Celeste that woke the assistant is one quiet line, not a message of the person's.
      if (e.from === 'celeste') {
        return { ...tellHelpers(s), items: [...tellHelpers(s).items, { kind: 'notice', id: itemId(), text: `${e.text} The assistant was told.` }] }
      }
      const base = tellHelpers(s)
      // What Celeste told the pen for the other moon is never drawn: the cards of the run show it.
      if (e.from === 'moon') return base
      return { ...base, items: [...base.items, { kind: 'user', id: itemId(), text: e.text, attachments: e.attachments, ...(e.context?.length ? { context: e.context } : {}), ...(e.from === 'parent' ? { from: 'parent' as const } : {}), at: now }] }
    }

    case 'child.spawned':
      return { ...s, items: [...s.items, { kind: 'spawned', id: itemId(), parentId: e.parentId, parentTitle: e.parentTitle }] }

    case 'child.started': {
      const known = s.items.some((it) => it.kind === 'helper' && it.childId === e.childId)
      // More work for a helper the card is already there for: the card gets a line and is open again.
      if (known) {
        return {
          ...s,
          items: s.items.map((it) => {
            if (it.kind !== 'helper' || it.childId !== e.childId) return it
            const { finished: _finished, told: _told, ...rest } = it
            return { ...rest, tasks: [...it.tasks, e.task], wait: e.wait, startedAt: now }
          })
        }
      }
      return { ...s, items: [...s.items, { kind: 'helper', id: itemId(), childId: e.childId, title: e.title, vendor: e.vendor, model: e.model, folder: e.folder, tasks: [e.task], wait: e.wait, startedAt: now }] }
    }

    case 'child.finished':
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === 'helper' && it.childId === e.childId
            ? { ...it, title: e.title, finished: { status: e.status, ...(e.result !== undefined ? { result: e.result } : {}), ...(e.error !== undefined ? { error: e.error } : {}), delivered: e.delivered, endedAt: now } }
            : it
        )
      }

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

    case 'queue.added':
    case 'queue.edited':
    case 'queue.removed':
    case 'queue.sent':
    case 'queue.paused':
    case 'queue.resumed':
    case 'queue.waiting':
      return { ...s, queue: foldQueue(s.queue, e) }

    case 'checkpoint.skipped':
      return { ...s, items: [...s.items, { kind: 'notice', id: itemId(), text: `Celeste could not save the folder before this message, so it cannot be reverted. ${e.reason}` }] }

    case 'limit.hit':
      return { ...s, items: [...s.items, { kind: 'notice', id: itemId(), text: limitNotice(e, now) }] }

    case 'app.changed':
      return { ...s, items: [...s.items, { kind: 'notice', id: itemId(), text: e.text }] }

    case 'checkpoint.reverted':
      return { ...s, items: [...s.items, { kind: 'reverted', id: itemId(), restored: e.restored, removed: e.removed, undoId: e.undoId }] }

    case 'approval.resolved':
      return resolveApproval(s, e.requestId, e.allow, e.again === true)

    case 'ask.answered':
      return resolveAsk(s, e.requestId, e.answers)

    case 'turn.abandoned':
      return {
        ...noMoonsTurn(s),
        items: [
          ...failRunningTools(closeThinking(s.items, now), now),
          { kind: 'notice', id: itemId(), text: 'Celeste was closed while this was running. Send a message to continue.' }
        ],
        status: 'idle',
        activity: null }

    // Two Moons: the run is going on while either moon works.
    case 'moons.turn':
      return { ...s, status: 'working', activity: moonsActivity(s, e.seat, e.step), moonsTurn: { seat: e.seat, step: e.step } }

    case 'moons.handed':
      return { ...s, items: [...s.items, { kind: 'moonsHand', id: itemId(), from: e.from, to: e.to, what: e.what, at: now }] }

    case 'moons.said': {
      const message: MoonsMessage = {
        id: e.id,
        seat: e.seat,
        text: e.text,
        ...(e.file ? { file: e.file } : {}),
        ...(e.line !== undefined ? { line: e.line } : {}),
        ...(e.code ? { code: e.code } : {}),
        ...(e.finding ? { finding: true as const } : {}),
        ...(e.to ? { to: e.to } : {}),
        at: now
      }
      // The same message twice (the log replayed over what is already shown) adds nothing.
      if (s.items.some((it) => it.kind === 'moonsTalk' && it.messages.some((m) => m.id === e.id))) return s
      // One box per run: the talk of this run joins the box already open, and that box stays the last element.
      let at = -1
      for (let i = s.items.length - 1; i >= 0 && s.items[i].kind !== 'user'; i--) {
        if (s.items[i].kind === 'moonsTalk') { at = i; break }
      }
      const open = at >= 0 ? s.items[at] : undefined
      const items: TimelineItem[] =
        open?.kind === 'moonsTalk'
          ? [...s.items.filter((_, i) => i !== at), { ...open, messages: [...open.messages, message] }]
          : [...s.items, { kind: 'moonsTalk', id: itemId(), messages: [message] }]
      return { ...s, items }
    }

    case 'moons.fixed': {
      const ids = new Set(e.ids)
      return {
        ...s,
        items: s.items.map((it) =>
          it.kind === 'moonsTalk' && it.messages.some((m) => ids.has(m.id) && !m.fixed)
            ? { ...it, messages: it.messages.map((m) => (ids.has(m.id) ? { ...m, fixed: true as const } : m)) }
            : it
        )
      }
    }

    case 'moons.plan':
      return { ...s, items: [...s.items, { kind: 'moonsPlan', id: itemId(), planId: e.id, say: e.say, steps: e.steps }] }

    case 'moons.agreed':
      return { ...s, items: s.items.map((it) => (it.kind === 'moonsPlan' && it.planId === e.id ? { ...it, agreed: true as const } : it)) }

    case 'moons.compared':
      return { ...s, items: [...s.items, { kind: 'moonsCompare', id: itemId(), both: e.both, first: e.first, second: e.second }] }

    case 'moons.ended': {
      // Stop during a plan logs no answer, so a card nobody answered is let go here, as Stop does: an approval is denied, a question is skipped.
      const letGo = s.items.map((it) => (it.kind === 'approval' && it.status === 'pending' ? { ...it, status: 'denied' as const } : it.kind === 'ask' && it.status === 'pending' ? { ...it, status: 'skipped' as const } : it))
      // A run that ended well with nothing to add, or with nothing to do, leaves no line.
      const silent = e.why === 'nothing' || (e.why === 'agreed' && !e.note)
      const items: TimelineItem[] = silent ? letGo : [...letGo, { kind: 'moonsEnded', id: itemId(), why: e.why, ...(e.note ? { note: e.note } : {}), ...(e.left !== undefined ? { left: e.left } : {}) }]
      return { ...noMoonsTurn(s), items, status: 'idle', activity: null }
    }

    case 'turn.started':
      return { ...s, status: 'working', activity: THINKING }

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
      return { ...s, items, status: 'working', activity: { label: 'Writing', working: true } }
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
          { kind: 'approval', id: itemId(), requestId: e.requestId, tool: e.kind, title: e.title, detail: e.detail, ...(e.choices ? { choices: e.choices } : {}), ...(e.slider ? { slider: e.slider } : {}), ...(e.proposal ? { proposal: e.proposal } : {}), status: 'pending' }
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

    case 'background.started':
      // The same task twice (the log replayed over what is already shown) adds nothing.
      if (s.items.some((it) => it.kind === 'background' && it.taskId === e.taskId)) return s
      return { ...s, items: [...s.items, { kind: 'background', id: itemId(), taskId: e.taskId, title: e.title, ...(e.command ? { command: e.command } : {}), status: 'running', startedAt: now }] }

    case 'background.finished': {
      const found = s.items.some((it) => it.kind === 'background' && it.taskId === e.taskId)
      // Its start was not seen (the notice came first, or the log began later): the card is made from the end alone.
      if (!found) {
        return { ...s, items: [...s.items, { kind: 'background', id: itemId(), taskId: e.taskId, title: e.summary, status: e.status, summary: e.summary, ...(e.outputFile ? { outputFile: e.outputFile } : {}), startedAt: now, endedAt: now }] }
      }
      return { ...s, items: s.items.map((it) => (it.kind === 'background' && it.taskId === e.taskId ? { ...it, status: e.status, summary: e.summary, ...(e.outputFile ? { outputFile: e.outputFile } : {}), endedAt: now } : it)) }
    }

    case 'background.output':
      return { ...s, items: s.items.map((it) => (it.kind === 'background' && it.taskId === e.taskId ? { ...it, outputFile: e.outputFile } : it)) }

    case 'turn.completed':
      return { ...s, items: closeThinking(s.items, now), status: 'idle', activity: null }

    case 'turn.interrupted':
      // Tools that were still running stopped with it: none is left spinning under "You stopped this response". A card nobody answered
      // was declined by Stop, so it no longer asks (its buttons would do nothing): an approval is denied, a question is skipped.
      return {
        ...s,
        items: [
          ...failRunningTools(closeThinking(s.items, now), now).map((it) => (it.kind === 'approval' && it.status === 'pending' ? { ...it, status: 'denied' as const } : it.kind === 'ask' && it.status === 'pending' ? { ...it, status: 'skipped' as const } : it)),
          { kind: 'notice', id: itemId(), text: 'You stopped this response.' }
        ],
        status: 'idle',
        activity: null }

    case 'turn.failed':
      return {
        ...s,
        items: [...closeThinking(s.items, now), { kind: 'error', id: itemId(), error: e.error }],
        status: 'idle',
        activity: null }

    // An event this version does not know: a computer newer than this phone's app may log kinds of event it has never seen. Ignored, so the
    // chat is shown as it was, instead of coming back empty (a switch with no answer returns nothing, and the spread of nothing is no chat).
    default:
      return s
  }
}

/** The user answered an approval card: mark it and go back to working. */
export function resolveApproval(s: Session, requestId: string, allow: boolean, again = false): Session {
  return {
    ...s,
    items: s.items.map((it) =>
      it.kind === 'approval' && it.requestId === requestId ? { ...it, status: allow ? 'allowed' : again ? 'retried' : 'denied' } : it
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
    next = { ...reduceEvent(next, event, at), updatedAt: movesSession(event) ? at : next.updatedAt, foldedSeq: seq, lastSeq: Math.max(next.lastSeq, seq) }
  }
  return next
}
