import { create } from 'zustand'
import type { CorePush } from '@shared/api'
import { emptyDefinition, validateWorkflow, type WorkflowDefinition, type WorkflowFull, type WorkflowSummary } from '@shared/workflow'
import { core } from '@/api'
import { useUi } from './ui'

/** The workflow being edited: what is on the screen, which may differ from what is saved. */
export interface Draft {
  /** Absent until it has been saved once. */
  id?: string
  name: string
  description: string
  definition: WorkflowDefinition
  version: number
  /** What was saved last, to tell whether anything changed. */
  saved: string
}

const snapshot = (d: Pick<Draft, 'name' | 'description' | 'definition'>): string => JSON.stringify([d.name.trim(), d.description, d.definition])

export const isDirty = (d: Draft | null): boolean => d !== null && snapshot(d) !== d.saved

/** What is wrong with the draft, in words. Empty when it can be saved. */
export const problemsOf = (d: Draft | null): string[] => {
  if (!d) return []
  const found: string[] = []
  if (!d.name.trim()) found.push('The workflow needs a name.')
  return [...found, ...validateWorkflow(d.definition)]
}

interface WorkflowsState {
  list: WorkflowSummary[]
  loaded: boolean
  draft: Draft | null
  /** The step whose details are open. */
  selectedNode: string | null
  /** Something the person asked for that would lose unsaved changes, held until they answer. */
  leaving: (() => void) | null

  refresh: () => Promise<void>
  applyPush: (push: CorePush) => void
  /** Runs `action`, after asking first when there are unsaved changes. */
  guard: (action: () => void) => void
  confirmLeave: () => void
  cancelLeave: () => void

  newWorkflow: () => void
  open: (id: string) => Promise<void>
  close: () => void

  setName: (name: string) => void
  setDescription: (description: string) => void
  edit: (change: (def: WorkflowDefinition) => WorkflowDefinition) => void
  selectNode: (id: string | null) => void
  /** Replaces the steps with an older saved version, as an unsaved change. */
  restore: (version: number) => Promise<void>
  save: () => Promise<boolean>
  remove: (id: string) => Promise<void>
  /** Saves the workflow as a file the person chooses, for someone else to open. */
  share: () => Promise<void>
  /** Opens a shared file as a new workflow that is not saved yet. */
  importFile: () => void
  /** True while an assistant is drafting a workflow. */
  building: boolean
  /** Asks an assistant to draft a workflow from a description, or from a conversation, and opens it unsaved. Returns whether it did. */
  build: (source: { kind: 'text'; text: string } | { kind: 'conversation'; sessionId: string }) => Promise<boolean>
  /** Lets the assistant run the open workflow, or stops it. */
  setAssistant: (allow: boolean) => Promise<void>
}

const draftFrom = (w: WorkflowFull): Draft => ({
  id: w.id,
  name: w.name,
  description: w.description,
  definition: w.definition,
  version: w.version,
  saved: snapshot(w)
})

const say = (text: string) => useUi.getState().pushToast({ text })
const sentence = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback)

export const useWorkflows = create<WorkflowsState>()((set, get) => ({
  list: [],
  loaded: false,
  draft: null,
  selectedNode: null,
  leaving: null,
  building: false,

  refresh: async () => {
    try {
      set({ list: await core.call('workflows.list'), loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  applyPush: (push) => {
    if (push.type === 'workflows' || push.type === 'run') void get().refresh()
  },

  guard: (action) => {
    if (isDirty(get().draft)) set({ leaving: action })
    else action()
  },
  confirmLeave: () => {
    const action = get().leaving
    set({ leaving: null })
    action?.()
  },
  cancelLeave: () => set({ leaving: null }),

  newWorkflow: () =>
    get().guard(() => {
      const definition = emptyDefinition()
      // Saved as nothing, so that it counts as unsaved until it has been saved once.
      set({ draft: { name: 'New workflow', description: '', definition, version: 0, saved: '' }, selectedNode: null })
    }),

  open: async (id) => {
    const go = async () => {
      try {
        const w = await core.call('workflows.get', id)
        if (!w) throw new Error('That workflow no longer exists.')
        set({ draft: draftFrom(w), selectedNode: null })
      } catch (err) {
        say(sentence(err, 'Could not open that workflow.'))
      }
    }
    if (isDirty(get().draft)) set({ leaving: () => void go() })
    else await go()
  },

  close: () => get().guard(() => set({ draft: null, selectedNode: null })),

  setName: (name) => set((s) => (s.draft ? { draft: { ...s.draft, name } } : s)),
  setDescription: (description) => set((s) => (s.draft ? { draft: { ...s.draft, description } } : s)),
  edit: (change) => set((s) => (s.draft ? { draft: { ...s.draft, definition: change(s.draft.definition) } } : s)),
  selectNode: (selectedNode) => set({ selectedNode }),

  restore: async (version) => {
    const d = get().draft
    if (!d?.id) return
    try {
      const definition = await core.call('workflows.version', d.id, version)
      if (!definition) throw new Error(`Version ${version} is not saved any more.`)
      set({ draft: { ...d, definition }, selectedNode: null })
    } catch (err) {
      say(sentence(err, 'Could not load that version.'))
    }
  },

  save: async () => {
    const d = get().draft
    if (!d) return false
    const problems = problemsOf(d)
    if (problems.length) {
      say(problems[0] as string)
      return false
    }
    try {
      const w = await core.call('workflows.save', { ...(d.id ? { id: d.id } : {}), name: d.name.trim(), description: d.description, definition: d.definition })
      set({ draft: draftFrom(w) })
      say(w.version > d.version && d.version > 0 ? `Saved as version ${w.version}.` : 'Saved.')
      return true
    } catch (err) {
      say(sentence(err, 'Could not save the workflow.'))
      return false
    }
  },

  share: async () => {
    const d = get().draft
    if (!d?.id) return say('Save the workflow first, then it can be shared.')
    try {
      const out = await core.call('workflows.export', d.id)
      const saved = await window.celeste?.saveText(out.filename, out.text)
      if (!saved?.saved) return
      say(`Saved ${saved.saved}.`)
      for (const note of out.notes.slice(0, 3)) say(note)
    } catch (err) {
      say(sentence(err, 'Could not share the workflow.'))
    }
  },

  importFile: () =>
    get().guard(() => {
      void (async () => {
        try {
          const file = await window.celeste?.openText(['json'])
          if (!file) return
          const read = await core.call('workflows.import', file.text)
          // A name is used once, so a copy of a workflow that is already here gets a number.
          const taken = new Set(get().list.map((w) => w.name.trim().toLowerCase()))
          let name = read.name
          for (let n = 2; taken.has(name.trim().toLowerCase()); n++) name = `${read.name} (${n})`
          set({ draft: { name, description: read.description, definition: read.definition, version: 0, saved: '' }, selectedNode: null })
          say('Opened it. Look it over, then save it. Nothing runs until you say so.')
          for (const note of read.notes.slice(0, 3)) say(note)
        } catch (err) {
          say(sentence(err, 'Could not open that file.'))
        }
      })()
    }),

  build: async (source) => {
    if (get().building) return false
    set({ building: true })
    try {
      const read = await core.call('workflows.draft', source)
      const taken = new Set(get().list.map((w) => w.name.trim().toLowerCase()))
      let name = read.name
      for (let n = 2; taken.has(name.trim().toLowerCase()); n++) name = `${read.name} (${n})`
      // Replaces what is on the canvas, so unsaved changes there are asked about first.
      const open = () => set({ draft: { name, description: read.description, definition: read.definition, version: 0, saved: '' }, selectedNode: null })
      get().guard(open)
      say('Here is a draft. Look it over and change what you like, then save it. Nothing runs until you say so.')
      for (const note of read.notes.slice(0, 3)) say(note)
      return true
    } catch (err) {
      say(sentence(err, 'Could not make a workflow.'))
      return false
    } finally {
      set({ building: false })
    }
  },

  setAssistant: async (allow) => {
    const id = get().draft?.id
    if (!id) return
    try {
      await core.call('workflows.setAssistant', id, allow)
      await get().refresh()
      say(allow ? 'The assistant may now run this workflow. It still shows you what it will do first.' : 'The assistant may not run this workflow.')
    } catch (err) {
      say(sentence(err, 'Could not change that.'))
    }
  },

  remove: async (id) => {
    try {
      await core.call('workflows.remove', id)
      if (get().draft?.id === id) set({ draft: null, selectedNode: null })
      say('Deleted the workflow.')
    } catch (err) {
      say(sentence(err, 'Could not delete the workflow.'))
    }
  }
}))
