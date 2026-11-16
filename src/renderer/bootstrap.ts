import { core } from '@/api'
import { useDevices } from '@/stores/devices'
import { useDrafts } from '@/stores/drafts'
import { useMcp } from '@/stores/mcp'
import { useModels } from '@/stores/models'
import { usePhone } from '@/stores/phone'
import { useRuns } from '@/stores/runs'
import { useSchedules } from '@/stores/schedules'
import { useSessions } from '@/stores/sessions'
import { setSaveErrorHandler, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { useUsage } from '@/stores/usage'
import { useVendors } from '@/stores/vendors'
import { useWorkflows } from '@/stores/workflows'

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
    useMcp.getState().applyPush(push)
    useWorkflows.getState().applyPush(push)
    useRuns.getState().applyPush(push)
    usePhone.getState().applyPush(push)
    useUsage.getState().applyPush(push)
    useSchedules.getState().applyPush(push)
    useSettings.getState().applyPush(push)
  })
  // A phone may already be waiting for an answer from before this window opened.
  void usePhone.getState().refresh()
  // What Core knows about each vendor's usage, at once; the strip asks for a fresh reading itself.
  void useUsage.getState().load()

  const data = await within(core.call('app.bootstrap'), 15_000)

  useSettings.getState().load(data.settings)
  await useVendors.getState().init(data.vendors)
  // The composer's model must be one that exists, whenever the list changes.
  useModels.subscribe(() => useUi.getState().fitDraftToModels())
  // A vendor's own model list, only for someone who connected it: asking starts its program.
  const connected = (['copilot', 'claude', 'openai', 'gemini'] as const).filter((v) => useVendors.getState().vendors[v].status === 'connected')
  if (connected.length) void useModels.getState().refresh([...connected])
  useSessions.getState().init(data.sessions)
  useDrafts.getState().init(data.drafts)
  await useDevices.getState().refresh()
  await useMcp.getState().refresh()
  await useWorkflows.getState().refresh()
  await useSchedules.getState().refresh()
  useUi.getState().setDataDir(data.dataDir)
  useUi.getState().setVersion(data.version)
  useUi.getState().resetDraft()

  // Closing the window or quitting waits for this, so the last keystrokes are saved.
  window.celeste?.onBeforeQuit(() => useDrafts.getState().flush())
}
