import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ApprovalMode } from '@shared/agent'

export type ThemePref = 'dark' | 'light' | 'system'

interface SettingsState {
  theme: ThemePref
  userName: string
  wizardDone: boolean
  sidebarCollapsed: boolean
  defaults: { model: string; approval: ApprovalMode; projectsFolder: string }
  set: (patch: Partial<Pick<SettingsState, 'theme' | 'userName' | 'wizardDone' | 'sidebarCollapsed'>>) => void
  setDefaults: (patch: Partial<SettingsState['defaults']>) => void
  reset: () => void
}

// Browser storage can be missing or throw (private windows, blocked site data), so every access is guarded.
const safeStorage = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* ignore */
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  }
}

const INITIAL = {
  theme: 'dark' as ThemePref,
  userName: 'Amoss',
  wizardDone: false,
  sidebarCollapsed: false,
  defaults: { model: 'copilot-auto', approval: 'auto' as ApprovalMode, projectsFolder: 'D:\\Projects' }
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...INITIAL,
      set: (patch) => set(patch),
      setDefaults: (patch) => set((s) => ({ defaults: { ...s.defaults, ...patch } })),
      reset: () => set({ ...INITIAL })
    }),
    { name: 'celeste.settings', storage: createJSONStorage(() => safeStorage), version: 1 }
  )
)

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

const WINDOW_COLORS = {
  dark: { color: '#080c17', symbolColor: '#aeb8d1' },
  light: { color: '#f7f8fc', symbolColor: '#526080' }
}

export function applyTheme(pref: ThemePref): void {
  const theme = resolveTheme(pref)
  document.documentElement.dataset.theme = theme
  window.celeste?.setTheme(WINDOW_COLORS[theme])
}
