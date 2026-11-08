import { create } from 'zustand'
import type { ApprovalMode, AskAnswers, Effort, SessionMode, UserInput } from '@shared/agent'
import type { CorePush, SessionSummary, StoredEvent } from '@shared/api'
import { core } from '@/api'
import { effortFor } from '@/lib/vendors'
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
  send: (mode: SessionMode, input: UserInput) => Promise<void>
  stop: (id: string) => void
  respondApproval: (id: string, requestId: string, allow: boolean, always?: boolean) => void
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

const fromSummary = (summary: SessionSummary, loaded: boolean): Session => ({ ...summary, items: [], activity: null, loaded, foldedSeq: 0 })

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

function report(err: unknown): void {
  useUi.getState().pushToast({ text: err instanceof Error ? err.message : 'Something went wrong.' })
}
const fire = (promise: Promise<unknown>): void => void promise.catch(report)

export const useSessions = create<SessionsState>((set, get) => {
  const update = (id: string, fn: (s: Session) => Session) =>
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : st))

  const drop = (id: string) =>
    set((st) => {
      const { [id]: gone, ...rest } = st.sessions
      if (!gone) return st
      const active = { ...st.active }
      if (active[gone.mode] === id) active[gone.mode] = null
      return { sessions: rest, active }
    })

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
        else if (get().sessions[push.sessionId]?.loaded) update(push.sessionId, (s) => foldEvents(s, [push.stored]))
      }
    },

    open: (id) => {
      const s = get().sessions[id]
      if (!s) return
      set((st) => ({ active: { ...st.active, [s.mode]: id } }))
      if (!s.loaded) void load(id)
    },

    home: (mode) => set((st) => ({ active: { ...st.active, [mode]: null } })),

    send: async (mode, input) => {
      try {
        let id = get().active[mode]
        if (!id) {
          // The first message creates the session, with the settings chosen on the home screen.
          const d = useUi.getState().draft
          if (mode === 'develop' && !d.project) throw new Error('Choose a project folder first.')
          const created = await core.call('sessions.create', {
            vendor: modelOf(d.model).vendor,
            mode,
            title: titleFrom(input.text || input.attachments[0]?.name || ''),
            model: d.model,
            effort: d.effort,
            approval: d.approval,
            ...(mode === 'develop' ? { cwd: d.project, ...(d.branch ? { branch: d.branch } : {}) } : {})
          })
          id = created.id
          const sid = created.id
          set((st) => ({ sessions: { ...st.sessions, [sid]: fromSummary(created, true) }, active: { ...st.active, [mode]: sid } }))
        }
        await core.call('sessions.send', id, input)
      } catch (err) {
        report(err)
      }
    },

    stop: (id) => fire(core.call('sessions.interrupt', id)),

    respondApproval: (id, requestId, allow, always) => fire(core.call('sessions.respondApproval', id, requestId, { allow, always })),

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
