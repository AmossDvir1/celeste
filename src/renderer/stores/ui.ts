import { create } from 'zustand'
import type { ApprovalMode, Effort } from '@shared/agent'
import { modelOf } from './models'
import { useSettings } from '@/stores/settings'

export type AppMode = 'chat' | 'develop' | 'workflows'
export type RightPanel = null | 'tools' | 'changes' | 'files' | 'terminal'
export type SettingsSection = 'general' | 'appearance' | 'vendors' | 'agent' | 'tools' | 'devices' | 'data' | 'about'

/** Settings of the composer before a session exists. A new session copies them. */
export interface Draft {
  model: string
  effort: Effort | null
  approval: ApprovalMode
  project: string
  branch: string
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
  devMenuOpen: boolean
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
  setDevMenuOpen: (open: boolean) => void
  setDraft: (patch: Partial<Draft>) => void
  resetDraft: () => void
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
    project: 'D:\\Work\\wfo-tools',
    branch: 'main',
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
  devMenuOpen: false,
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
  setDevMenuOpen: (devMenuOpen) => set({ devMenuOpen }),
  setDraft: (patch) => set({ draft: { ...get().draft, ...patch } }),
  resetDraft: () => set({ draft: { ...freshDraft(), project: get().draft.project, branch: get().draft.branch } }),
  pushToast: (toast) => {
    const id = toastId++
    set({ toasts: [...get().toasts, { ...toast, id }] })
    setTimeout(() => get().dismissToast(id), 7000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setDataDir: (dataDir) => set({ dataDir })
}))
