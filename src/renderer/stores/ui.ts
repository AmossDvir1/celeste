import { create } from 'zustand'
import type { ApprovalMode, Effort, ModelInfo } from '@shared/agent'
import type { MoonPattern } from '@shared/moons'
import { effortFor } from '@/lib/vendors'
import { lookupModel, modelOf, useModels } from './models'
import { useSettings } from '@/stores/settings'

export type AppMode = 'chat' | 'develop' | 'workflows'
export type RightPanel = null | 'tools' | 'changes' | 'terminal' | 'files' | 'browser' | 'canvas'

/** How wide the browser panel is, in pixels. It is dragged by its edge and remembered. */
export const BROWSER_WIDTH = { min: 360, max: 1100, normal: 520 }
const WIDTH_KEY = 'celeste.browserWidth'
function savedBrowserWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n >= BROWSER_WIDTH.min && n <= BROWSER_WIDTH.max ? n : BROWSER_WIDTH.normal
  } catch {
    return BROWSER_WIDTH.normal
  }
}
export type SettingsSection = 'general' | 'vendors' | 'tools' | 'browser' | 'desktop' | 'phone' | 'devices' | 'data' | 'about'

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
  /** Two Moons: the pattern chosen on the home screen and the model of the second moon (the composer's own is the Builder's, or the pen's). Null: one agent. */
  moons: { pattern: MoonPattern; model: string; effort: Effort | null } | null
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
  /** The window is the small side window, which shows a compacted view (docs/TRAY_AND_COMPACT_PLAN.md, Part 2). The main process owns the window; this follows it. */
  compact: boolean
  /** The small window stays above other windows. */
  compactPinned: boolean
  browserWidth: number
  /** Whether the browser's address bar takes the keyboard when the panel opens on an empty browser: yes when the person opened it, no when the assistant did. */
  browserFocus: boolean
  /** A web link in a chat that waits for the person to say where it opens (Celeste's browser or theirs). */
  pendingLink: string | null
  settingsOpen: boolean
  settingsSection: SettingsSection
  wizardOpen: boolean
  searchOpen: boolean
  draft: Draft
  toasts: Toast[]
  /** Where Celeste keeps its data, for the Data section of Settings. */
  dataDir: string
  /** The running version of Celeste. */
  version: string

  setMode: (mode: AppMode) => void
  /** Asks the main process to make the window the small side window, or the full one again. */
  setCompact: (on: boolean) => void
  setCompactPinned: (pinned: boolean) => void
  /** The shortcut: the other shape, from where the window is going, so a quick second press goes back. */
  toggleCompact: () => void
  toggleRight: (panel: Exclude<RightPanel, null>) => void
  setRight: (panel: RightPanel) => void
  /** The assistant started using the browser: the panel opens, and leaves the keyboard where it is. */
  revealBrowser: () => void
  setBrowserWidth: (width: number, save?: boolean) => void
  setPendingLink: (url: string | null) => void
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
  setVersion: (version: string) => void
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
    worktree: false,
    moons: null
  }
}

let toastId = 1

/** The window's shape, as the main process says it is. The side window has no panels beside the chat, so none is left open. */
function applyLayout(state: { compact: boolean; pinned: boolean }): void {
  useUi.setState({ compact: state.compact, compactPinned: state.pinned, ...(state.compact ? { rightPanel: null } : {}) })
}

/**
 * While the window changes shape the page is faded out (the `data-layout-switch` attribute, styled in index.css), so the layouts are
 * never seen at the sizes between the two. It comes back when the new shape arrives, or after a moment if that never happens.
 */
const clearSwitch = () => document.documentElement.removeAttribute('data-layout-switch')
let failsafe: ReturnType<typeof setTimeout> | undefined

/** Follows the window's shape from the start and whenever it changes (the button, the shortcut, the tray menu, maximising). */
export function startLayout(): () => void {
  const layout = window.celeste?.layout
  if (!layout) return () => undefined
  void layout.get().then(applyLayout, () => undefined)
  const stopStart = layout.onStart(() => {
    document.documentElement.setAttribute('data-layout-switch', 'out')
    clearTimeout(failsafe)
    failsafe = setTimeout(clearSwitch, 1500)
  })
  const stopChange = layout.onChange((state) => {
    applyLayout(state)
    clearTimeout(failsafe)
    // After the new layout has been drawn once, so it fades in rather than appearing.
    requestAnimationFrame(() => requestAnimationFrame(clearSwitch))
  })
  return () => {
    stopStart()
    stopChange()
  }
}

export const useUi = create<UiState>((set, get) => ({
  mode: 'chat',
  rightPanel: null,
  compact: false,
  compactPinned: true,
  browserWidth: savedBrowserWidth(),
  browserFocus: true,
  pendingLink: null,
  settingsOpen: false,
  settingsSection: 'general',
  wizardOpen: false,
  searchOpen: false,
  draft: freshDraft(),
  toasts: [],
  dataDir: '',
  version: '',

  setMode: (mode) => set({ mode, rightPanel: null }),
  setCompact: (compact) => {
    // The window changes shape (animated), then tells every listener; the page follows what it hears (startLayout), so it never disagrees.
    void window.celeste?.layout.set({ compact })
  },
  toggleCompact: () => void window.celeste?.layout.toggle(),
  setCompactPinned: (compactPinned) => {
    set({ compactPinned })
    void window.celeste?.layout.set({ pinned: compactPinned })
  },
  toggleRight: (panel) => set({ rightPanel: get().rightPanel === panel ? null : panel, ...(panel === 'browser' ? { browserFocus: true } : {}) }),
  setRight: (rightPanel) => set({ rightPanel, ...(rightPanel === 'browser' ? { browserFocus: true } : {}) }),
  revealBrowser: () => set({ rightPanel: 'browser', browserFocus: false }),
  setBrowserWidth: (width, save = true) => {
    const browserWidth = Math.round(Math.min(BROWSER_WIDTH.max, Math.max(BROWSER_WIDTH.min, width)))
    set({ browserWidth })
    if (!save) return
    try {
      localStorage.setItem(WIDTH_KEY, String(browserWidth))
    } catch {
      /* the width just is not remembered */
    }
  },
  setPendingLink: (pendingLink) => set({ pendingLink }),
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
    if (list.length === 0) return
    // The second moon's model may have gone too (its vendor was disconnected): it follows the composer's.
    const moons = d.moons && !byId[d.moons.model] ? { ...d.moons, model: byId[d.model]?.id ?? d.model, effort: d.effort } : d.moons
    if (byId[d.model]) {
      if (moons !== d.moons) set({ draft: { ...d, moons } })
      return
    }
    const wanted = lookupModel(byId, useSettings.getState().defaults.model)
    const model = byId[wanted.id] ?? (list[0] as ModelInfo)
    set({ draft: { ...d, model: model.id, effort: effortFor(model, null), moons: d.moons && !byId[d.moons.model] ? { ...d.moons, model: model.id, effort: effortFor(model, null) } : d.moons } })
  },
  pushToast: (toast) => {
    const id = toastId++
    // The newest few only, so a burst of messages cannot fill the window. How long each stays is the pile's business (Toasts.tsx).
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-6) })
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setDataDir: (dataDir) => set({ dataDir }),
  setVersion: (version) => set({ version })
}))
