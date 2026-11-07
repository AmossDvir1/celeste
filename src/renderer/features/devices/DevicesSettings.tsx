import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, FolderPlus, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AccessLevel, DeviceActivity, DeviceRecord, HostKeyState } from '@shared/devices'
import { core, secrets } from '@/api'
import { cn } from '@/lib/cn'
import { formatBytes, formatDay, formatTime } from '@/lib/format'
import { SelectField } from '@/components/form'
import { Button, Spinner } from '@/components/ui'
import { useDevices } from '@/stores/devices'
import { useUi } from '@/stores/ui'
import { AccessBadge, DeviceGlyph, LEVELS, OS_LABEL, VENDOR_NOTICE } from './parts'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

function address(d: DeviceRecord): string {
  if (d.kind === 'hyperv') return `Hyper-V VM “${d.host}”`
  return d.kind === 'adb' ? `${d.host}:${d.port}` : `${d.username}@${d.host}${d.port === 22 ? '' : `:${d.port}`}`
}

/** Settings, Devices: every device, how much the assistant may do on it, its folders and what it has done. */
export function DevicesSettings() {
  const devices = useDevices((s) => s.devices)
  const setAddOpen = useDevices((s) => s.setAddOpen)

  return (
    <div className="space-y-6">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        A device is invisible to a chat until you attach it there. Commands on a device ask for your approval, unless you give that device full access.
      </p>
      {devices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-edge-strong p-8 text-center">
          <div className="text-[15px] text-ink">No devices yet</div>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-muted">Add a VM or another computer by its address, find one on your network, or pair an Android phone.</p>
          <Button variant="primary" className="mt-4" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add a device
          </Button>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {devices.map((d) => (
              <DeviceCard key={d.id} device={d} />
            ))}
          </ul>
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add a device
          </Button>
        </>
      )}
      <p className="text-[13px] leading-relaxed text-ink-faint">{VENDOR_NOTICE}</p>
    </div>
  )
}

function DeviceCard({ device }: { device: DeviceRecord }) {
  const allFolders = useDevices((s) => s.folders)
  // Filtered here, not in the selector: a selector that returns a new array every time re-renders forever.
  const folders = useMemo(() => allFolders.filter((f) => f.deviceId === device.id), [allFolders, device.id])
  const openPicker = useDevices((s) => s.openPicker)
  const refresh = useDevices((s) => s.refresh)
  const pushToast = useUi((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [hostKey, setHostKey] = useState<HostKeyState | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [activity, setActivity] = useState<DeviceActivity[]>([])

  useEffect(() => {
    if (!open) return
    void core.call('devices.activity', device.id).then(setActivity).catch(() => undefined)
  }, [open, device.id, device.lastSeenAt, folders.length])

  const test = async () => {
    setTesting(true)
    setNote(null)
    setHostKey(null)
    try {
      const r = await core.call('devices.test', device.id)
      if (r.ok) setNote({ ok: true, text: `Connected as ${r.probe.user} on ${r.probe.hostname}.` })
      else if (r.hostKey) setHostKey(r.hostKey)
      else setNote({ ok: false, text: r.error })
    } catch (e) {
      setNote({ ok: false, text: message(e) })
    } finally {
      setTesting(false)
    }
  }

  const trust = async () => {
    if (hostKey?.state !== 'unknown' && hostKey?.state !== 'changed') return
    await core.call('devices.trustKey', device.id, hostKey.fingerprint)
    setHostKey(null)
    await test()
  }

  const remove = async () => {
    await core.call('devices.remove', device.id)
    await Promise.all([`device.${device.id}.password`, `device.${device.id}.passphrase`].map((n) => secrets.remove(n).catch(() => undefined)))
    await refresh()
    pushToast({ text: `Removed ${device.name}.` })
  }

  return (
    <li className={cn('rounded-xl border bg-field/50 p-4', device.accessLevel === 'full' ? 'border-warning/40' : 'border-edge')}>
      <div className="flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-edge bg-raised text-ink">
          <DeviceGlyph kind={device.kind} className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-medium text-ink">{device.name}</h3>
            <AccessBadge level={device.accessLevel} />
          </div>
          <p className="mt-0.5 truncate text-[13px] text-ink-muted">
            {address(device)} · {OS_LABEL[device.os]}
            {device.lastSeenAt ? ` · last connected ${formatDay(device.lastSeenAt)} ${formatTime(device.lastSeenAt)}` : ' · not tested yet'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SelectField
            aria-label={`Access level for ${device.name}`}
            value={device.accessLevel}
            onChange={(e) => void core.call('devices.update', device.id, { accessLevel: e.target.value as AccessLevel }).then(refresh)}
            className="h-9 w-[132px] text-[13px]"
          >
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </SelectField>
          <Button variant="secondary" size="md" disabled={testing} onClick={test}>
            {testing ? <Spinner /> : null} Test
          </Button>
        </div>
      </div>

      {note && (
        <p role="status" className={cn('mt-3 text-[13px]', note.ok ? 'text-success' : 'text-danger')}>
          {note.text}
        </p>
      )}
      {hostKey && (
        <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px] text-ink">
          <div className="font-medium">{hostKey.state === 'unknown' ? 'Confirm this computer' : 'This computer’s identity has changed'}</div>
          <p className="mt-1 text-ink-muted">
            {hostKey.state === 'unknown'
              ? 'Its fingerprint is below. Celeste will remember it.'
              : 'It is not the computer you confirmed before. It may have been reinstalled, or something may be in the way. Only trust the new fingerprint if you know why it changed.'}
          </p>
          <code className="selectable mt-2 block rounded-md border border-edge bg-field px-2.5 py-2 font-mono text-[12px] break-all">{hostKey.fingerprint}</code>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant={hostKey.state === 'changed' ? 'danger' : 'primary'} onClick={() => void trust()}>
              {hostKey.state === 'changed' ? 'Trust the new key' : 'Trust it'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setHostKey(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink">
          <ChevronDown className={cn('h-4 w-4 transition-transform', !open && '-rotate-90')} />
          Folders and activity
          {folders.length > 0 && <span className="text-ink-faint">({folders.length} folder{folders.length > 1 ? 's' : ''})</span>}
        </button>
        {confirmRemove ? (
          <span className="flex items-center gap-2 text-[13px]">
            <span className="text-ink-muted">Remove {device.name}?</span>
            <Button size="sm" variant="danger" onClick={() => void remove()}>
              Remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" aria-label={`Remove ${device.name}`} onClick={() => setConfirmRemove(true)}>
            <Trash2 className="h-4 w-4" /> Remove
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-4 border-t border-edge pt-3">
          <div>
            <div className="flex items-center justify-between">
              <h4 className="text-[13px] font-medium text-ink">Folders</h4>
              <Button size="sm" variant="secondary" onClick={() => openPicker(device.id)}>
                <FolderPlus className="h-4 w-4" /> Add a folder
              </Button>
            </div>
            {folders.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-faint">No folders yet. Add one to give the assistant context from this device.</p>
            ) : (
              <ul className="mt-2 divide-y divide-edge/70 rounded-lg border border-edge">
                {folders.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-ink">{f.path}</span>
                      <span className="block text-xs text-ink-faint">
                        {f.mode === 'live' ? 'Read live through the tools' : `Snapshot · ${f.files} files · ${formatBytes(f.bytes)} · copied ${f.snapshotAt ? `${formatDay(f.snapshotAt)} ${formatTime(f.snapshotAt)}` : 'never'}`}
                      </span>
                    </span>
                    {f.mode === 'snapshot' && (
                      <Button size="sm" variant="ghost" aria-label={`Refresh ${f.path}`} onClick={() => void core.call('devices.refreshFolder', f.id).then(refresh).catch((e) => pushToast({ text: message(e) }))}>
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" aria-label={`Remove folder ${f.path}`} onClick={() => void core.call('devices.removeFolder', f.id).then(refresh)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="text-[13px] font-medium text-ink">Recent activity</h4>
            {activity.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-faint">Nothing yet.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {activity.slice(0, 8).map((a) => (
                  <li key={a.id} className="flex items-baseline gap-2 text-[12.5px]">
                    <span className="w-[88px] shrink-0 text-ink-faint">{formatDay(a.at)} {formatTime(a.at)}</span>
                    <span className={cn('shrink-0 font-mono', a.ok ? 'text-ink-muted' : 'text-danger')}>{a.tool}</span>
                    <span className="min-w-0 truncate text-ink-muted" title={a.summary}>{a.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
