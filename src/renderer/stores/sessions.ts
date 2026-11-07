import { create } from 'zustand'
import type { AgentSession, ApprovalMode, AskAnswers, Effort, SessionMode, UserInput } from '@shared/agent'
import { createMockSession, type ScenarioId } from '@/mocks/engine'
import { MODEL_BY_ID, effortFor } from '@/mocks/models'
import { seedSessions } from '@/mocks/seed'
import { itemId, reduceEvent, resolveApproval, resolveAsk } from './reduce'
import type { Session } from './types'
import { useUi } from './ui'

interface SessionsState {
  sessions: Record<string, Session>
  /** The open session of each mode (null shows that mode's home screen). */
  active: Record<SessionMode, string | null>
  forcedScenario: ScenarioId | undefined

  open: (id: string) => void
  home: (mode: SessionMode) => void
  send: (mode: SessionMode, input: UserInput) => void
  stop: (id: string) => void
  respondApproval: (id: string, requestId: string, allow: boolean, always?: boolean) => void
  respondAsk: (id: string, requestId: string, answers: AskAnswers) => void
  setPrefs: (id: string, patch: { model?: string; effort?: Effort | null; approval?: ApprovalMode }) => void
  rename: (id: string, title: string) => void
  remove: (id: string) => void
  setForcedScenario: (s: ScenarioId | undefined) => void
  /** Dev menu: add a ready-made session and open it. */
  adopt: (session: Session) => void
}

// Live agent connections. They are not state: a session without one is just a record on screen.
const runtimes = new Map<string, AgentSession>()

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '')
  if (!clean) return 'New chat'
  return clean.length > 46 ? `${clean.slice(0, 45).trimEnd()}…` : clean
}

export const useSessions = create<SessionsState>((set, get) => {
  const update = (id: string, fn: (s: Session) => Session) =>
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } } : st))

  function connect(id: string): AgentSession {
    const existing = runtimes.get(id)
    if (existing) return existing
    const session = createMockSession({
      mode: get().sessions[id].mode,
      getApproval: () => get().sessions[id]?.approval ?? 'auto',
      takeForcedScenario: () => {
        const s = get().forcedScenario
        if (s) set({ forcedScenario: undefined })
        return s
      }
    })
    runtimes.set(id, session)
    void (async () => {
      for await (const event of session.events) update(id, (s) => reduceEvent(s, event))
    })()
    return session
  }

  return {
    sessions: Object.fromEntries(seedSessions().map((s) => [s.id, s])),
    active: { chat: null, develop: null },
    forcedScenario: undefined,

    open: (id) => {
      const s = get().sessions[id]
      if (!s) return
      set((st) => ({ active: { ...st.active, [s.mode]: id } }))
    },

    home: (mode) => set((st) => ({ active: { ...st.active, [mode]: null } })),

    send: (mode, input) => {
      const ui = useUi.getState()
      let id = get().active[mode]
      const now = Date.now()

      if (!id) {
        const d = ui.draft
        id = `s-${now.toString(36)}`
        const created: Session = {
          id,
          mode,
          title: titleFrom(input.text || input.attachments[0]?.name || ''),
          model: d.model,
          effort: d.effort,
          approval: d.approval,
          cwd: mode === 'develop' ? d.project : undefined,
          branch: mode === 'develop' ? d.branch : undefined,
          items: [],
          status: 'idle',
          activity: null,
          createdAt: now,
          updatedAt: now
        }
        const sid = id
        set((st) => ({ sessions: { ...st.sessions, [sid]: created }, active: { ...st.active, [mode]: sid } }))
      }

      const sid = id
      update(sid, (s) => ({
        ...s,
        items: [...s.items, { kind: 'user', id: itemId(), text: input.text, attachments: input.attachments, at: now }],
        updatedAt: now
      }))
      connect(sid).send(input)
    },

    stop: (id) => {
      void runtimes.get(id)?.interrupt()
    },

    respondApproval: (id, requestId, allow, always) => {
      update(id, (s) => ({ ...resolveApproval(s, requestId, allow), approval: allow && always ? 'auto' : s.approval }))
      runtimes.get(id)?.respond(requestId, { allow, always })
    },

    respondAsk: (id, requestId, answers) => {
      update(id, (s) => resolveAsk(s, requestId, answers))
      runtimes.get(id)?.respond(requestId, answers)
    },

    setPrefs: (id, patch) =>
      update(id, (s) => {
        const next = { ...s, ...patch }
        if (patch.model) {
          const m = MODEL_BY_ID[patch.model]
          if (m && patch.effort === undefined) next.effort = effortFor(m, s.effort)
        }
        return next
      }),

    rename: (id, title) => {
      const clean = title.trim()
      if (clean) update(id, (s) => ({ ...s, title: clean }))
    },

    remove: (id) => {
      const gone = get().sessions[id]
      if (!gone) return
      void runtimes.get(id)?.interrupt()
      void runtimes.get(id)?.close()
      runtimes.delete(id)
      set((st) => {
        const { [id]: _removed, ...rest } = st.sessions
        const active = { ...st.active }
        if (active[gone.mode] === id) active[gone.mode] = null
        return { sessions: rest, active }
      })
      useUi.getState().pushToast({
        text: `Deleted “${gone.title}”`,
        actionLabel: 'Undo',
        onAction: () => set((st) => ({ sessions: { ...st.sessions, [id]: { ...gone, status: 'idle', activity: null } } }))
      })
    },

    setForcedScenario: (forcedScenario) => set({ forcedScenario }),

    adopt: (session) =>
      set((st) => ({
        sessions: { ...st.sessions, [session.id]: session },
        active: { ...st.active, [session.mode]: session.id }
      }))
  }
})

/** Sessions that need the user right now (an approval or a question). */
export function needsYou(s: Session): boolean {
  return s.status === 'waiting'
}
