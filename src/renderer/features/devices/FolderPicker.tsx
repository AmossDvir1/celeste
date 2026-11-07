import { useEffect, useState } from 'react'
import { ArrowUp, File as FileIcon, Folder } from 'lucide-react'
import type { DirEntry, FolderMode } from '@shared/devices'
import { core } from '@/api'
import { formatBytes } from '@/lib/format'
import { Modal } from '@/components/Dialog'
import { Button, Segmented, Spinner, TextInput } from '@/components/ui'
import { useDevices } from '@/stores/devices'
import { useUi } from '@/stores/ui'
import { VENDOR_NOTICE } from './parts'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

function startPath(os: string): string {
  return os === 'windows' ? '/C:/' : os === 'android' ? '/sdcard' : '/'
}

const parentOf = (path: string) => {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut) || '/'
}

/** Choose a folder on a device to use as context: read it live through the tools, or copy a snapshot. */
export function FolderPicker() {
  const deviceId = useDevices((s) => s.pickerFor)
  const device = useDevices((s) => s.devices.find((d) => d.id === s.pickerFor))
  const close = useDevices((s) => s.closePicker)
  const refresh = useDevices((s) => s.refresh)
  const pushToast = useUi((s) => s.pushToast)

  const [path, setPath] = useState('/')
  const [typed, setTyped] = useState('/')
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<FolderMode>('snapshot')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ files: number; bytes: number } | null>(null)

  useEffect(() => {
    if (!device) return
    const start = startPath(device.os)
    setPath(start)
    setTyped(start)
    setConfirm(null)
    setError(null)
    setMode('snapshot')
  }, [device?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!deviceId) return
    let stale = false
    setEntries(null)
    setError(null)
    core
      .call('devices.browse', deviceId, path)
      .then((list) => !stale && setEntries(list))
      .catch((e) => {
        if (stale) return
        setEntries([])
        setError(message(e))
      })
    return () => {
      stale = true
    }
  }, [deviceId, path])

  const go = (next: string) => {
    setPath(next)
    setTyped(next)
    setConfirm(null)
  }

  const add = async (confirmed = false) => {
    if (!deviceId) return
    setBusy(true)
    setError(null)
    try {
      const r = await core.call('devices.addFolder', deviceId, path, mode, confirmed)
      if (r.ok) {
        await refresh()
        pushToast({ text: mode === 'snapshot' ? `Copied ${r.folder.files} files from ${path}.` : `${path} added. The assistant can read it live.` })
        close()
      } else {
        setConfirm(r.needsConfirm)
      }
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={!!deviceId} onOpenChange={(o) => !o && close()} title={`Add a folder from ${device?.name ?? 'a device'}`} description="Choose the folder the assistant should be able to use as context." className="w-[min(600px,calc(100vw-48px))]">
      <div className="px-6 pt-4 pb-6">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            go(typed.trim() || '/')
          }}
        >
          <Button type="button" variant="secondary" size="md" aria-label="Up one folder" disabled={path === '/'} onClick={() => go(parentOf(path))}>
            <ArrowUp className="h-4 w-4" />
          </Button>
          <TextInput aria-label="Folder path" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono text-[13px]" />
          <Button type="submit" variant="secondary" size="md">
            Go
          </Button>
        </form>

        <div className="mt-3 h-[260px] overflow-y-auto rounded-xl border border-edge">
          {entries === null ? (
            <p className="flex items-center gap-2.5 p-5 text-[14px] text-ink-muted">
              <Spinner /> Reading the folder…
            </p>
          ) : error ? (
            <p role="alert" className="p-5 text-[13.5px] text-danger">{error}</p>
          ) : entries.length === 0 ? (
            <p className="p-5 text-[14px] text-ink-faint">This folder is empty.</p>
          ) : (
            <ul>
              {entries.map((e) => (
                <li key={e.name}>
                  {e.type === 'dir' ? (
                    <button type="button" onClick={() => go(path.endsWith('/') ? `${path}${e.name}` : `${path}/${e.name}`)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-[14px] text-ink hover:bg-hover">
                      <Folder className="h-4 w-4 shrink-0 text-accent-text" /> <span className="truncate">{e.name}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 px-4 py-2 text-[14px] text-ink-muted">
                      <FileIcon className="h-4 w-4 shrink-0" /> <span className="min-w-0 flex-1 truncate">{e.name}</span>
                      <span className="shrink-0 text-xs text-ink-faint">{formatBytes(e.size)}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <Segmented<FolderMode>
            label="How to use it"
            value={mode}
            onChange={(m) => {
              setMode(m)
              setConfirm(null)
            }}
            options={[
              { value: 'snapshot', label: 'Copy a snapshot' },
              { value: 'live', label: 'Browse live' }
            ]}
          />
          <p className="max-w-[300px] text-xs text-ink-faint">
            {mode === 'snapshot'
              ? 'Copies the folder to this computer, read only, so the assistant can search it quickly. Build folders and files over 25 MB are left out.'
              : 'Nothing is copied. The assistant reads files on the device when it needs them.'}
          </p>
        </div>

        {confirm && (
          <p role="alert" className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-[13px] text-ink">
            This folder has {confirm.files.toLocaleString()} files ({formatBytes(confirm.bytes)}). Copying that much can take a while. Copy it anyway?
          </p>
        )}
        <p className="mt-4 text-[12.5px] text-ink-faint">{VENDOR_NOTICE}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || entries === null || !!error} onClick={() => void add(!!confirm)}>
            {busy ? <Spinner /> : null} {confirm ? 'Copy anyway' : mode === 'snapshot' ? 'Copy this folder' : 'Use this folder'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
