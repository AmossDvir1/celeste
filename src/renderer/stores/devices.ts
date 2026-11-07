import { create } from 'zustand'
import type { CorePush } from '@shared/api'
import type { DeviceFolder, DeviceRecord } from '@shared/devices'
import { core } from '@/api'
import { useUi } from './ui'

interface DevicesState {
  devices: DeviceRecord[]
  folders: DeviceFolder[]
  /** Which devices each opened session has attached. */
  attached: Record<string, string[]>
  addOpen: boolean
  /** The device whose folders are being chosen, if the picker is open. */
  pickerFor: string | null

  setAddOpen: (open: boolean) => void
  openPicker: (deviceId: string) => void
  closePicker: () => void
  refresh: () => Promise<void>
  loadAttached: (sessionId: string) => Promise<void>
  attach: (sessionId: string, deviceId: string, on: boolean) => Promise<void>
  applyPush: (push: CorePush) => void
}

function report(err: unknown): void {
  useUi.getState().pushToast({ text: err instanceof Error ? err.message : 'Something went wrong.' })
}

export const useDevices = create<DevicesState>((set, get) => ({
  devices: [],
  folders: [],
  attached: {},
  addOpen: false,
  pickerFor: null,

  setAddOpen: (addOpen) => set({ addOpen }),
  openPicker: (pickerFor) => set({ pickerFor }),
  closePicker: () => set({ pickerFor: null }),

  refresh: async () => {
    try {
      const [devices, folders] = await Promise.all([core.call('devices.list'), core.call('devices.folders')])
      set({ devices, folders })
      await Promise.all(Object.keys(get().attached).map((id) => get().loadAttached(id)))
    } catch (err) {
      report(err)
    }
  },

  loadAttached: async (sessionId) => {
    try {
      const ids = await core.call('devices.attached', sessionId)
      set((s) => ({ attached: { ...s.attached, [sessionId]: ids } }))
    } catch {
      // The session may have just been deleted.
    }
  },

  attach: async (sessionId, deviceId, on) => {
    // Show the change at once, then let Core confirm it.
    set((s) => {
      const now = new Set(s.attached[sessionId] ?? [])
      if (on) now.add(deviceId)
      else now.delete(deviceId)
      return { attached: { ...s.attached, [sessionId]: [...now] } }
    })
    try {
      const ids = await core.call('devices.attach', sessionId, deviceId, on)
      set((s) => ({ attached: { ...s.attached, [sessionId]: ids } }))
    } catch (err) {
      report(err)
      await get().loadAttached(sessionId)
    }
  },

  applyPush: (push) => {
    if (push.type === 'devices') void get().refresh()
  }
}))
