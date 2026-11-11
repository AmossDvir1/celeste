import { create } from 'zustand'
import type { ApprovalMode, AskAnswers, Effort, SessionMode, UserInput } from '@shared/agent'
import type { CheckpointChanges, CheckpointReview, CorePush, SessionSummary, StoredEvent } from '@shared/api'
import { EMPTY_QUEUE, type QueueAction, type SendMode } from '@shared/queue'
import { core } from '@/api'
import { effortFor } from '@/lib/vendors'
import { useChanges } from './changes'
import { modelOf, useModels } from './models'
import { foldEvents } from './reduce'
import type { Session } from './types'
import { useUi } from './ui'

interface SessionsState {
  sessions: Record<string, Session>
  /** The open session of each mode (null shows that mode's home screen). */
  active: Record<SessionMode, string | null>

  init: (summaries: SessionSummary[]) => void
  applyPush: (push: CorePush) => void
  open: (id: string) => void
  home: (mode: SessionMode) => void
  /**
   * Resolves true when the message was sent. On failure the error is shown and false is returned, so the caller keeps the message.
   * While the assistant works, `sendMode` makes the message wait its turn ('queue') or stops the turn and sends it now ('stop').
   */
  send: (mode: SessionMode, input: UserInput, sendMode?: SendMode) => Promise<boolean>
  stop: (id: string) => void
  /** Edits, removes or sends now a message waiting behind the running turn; resumes or clears a paused queue. */
  queueAction: (id: string, action: QueueAction) => void
  /** What reverting to a checkpoint would change. Rejects with a message fit to show. */
  previewRevert: (id: string, checkpointId: string) => Promise<CheckpointChanges>
  /** Puts the project folder back as it was at a checkpoint. False, with a message shown, when it could not. */
  revert: (id: string, checkpointId: string) => Promise<boolean>
  /** The files that changed between two checkpoints (`to` null: up to now), with their lines. Rejects with a message fit to show. */
  review: (id: string, from: string, to: string | null) => Promise<CheckpointReview>
  /** Puts only these files back as they were at a checkpoint. False, with a message shown, when it could not. */
  discardFiles: (id: string, checkpointId: string, paths: string[]) => Promise<boolean>
  respondApproval: (id: string, requestId: string, allow: boolean, always?: boolean, minutes?: number) => void
  respondAsk: (id: string, requestId: string, answers: AskAnswers) => void
  setPrefs: (id: string, patch: { model?: string; effort?: Effort | null; approval?: ApprovalMode }) => void
  rename: (id: string, title: string) => void
  remove: (id: string) => void
  removeAll: () => Promise<void>
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '')
  if (!clean) return 'New chat'
  return clean.length > 46 ? `${clean.slice(0, 45).trimEnd()}…` : clean
}

const fromSummary = (summary: SessionSummary, loaded: boolean): Session => ({ ...summary, items: [], activity: null, loaded, foldedSeq: 0, queue: EMPTY_QUEUE })

/**
 * A session whose conversation is loaded keeps the status its own replay produced. Everything else about it
 * follows Core's summary.
 */
function mergeSummary(current: Session, summary: SessionSummary): Session {
  if (!current.loaded) return { ...current, ...summary }
  const { status: _status, updatedAt: _updatedAt, lastSeq: _lastSeq, ...rest } = summary
  return { ...current, ...rest }
}

/** Events that arrive while a session's log is still being read wait here, then replay after it. */
const loading = new Map<string, StoredEvent[]>()

/**
 * Events for a session that is on screen wait a moment here and are replayed together, so a burst of tokens is one redraw and not
 * one for each. (Redrawing a long conversation for every few characters is what made it crawl.)
 */
const FLUSH_MS = 40

function report(err: unknown): void {
  useUi.getState().pushToast({ text: err instanceof Error ? err.message : 'Something went wrong.' })
}
const fire = (promise: Promise<unknown>): void => void promise.catch(report)

export const useSessions = create<SessionsState>((set, get) => {
  const update = (id: string, fn: (s: Session) => Session) =>
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : st))

  const waiting = new Map<string, StoredEvent[]>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flushWaiting = () => {
    flushTimer = null
    if (waiting.size === 0) return
    const batches = [...waiting]
    waiting.clear()
    set((st) => {
      let sessions = st.sessions
      for (const [id, events] of batches) {
        const s = sessions[id]
        if (!s?.loaded) continue
        if (sessions === st.sessions) sessions = { ...sessions }
        sessions[id] = foldEvents(s, events)
      }
      return sessions === st.sessions ? st : { sessions }
    })
  }

  const drop = (id: string) => {
    waiting.delete(id)
    set((st) => {
      const { [id]: gone, ...rest } = st.sessions
      if (!gone) return st
      const active = { ...st.active }
      if (active[gone.mode] === id) active[gone.mode] = null
      return { sessions: rest, active }
    })
  }

  async function load(id: string): Promise<void> {
    if (loading.has(id)) return
    loading.set(id, [])
    try {
      const log = await core.call('sessions.get', id)
      const queued = loading.get(id) ?? []
      if (!log) {
        drop(id)
        return
      }
      const session = foldEvents(foldEvents(fromSummary(log.summary, true), log.events), queued)
      set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: session } } : st))
    } catch (err) {
      report(err)
    } finally {
      loading.delete(id)
    }
  }

  return {
    sessions: {},
    active: { chat: null, develop: null },

    init: (summaries) =>
      set({ sessions: Object.fromEntries(summaries.map((s) => [s.id, fromSummary(s, false)])), active: { chat: null, develop: null } }),

    applyPush: (push) => {
      if (push.type === 'summary') {
        const { session } = push
        set((st) => {
          const current = st.sessions[session.id]
          return { sessions: { ...st.sessions, [session.id]: current ? mergeSummary(current, session) : fromSummary(session, false) } }
        })
      } else if (push.type === 'removed') {
        drop(push.id)
      } else if (push.type === 'event') {
        const queue = loading.get(push.sessionId)
        if (queue) queue.push(push.stored)
        else if (get().sessions[push.sessionId]?.loaded) {
          waiting.set(push.sessionId, [...(waiting.get(push.sessionId) ?? []), push.stored])
          flushTimer ??= setTimeout(flushWaiting, FLUSH_MS)
        }
      }
    },

    open: (id) => {
      const s = get().sessions[id]
      if (!s) return
      set((st) => ({ active: { ...st.active, [s.mode]: id } }))
      if (!s.loaded) void load(id)
    },

    home: (mode) => set((st) => ({ active: { ...st.active, [mode]: null } })),

    send: async (mode, input, sendMode) => {
      try {
        let id = get().active[mode]
        if (!id) {
          // The first message creates the session, with the settings chosen on the home screen.
          const d = useUi.getState().draft
          if (mode === 'develop' && !d.project) throw new Error('Choose a project folder first. Your message is still here.')
          const title = titleFrom(input.text || input.attachments[0]?.name || '')
          let cwd = d.project
          let branch = d.branch
          if (mode === 'develop' && d.worktree && d.branch) {
            // A separate copy is made first, from the project's last commit, and the session works in that.
            useUi.getState().pushToast({ text: 'Making a separate copy of the project…' })
            const copy = await core.call('project.createWorktree', d.project, title)
            cwd = copy.path
            branch = copy.branch
          }
          const created = await core.call('sessions.create', {
            vendor: modelOf(d.model).vendor,
            mode,
            title,
            model: d.model,
            effort: d.effort,
            approval: d.approval,
            ...(mode === 'develop' ? { cwd, ...(branch ? { branch } : {}) } : {})
          })
          id = created.id
          const sid = created.id
          set((st) => ({ sessions: { ...st.sessions, [sid]: fromSummary(created, true) }, active: { ...st.active, [mode]: sid } }))
        }
        await core.call('sessions.send', id, input, sendMode)
        return true
      } catch (err) {
        report(err)
        return false
      }
    },

    stop: (id) => fire(core.call('sessions.interrupt', id)),

    queueAction: (id, action) => fire(core.call('sessions.queue', id, action)),

    previewRevert: (id, checkpointId) => core.call('sessions.revertPreview', id, checkpointId),

    review: (id, from, to) => core.call('sessions.review', id, from, to),

    discardFiles: async (id, checkpointId, paths) => {
      try {
        await core.call('sessions.discardFiles', id, checkpointId, paths)
        // What differs from the start of the session has just changed.
        void useChanges.getState().refresh(id)
        return true
      } catch (err) {
        report(err)
        return false
      }
    },

    revert: async (id, checkpointId) => {
      try {
        await core.call('sessions.revert', id, checkpointId)
        void useChanges.getState().refresh(id)
        return true
      } catch (err) {
        report(err)
        return false
      }
    },

    respondApproval: (id, requestId, allow, always, minutes) => fire(core.call('sessions.respondApproval', id, requestId, { allow, always, ...(minutes ? { minutes } : {}) })),

    respondAsk: (id, requestId, answers) => fire(core.call('sessions.respondAsk', id, requestId, answers)),

    setPrefs: (id, patch) => {
      const s = get().sessions[id]
      if (!s) return
      const next = { ...patch }
      if (patch.model) {
        const m = useModels.getState().byId[patch.model]
        if (m && patch.effort === undefined) next.effort = effortFor(m, s.effort)
      }
      update(id, (cur) => ({ ...cur, ...next }))
      fire(core.call('sessions.update', id, next))
    },

    rename: (id, title) => {
      const clean = title.trim()
      if (!clean) return
      update(id, (s) => ({ ...s, title: clean }))
      fire(core.call('sessions.update', id, { title: clean }))
    },

    remove: (id) => {
      const gone = get().sessions[id]
      if (!gone) return
      drop(id)
      fire(core.call('sessions.remove', id))
      // The chat's browser tabs go with it.
      if (window.celeste) void window.celeste.browser.call('closeChat', { chatId: id }).catch(() => undefined)
      useUi.getState().pushToast({
        text: `Deleted “${gone.title}”`,
        actionLabel: 'Undo',
        onAction: () =>
          fire(
            core.call('sessions.restore', id).then((summary) => {
              if (!summary) return
              set((st) => ({ sessions: { ...st.sessions, [id]: mergeSummary(gone, summary) } }))
            })
          )
      })
    },

    removeAll: async () => {
      try {
        const ids = await core.call('sessions.removeAll')
        set({ sessions: {}, active: { chat: null, develop: null } })
        useUi.getState().pushToast({ text: ids.length === 1 ? 'Deleted 1 session.' : `Deleted ${ids.length} sessions.` })
      } catch (err) {
        report(err)
      }
    },
  }
})

/** Sessions that need the user right now (an approval or a question). */
export function needsYou(s: Session): boolean {
  return s.status === 'waiting'
}
