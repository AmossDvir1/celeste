import { create } from 'zustand'
import type { AskAnswers } from '@shared/agent'
import type { CorePush } from '@shared/api'
import type { RunSummary, StoredRunEvent } from '@shared/workflow'
import { core } from '@/api'
import { useUi } from './ui'

/** A run as the window holds it: its summary and everything that happened in it so far. */
export interface RunState {
  summary: RunSummary
  events: StoredRunEvent[]
}

interface RunsState {
  runs: Record<string, RunState>
  /** The run being shown beside the canvas. */
  watching: string | null
  /** The step the person asked about in the run, to open its result. */
  focusNode: string | null
  /** The folder last chosen for each workflow, so the next run starts with it. */
  folders: Record<string, string>

  applyPush: (push: CorePush) => void
  watch: (runId: string | null) => void
  focus: (nodeId: string | null) => void
  /** Reads a run's whole log, for one that was started earlier. */
  load: (runId: string) => Promise<void>
  history: (workflowId: string) => Promise<RunSummary[]>
  start: (workflowId: string, inputs: Record<string, unknown>, folder: string) => Promise<RunSummary | null>
  cancel: (runId: string) => Promise<void>
  approve: (runId: string, requestId: string, allow: boolean) => Promise<void>
  answer: (runId: string, requestId: string, answers: AskAnswers) => Promise<void>
}

const say = (text: string) => useUi.getState().pushToast({ text })
const sentence = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

const FOLDERS_KEY = 'celeste.workflowFolders'
function savedFolders(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** Events by their place in the log, so a push and a read of the same event never count twice. */
function merge(have: StoredRunEvent[], more: StoredRunEvent[]): StoredRunEvent[] {
  const seen = new Set(have.map((e) => e.seq))
  const fresh = more.filter((e) => !seen.has(e.seq))
  return fresh.length ? [...have, ...fresh].sort((a, b) => a.seq - b.seq) : have
}

export const useRuns = create<RunsState>()((set, get) => ({
  runs: {},
  watching: null,
  focusNode: null,
  folders: savedFolders(),

  applyPush: (push) => {
    if (push.type === 'run') {
      set((s) => ({ runs: { ...s.runs, [push.run.id]: { summary: push.run, events: s.runs[push.run.id]?.events ?? [] } } }))
    } else if (push.type === 'runEvent') {
      set((s) => {
        const have = s.runs[push.runId]
        // An event for a run the window has not heard of: its summary arrives with the next push or when it is loaded.
        if (!have) return s
        return { runs: { ...s.runs, [push.runId]: { ...have, events: merge(have.events, [push.stored]) } } }
      })
    }
  },

  watch: (watching) => set({ watching, focusNode: null }),
  focus: (focusNode) => set({ focusNode }),

  load: async (runId) => {
    try {
      const got = await core.call('runs.get', runId)
      if (!got) throw new Error('That run is no longer there.')
      set((s) => ({ runs: { ...s.runs, [runId]: { summary: got.summary, events: merge(s.runs[runId]?.events ?? [], got.events) } } }))
    } catch (err) {
      say(sentence(err, 'Could not open that run.'))
    }
  },

  history: async (workflowId) => {
    try {
      return await core.call('runs.list', workflowId)
    } catch {
      return []
    }
  },

  start: async (workflowId, inputs, folder) => {
    try {
      const run = await core.call('workflows.run', workflowId, inputs, { folder })
      const folders = { ...get().folders, [workflowId]: folder }
      try {
        localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders))
      } catch {
        /* the folder is simply not remembered */
      }
      set((s) => ({ folders, runs: { ...s.runs, [run.id]: s.runs[run.id] ?? { summary: run, events: [] } }, watching: run.id, focusNode: null }))
      // Events that happened before the window knew about the run.
      void get().load(run.id)
      return run
    } catch (err) {
      say(sentence(err, 'Could not start the workflow.'))
      return null
    }
  },

  cancel: async (runId) => {
    try {
      await core.call('runs.cancel', runId)
    } catch (err) {
      say(sentence(err, 'Could not stop the run.'))
    }
  },

  approve: async (runId, requestId, allow) => {
    try {
      await core.call('runs.respondApproval', runId, requestId, allow)
    } catch (err) {
      say(sentence(err, 'That was already answered.'))
    }
  },

  answer: async (runId, requestId, answers) => {
    try {
      await core.call('runs.respondAsk', runId, requestId, answers)
    } catch (err) {
      say(sentence(err, 'That was already answered.'))
    }
  }
}))
