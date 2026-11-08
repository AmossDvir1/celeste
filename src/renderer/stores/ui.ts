import { create } from 'zustand'
import type { ApprovalMode, Effort, ModelInfo } from '@shared/agent'
import { effortFor } from '@/lib/vendors'
import { lookupModel, modelOf, useModels } from './models'
import { useSettings } from '@/stores/settings'

export type AppMode = 'chat' | 'develop' | 'workflows'
export type RightPanel = null | 'tools' | 'changes' | 'terminal' | 'files'
export type SettingsSection = 'general' | 'appearance' | 'vendors' | 'agent' | 'tools' | 'devices' | 'data' | 'about'

/** Settings of the composer before a session exists. A new session copies them. */
export interface Draft {
  model: string
  effort: Effort | null
  approval: ApprovalMode
  /** The folder Develop works in. Empty until one is chosen. */
  project: string
  /** Its git branch, read from the folder. Empty when it has none. */
  branch: string
  /** Work in a separate copy of the project (a git worktree) instead of the folder itself. */
  worktree: boolean
}

export interface Toast {
  id: number
  text: string
  actionLabel?: string
  onAction?: () => void
}

interface UiState {
  mode: AppMode
  rightPanel: RightPanel
  settingsOpen: boolean
  settingsSection: SettingsSection
  wizardOpen: boolean
  searchOpen: boolean
  draft: Draft
  toasts: Toast[]
  /** Where Celeste keeps its data, for the Data section of Settings. */
  dataDir: string

  setMode: (mode: AppMode) => void
  toggleRight: (panel: Exclude<RightPanel, null>) => void
  setRight: (panel: RightPanel) => void
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  setWizardOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setDraft: (patch: Partial<Draft>) => void
  resetDraft: () => void
  /** After the model list changes: if the draft's model is not on it, use one that is. */
  fitDraftToModels: () => void
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
  setDataDir: (dir: string) => void
}

function freshDraft(): Draft {
  const { defaults } = useSettings.getState()
  const model = modelOf(defaults.model)
  return {
    model: model.id,
    effort: model.efforts.length ? (model.defaultEffort ?? model.efforts[0]) : null,
    approval: defaults.approval,
    project: '',
    branch: '',
    worktree: false
  }
}

let toastId = 1

export const useUi = create<UiState>((set, get) => ({
  mode: 'chat',
  rightPanel: null,
  settingsOpen: false,
  settingsSection: 'general',
  wizardOpen: false,
  searchOpen: false,
  draft: freshDraft(),
  toasts: [],
  dataDir: '',

  setMode: (mode) => set({ mode, rightPanel: null }),
  toggleRight: (panel) => set({ rightPanel: get().rightPanel === panel ? null : panel }),
  setRight: (rightPanel) => set({ rightPanel }),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? get().settingsSection }),
  closeSettings: () => set({ settingsOpen: false }),
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setDraft: (patch) => set({ draft: { ...get().draft, ...patch } }),
  resetDraft: () => {
    set({ draft: { ...freshDraft(), project: get().draft.project, branch: get().draft.branch, worktree: get().draft.worktree } })
    get().fitDraftToModels()
  },
  fitDraftToModels: () => {
    const { list, byId } = useModels.getState()
    const d = get().draft
    if (list.length === 0 || byId[d.model]) return
    const wanted = lookupModel(byId, useSettings.getState().defaults.model)
    const model = byId[wanted.id] ?? (list[0] as ModelInfo)
    set({ draft: { ...d, model: model.id, effort: effortFor(model, null) } })
  },
  pushToast: (toast) => {
    const id = toastId++
    // The newest few only, so a burst of messages cannot fill the window. How long each stays is the pile's business (Toasts.tsx).
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-6) })
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setDataDir: (dataDir) => set({ dataDir })
}))
