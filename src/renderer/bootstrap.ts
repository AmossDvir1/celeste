import type { SettingsPatch } from '@shared/api'
import { core } from '@/api'
import { useDevices } from '@/stores/devices'
import { useDrafts } from '@/stores/drafts'
import { useModels } from '@/stores/models'
import { useSessions } from '@/stores/sessions'
import { setSaveErrorHandler, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { useVendors } from '@/stores/vendors'

const LEGACY_KEY = 'celeste.settings'

/** Settings the design preview kept in the browser's storage, before they were saved by Core. */
function legacySettings(): SettingsPatch | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    const state = raw ? (JSON.parse(raw) as { state?: Record<string, unknown> }).state : null
    if (!state || typeof state !== 'object') return null
    const patch: SettingsPatch = {}
    if (state.theme === 'dark' || state.theme === 'light' || state.theme === 'system') patch.theme = state.theme
    if (typeof state.userName === 'string') patch.userName = state.userName
    if (typeof state.wizardDone === 'boolean') patch.wizardDone = state.wizardDone
    if (typeof state.sidebarCollapsed === 'boolean') patch.sidebarCollapsed = state.sidebarCollapsed
    const d = state.defaults as Record<string, unknown> | undefined
    if (d && typeof d === 'object') {
      patch.defaults = {}
      if (typeof d.model === 'string') patch.defaults.model = d.model
      if (d.approval === 'auto' || d.approval === 'edits' || d.approval === 'ask' || d.approval === 'plan') patch.defaults.approval = d.approval
      if (typeof d.projectsFolder === 'string') patch.defaults.projectsFolder = d.projectsFolder
    }
    return patch
  } catch {
    return null
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Celeste’s storage did not answer.')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * Loads everything the window starts with from Core: settings, vendors, the session list and drafts.
 * The first screen is drawn after this, so it never shows defaults that are then replaced.
 */
export async function bootstrap(): Promise<void> {
  setSaveErrorHandler(() => useUi.getState().pushToast({ text: 'Could not save that setting.' }))
  core.onPush((push) => {
    useSessions.getState().applyPush(push)
    useDevices.getState().applyPush(push)
    useVendors.getState().applyPush(push)
  })

  const data = await within(core.call('app.bootstrap'), 15_000)

  let settings = data.settings
  if (!data.settingsStored) {
    const legacy = legacySettings()
    if (legacy) {
      settings = await core.call('settings.patch', legacy)
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* nothing to clean up */
      }
    }
  }

  useSettings.getState().load(settings)
  await useVendors.getState().init(data.vendors)
  // A vendor's own model list, only for someone who connected it: asking starts its program.
  const connected = (['copilot', 'claude'] as const).filter((v) => useVendors.getState().vendors[v].status === 'connected')
  if (connected.length) void useModels.getState().refresh([...connected])
  useSessions.getState().init(data.sessions)
  useDrafts.getState().init(data.drafts)
  await useDevices.getState().refresh()
  useUi.getState().setDataDir(data.dataDir)
  useUi.getState().resetDraft()

  // Closing the window or quitting waits for this, so the last keystrokes are saved.
  window.celeste?.onBeforeQuit(() => useDrafts.getState().flush())
}
