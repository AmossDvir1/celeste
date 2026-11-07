import { create } from 'zustand'
import type { AppSettings, SettingsPatch, ThemePref } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { core } from '@/api'

export type { ThemePref }

interface SettingsState extends AppSettings {
  /** Replaces everything with what Core has saved. Used once at start-up. */
  load: (settings: AppSettings) => void
  set: (patch: Partial<Omit<AppSettings, 'defaults'>>) => void
  setDefaults: (patch: Partial<AppSettings['defaults']>) => void
}

// Set at start-up to show a message. Not imported from the UI store, which already imports this one.
let onSaveError: () => void = () => {}
export const setSaveErrorHandler = (handler: () => void): void => {
  onSaveError = handler
}

/** The screen changes at once and Core saves it. If saving fails the person is told, since it would be lost. */
const save = (patch: SettingsPatch): void => void core.call('settings.patch', patch).catch(() => onSaveError())

export const useSettings = create<SettingsState>()((set) => ({
  ...DEFAULT_SETTINGS,
  load: (settings) => set(settings),
  set: (patch) => {
    set(patch)
    save(patch)
  },
  setDefaults: (patch) => {
    set((s) => ({ defaults: { ...s.defaults, ...patch } }))
    save({ defaults: patch })
  }
}))

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

const WINDOW_COLORS = {
  dark: { color: '#080c17', symbolColor: '#aeb8d1' },
  light: { color: '#f7f8fc', symbolColor: '#526080' }
}

/** Kept in the browser's own storage too, so the next start shows the right theme before Core has answered. */
const THEME_MIRROR = 'celeste.theme'

export function mirroredTheme(): ThemePref | null {
  try {
    const value = localStorage.getItem(THEME_MIRROR)
    return value === 'dark' || value === 'light' || value === 'system' ? value : null
  } catch {
    return null
  }
}

export function applyTheme(pref: ThemePref): void {
  const theme = resolveTheme(pref)
  document.documentElement.dataset.theme = theme
  window.celeste?.setTheme(WINDOW_COLORS[theme])
  try {
    localStorage.setItem(THEME_MIRROR, pref)
  } catch {
    /* storage can be blocked: the theme still applies, it just flashes on the next start */
  }
}
