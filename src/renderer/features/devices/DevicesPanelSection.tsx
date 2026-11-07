import { useEffect } from 'react'
import { FolderPlus, Plus, Settings2 } from 'lucide-react'
import { Button, Switch } from '@/components/ui'
import { useDevices } from '@/stores/devices'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { AccessBadge, DeviceGlyph, VENDOR_NOTICE } from './parts'

/** The Devices part of Tools & Integrations: which devices this chat may use. */
export function DevicesPanelSection() {
  const mode = useUi((s) => s.mode)
  const openSettings = useUi((s) => s.openSettings)
  const sessionId = useSessions((s) => (mode === 'workflows' ? null : s.active[mode]))
  const devices = useDevices((s) => s.devices)
  const folders = useDevices((s) => s.folders)
  const attached = useDevices((s) => (sessionId ? s.attached[sessionId] : undefined))
  const setAddOpen = useDevices((s) => s.setAddOpen)
  const openPicker = useDevices((s) => s.openPicker)
  const attach = useDevices((s) => s.attach)
  const loadAttached = useDevices((s) => s.loadAttached)

  useEffect(() => {
    if (sessionId) void loadAttached(sessionId)
  }, [sessionId, loadAttached])

  return (
    <section aria-label="Devices" className="border-b border-edge px-4 pt-3 pb-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-medium tracking-wide text-ink-muted uppercase">Devices</h3>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" aria-label="Add a device" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Manage devices" onClick={() => openSettings('devices')}>
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {devices.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-muted">No devices yet. Add a VM, another computer or an Android phone, and the assistant can look at it or work on it, with your approval.</p>
      ) : !sessionId ? (
        <p className="mt-2 text-[13px] text-ink-muted">Start or open a chat to attach a device to it.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {devices.map((d) => {
            const on = attached?.includes(d.id) ?? false
            const mine = folders.filter((f) => f.deviceId === d.id)
            return (
              <li key={d.id} className="rounded-xl px-2 py-2">
                <div className="flex items-center gap-3">
                  <DeviceGlyph kind={d.kind} className="shrink-0 text-ink-muted" />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[14px] text-ink">{d.name}</span>
                    <AccessBadge level={d.accessLevel} className="mt-1" />
                  </span>
                  <Switch label={`${d.name} attached to this chat`} checked={on} onCheckedChange={(v) => void attach(sessionId, d.id, v)} />
                </div>
                {on && (
                  <div className="mt-2 ml-8 space-y-1">
                    {mine.map((f) => (
                      <div key={f.id} className="truncate font-mono text-xs text-ink-muted" title={f.path}>
                        {f.path} <span className="font-sans text-ink-faint">· {f.mode === 'live' ? 'live' : 'snapshot'}</span>
                      </div>
                    ))}
                    <button type="button" onClick={() => openPicker(d.id)} className="inline-flex items-center gap-1.5 text-xs text-accent-text hover:underline">
                      <FolderPlus className="h-3.5 w-3.5" /> Add a folder
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">{VENDOR_NOTICE}</p>
    </section>
  )
}
