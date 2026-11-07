import { useEffect, useRef, useState } from 'react'
import { Check, KeyRound, LoaderCircle, Monitor, Radar, ShieldAlert, Smartphone } from 'lucide-react'
import QRCode from 'qrcode'
import type { DeviceKind, DeviceProbe, DeviceRecord, FoundDevice, HostKeyState } from '@shared/devices'
import type { AccessLevel } from '@shared/devices'
import { core, secrets } from '@/api'
import { cn } from '@/lib/cn'
import { Modal } from '@/components/Dialog'
import { Field } from '@/components/form'
import { Button, Segmented, Spinner, TextInput } from '@/components/ui'
import { useDevices } from '@/stores/devices'
import { useUi } from '@/stores/ui'
import { DeviceGlyph, LEVELS, OS_LABEL, VENDOR_NOTICE } from './parts'

type Tab = 'find' | 'address' | 'android' | 'vm'
type Phase = 'form' | 'trust' | 'done'

interface Draft {
  kind: DeviceKind
  name: string
  host: string
  port: string
  username: string
  auth: 'password' | 'key'
  secret: string
  keyPath: string
}

const BLANK: Draft = { kind: 'ssh', name: '', host: '', port: '22', username: '', auth: 'password', secret: '', keyPath: '' }
const secretNames = (id: string) => [`device.${id}.password`, `device.${id}.passphrase`]
const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

/**
 * Adds a device in a few steps: find it or type its address, sign in, confirm the computer's fingerprint, see what
 * it is, and choose how much the assistant may do. Nothing is kept unless it ends on the last step.
 */
export function AddDeviceDialog() {
  const open = useDevices((s) => s.addOpen)
  const setOpen = useDevices((s) => s.setAddOpen)
  const refresh = useDevices((s) => s.refresh)
  const pushToast = useUi((s) => s.pushToast)

  const [tab, setTab] = useState<Tab>('address')
  const [phase, setPhase] = useState<Phase>('form')
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [hostKey, setHostKey] = useState<HostKeyState | null>(null)
  const [probe, setProbe] = useState<DeviceProbe | null>(null)
  const [level, setLevel] = useState<AccessLevel>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kept = useRef(false)

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  const reset = () => {
    setTab('address')
    setPhase('form')
    setDraft(BLANK)
    setDeviceId(null)
    setHostKey(null)
    setProbe(null)
    setLevel('read')
    setBusy(false)
    setError(null)
    kept.current = false
  }

  /** Forgets a half-added device, and the secrets stored for it. */
  const discard = async (id: string | null) => {
    if (!id) return
    await core.call('devices.remove', id).catch(() => undefined)
    await Promise.all(secretNames(id).map((n) => secrets.remove(n).catch(() => undefined)))
  }

  const close = async () => {
    void core.call('devices.cancelQrPairing').catch(() => undefined)
    if (!kept.current) await discard(deviceId)
    setOpen(false)
    reset()
  }

  /** Tests the connection for a device that exists. */
  const test = async (id: string) => {
    const r = await core.call('devices.test', id)
    if (r.ok) {
      setProbe(r.probe)
      setPhase('done')
    } else if (r.hostKey) {
      setHostKey(r.hostKey)
      setPhase('trust')
    } else {
      setError(r.error)
    }
  }

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      let id = deviceId
      if (!id) {
        const created = await core.call('devices.create', {
          name: draft.name || draft.host,
          kind: draft.kind,
          host: draft.host,
          ...(draft.kind === 'ssh' && draft.port ? { port: Number(draft.port) } : {}),
          username: draft.username,
          authMethod: draft.auth,
          ...(draft.auth === 'key' ? { keyPath: draft.keyPath } : {})
        })
        id = created.id
        setDeviceId(id)
        if (draft.auth === 'password') await secrets.set(`device.${id}.password`, draft.secret)
        else if (draft.secret) await secrets.set(`device.${id}.passphrase`, draft.secret)
      }
      await test(id)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const trust = async () => {
    if (!deviceId || hostKey?.state !== 'unknown') return
    setBusy(true)
    setError(null)
    try {
      await core.call('devices.trustKey', deviceId, hostKey.fingerprint)
      await test(deviceId)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const finish = async () => {
    if (!deviceId) return
    setBusy(true)
    try {
      await core.call('devices.update', deviceId, { accessLevel: level })
      kept.current = true
      await refresh()
      pushToast({ text: `Added ${draft.name || draft.host}.` })
      setOpen(false)
      reset()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  /** A device that paired itself (Android): carry on from the test. */
  const adopt = async (device: DeviceRecord) => {
    kept.current = false
    setDeviceId(device.id)
    set({ name: device.name, host: device.host, kind: device.kind })
    setBusy(true)
    try {
      await test(device.id)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const prefill = (found: FoundDevice) => {
    if (found.kind === 'adb') {
      setTab('android')
      set({ kind: 'adb', host: `${found.host}:${found.port}`, name: found.name })
      return
    }
    setTab('address')
    set({ kind: 'ssh', name: found.name, host: found.host, port: String(found.port || 22) })
  }

  const startVm = (found: FoundDevice) => {
    setTab('address')
    set({ kind: found.kind, name: found.name, host: found.host, port: found.kind === 'ssh' ? '22' : '0' })
    if (!found.host) setError('Type the address of this VM below. The VM product did not report one.')
  }

  return (
    <Modal open={open} onOpenChange={(o) => (o ? setOpen(true) : void close())} title="Add a device" description="Another computer, a VM, or an Android phone the assistant can work on." className="w-[min(640px,calc(100vw-48px))]">
      <div className="max-h-[calc(88vh-90px)] overflow-y-auto px-6 pt-4 pb-6">
        {phase === 'form' && (
          <>
            <Segmented<Tab>
              label="How to add"
              value={tab}
              onChange={(t) => {
                setTab(t)
                setError(null)
              }}
              options={[
                { value: 'find', label: 'Find nearby', icon: <Radar className="h-3.5 w-3.5" /> },
                { value: 'address', label: 'Enter address', icon: <Monitor className="h-3.5 w-3.5" /> },
                { value: 'android', label: 'Android phone', icon: <Smartphone className="h-3.5 w-3.5" /> },
                { value: 'vm', label: 'Local VM', icon: <Monitor className="h-3.5 w-3.5" /> }
              ]}
            />
            <div className="mt-5">
              {tab === 'find' && <Discover scope="network" onPick={prefill} />}
              {tab === 'vm' && <Discover scope="vm" onPick={startVm} />}
              {tab === 'address' && <ConnectForm draft={draft} set={set} busy={busy} error={error} onConnect={connect} />}
              {tab === 'android' && <AndroidPairing draft={draft} set={set} onPaired={adopt} />}
            </div>
          </>
        )}

        {phase === 'trust' && hostKey && (
          <div>
            <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <div className="text-[14px] text-ink">
                {hostKey.state === 'unknown' ? (
                  <>
                    <div className="font-medium">Is this the right computer?</div>
                    <p className="mt-1 text-ink-muted">
                      This is the first time Celeste connects to <b className="text-ink">{draft.host}</b>. Its fingerprint is below. If you can, compare it with the one on that computer. Celeste remembers it, and refuses to connect if it ever changes.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="font-medium">This computer’s identity has changed</div>
                    <p className="mt-1 text-ink-muted">It is not the computer you confirmed before. It may have been reinstalled, or something may be in the way. Nothing was sent.</p>
                  </>
                )}
              </div>
            </div>
            <code className="selectable mt-4 block rounded-lg border border-edge bg-field px-3 py-2.5 font-mono text-[12.5px] break-all text-ink">{hostKey.fingerprint}</code>
            {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => void close()}>
                Cancel
              </Button>
              {hostKey.state === 'unknown' && (
                <Button variant="primary" disabled={busy} onClick={trust}>
                  {busy ? <Spinner /> : <Check className="h-4 w-4" />} Yes, trust it
                </Button>
              )}
            </div>
          </div>
        )}

        {phase === 'done' && probe && (
          <div>
            <div className="flex items-center gap-3 rounded-xl border border-success/30 bg-success/10 p-4">
              <Check className="h-5 w-5 shrink-0 text-success" />
              <div className="text-[14px] text-ink">
                Connected to <b>{probe.hostname}</b> as <b>{probe.user}</b>
                <span className="text-ink-muted"> · {OS_LABEL[probe.os] ?? probe.os}</span>
              </div>
            </div>
            <h3 className="mt-6 text-[14px] font-medium text-ink">How much may the assistant do on it?</h3>
            <div role="radiogroup" aria-label="Access level" className="mt-2 space-y-2">
              {LEVELS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  role="radio"
                  aria-checked={level === l.value}
                  onClick={() => setLevel(l.value)}
                  className={cn('flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors', level === l.value ? 'border-accent bg-accent-soft' : 'border-edge hover:border-edge-strong')}
                >
                  <span className={cn('mt-0.5 h-4 w-4 shrink-0 rounded-full border-2', level === l.value ? 'border-accent bg-accent' : 'border-edge-strong')} />
                  <span>
                    <span className="block text-[14px] text-ink">{l.label}</span>
                    <span className="block text-[13px] text-ink-muted">{l.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-4 text-[12.5px] text-ink-faint">{VENDOR_NOTICE} You can change the level any time in Settings, Devices.</p>
            {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => void close()}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy} onClick={finish}>
                {busy ? <Spinner /> : null} Add device
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** The sign-in form for a computer reached over SSH, or a Hyper-V VM. */
function ConnectForm({ draft, set, busy, error, onConnect }: { draft: Draft; set: (p: Partial<Draft>) => void; busy: boolean; error: string | null; onConnect: () => void }) {
  const hyperv = draft.kind === 'hyperv'
  const ready = draft.host.trim() && draft.username.trim() && (draft.auth === 'key' ? draft.keyPath.trim() : draft.secret) && (!hyperv || draft.secret)
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !busy) onConnect()
      }}
    >
      {hyperv && <p className="text-[13px] text-ink-muted">A Windows VM on this PC, reached through Hyper-V. Needs a Hyper-V administrator, and the VM’s own login.</p>}
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <Field label={hyperv ? 'VM name' : 'Address or name'} hint={hyperv ? undefined : 'An IP address like 192.168.1.20, or a name like build-server.local'}>
          {(id) => <TextInput id={id} value={draft.host} onChange={(e) => set({ host: e.target.value })} placeholder={hyperv ? 'Build VM' : '192.168.1.20'} autoFocus />}
        </Field>
        {!hyperv && <Field label="Port">{(id) => <TextInput id={id} inputMode="numeric" value={draft.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '') })} />}</Field>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name to show" hint="Optional">
          {(id) => <TextInput id={id} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="build-vm" />}
        </Field>
        <Field label="User name">{(id) => <TextInput id={id} value={draft.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />}</Field>
      </div>
      {!hyperv && (
        <Segmented<'password' | 'key'>
          label="Sign in with"
          value={draft.auth}
          onChange={(auth) => set({ auth, secret: '' })}
          options={[
            { value: 'password', label: 'Password' },
            { value: 'key', label: 'Key file', icon: <KeyRound className="h-3.5 w-3.5" /> }
          ]}
        />
      )}
      {draft.auth === 'key' && !hyperv && (
        <Field label="Path to the private key" hint="Celeste uses the file where it is and never copies it.">
          {(id) => <TextInput id={id} value={draft.keyPath} onChange={(e) => set({ keyPath: e.target.value })} placeholder="C:\Users\you\.ssh\id_ed25519" />}
        </Field>
      )}
      <Field label={draft.auth === 'key' && !hyperv ? 'Key passphrase (if it has one)' : 'Password'} hint="Stored encrypted by your operating system. It never reaches the assistant.">
        {(id) => <TextInput id={id} type="password" autoComplete="off" value={draft.secret} onChange={(e) => set({ secret: e.target.value })} />}
      </Field>
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      <div className="flex justify-end pt-1">
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} Connect
        </Button>
      </div>
    </form>
  )
}

/** Things found on the network, or VMs on this computer. */
function Discover({ scope, onPick }: { scope: 'network' | 'vm'; onPick: (found: FoundDevice) => void }) {
  const [found, setFound] = useState<FoundDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    setFound(null)
    core
      .call('devices.discover')
      .then((all) => !stale && setFound(all))
      .catch((e) => !stale && setError(message(e)))
    return () => {
      stale = true
    }
  }, [scope])

  const list = (found ?? []).filter((f) => (scope === 'network' ? f.source.startsWith('Announced') : !f.source.startsWith('Announced')))
  if (error) return <p className="text-[13px] text-danger">{error}</p>
  if (!found) {
    return (
      <p className="flex items-center gap-2.5 py-6 text-[14px] text-ink-muted">
        <Spinner /> {scope === 'network' ? 'Listening for devices on your network…' : 'Looking for virtual machines on this computer…'}
      </p>
    )
  }
  if (list.length === 0) {
    return (
      <div className="rounded-xl border border-edge p-5 text-[14px] text-ink-muted">
        {scope === 'network'
          ? 'Nothing announced itself. Many computers do not, and VPNs and guest Wi-Fi block announcements. Use “Enter an address”, which always works.'
          : 'No virtual machines were found. Hyper-V needs Celeste to run as an administrator to list them. You can still use “Enter an address” for any VM that has an IP address.'}
      </div>
    )
  }
  return (
    <ul className="divide-y divide-edge/70 rounded-xl border border-edge">
      {list.map((f) => (
        <li key={f.key}>
          <button type="button" onClick={() => onPick(f)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover">
            <DeviceGlyph kind={f.kind} className="text-ink-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">{f.name}</span>
              <span className="block truncate text-xs text-ink-muted">
                {f.host ? `${f.host}${f.port ? `:${f.port}` : ''} · ` : ''}
                {f.pairing ? 'Ready to pair · ' : ''}
                {f.source}
              </span>
            </span>
            <span className="text-[13px] text-accent-text">{f.pairing ? 'Pair' : 'Add'}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Android wireless debugging: scan a QR code, or type the code the phone shows. */
function AndroidPairing({ draft, set, onPaired }: { draft: Draft; set: (p: Partial<Draft>) => void; onPaired: (d: DeviceRecord) => void }) {
  const [mode, setMode] = useState<'qr' | 'code'>('qr')
  const [name, setName] = useState(draft.name || 'My phone')
  const [address, setAddress] = useState(draft.host.includes(':') ? draft.host : '')
  const [code, setCode] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const known = useRef<Set<string> | null>(null)

  useEffect(() => () => void core.call('devices.cancelQrPairing').catch(() => undefined), [])

  // The phone adds itself once it has scanned the code. Watch for the new device.
  useEffect(() => {
    if (!qr) return
    const timer = setInterval(() => {
      void core.call('devices.list').then((all) => {
        const fresh = all.find((d) => d.kind === 'adb' && !known.current?.has(d.id))
        if (fresh) {
          clearInterval(timer)
          onPaired(fresh)
        }
      })
    }, 1500)
    return () => clearInterval(timer)
  }, [qr, onPaired])

  const showQr = async () => {
    setBusy(true)
    setError(null)
    try {
      known.current = new Set((await core.call('devices.list')).map((d) => d.id))
      const { payload } = await core.call('devices.startQrPairing', name)
      setQr(await QRCode.toDataURL(payload, { margin: 1, width: 224, errorCorrectionLevel: 'M' }))
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const pairWithCode = async () => {
    setBusy(true)
    setError(null)
    try {
      onPaired(await core.call('devices.pairByCode', address.trim(), code.trim(), name.trim() || 'My phone'))
      set({ name })
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-[13.5px] text-ink-muted">
        <li>Put the phone on the same Wi-Fi as this computer.</li>
        <li>On the phone: Settings, Developer options, switch on <b className="text-ink">Wireless debugging</b>. (Android 11 or later.)</li>
        <li>Tap <b className="text-ink">{mode === 'qr' ? 'Pair device with QR code' : 'Pair device with pairing code'}</b> and {mode === 'qr' ? 'scan the code below' : 'enter what it shows here'}.</li>
      </ol>
      <Segmented<'qr' | 'code'> label="Pair with" value={mode} onChange={setMode} options={[{ value: 'qr', label: 'QR code' }, { value: 'code', label: 'Pairing code' }]} />
      <Field label="Name to show">{(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      {mode === 'qr' ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-edge p-4">
          {qr ? (
            <>
              <img src={qr} alt="QR code to scan on the phone" width={224} height={224} className="rounded-lg bg-white" />
              <p className="flex items-center gap-2 text-[13px] text-ink-muted">
                <Spinner /> Waiting for the phone to scan it…
              </p>
            </>
          ) : (
            <Button variant="primary" disabled={busy || !name.trim()} onClick={showQr}>
              {busy ? <Spinner /> : null} Show QR code
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Address and port" hint="From the pairing screen, like 192.168.1.20:37099">
            {(id) => <TextInput id={id} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:37099" />}
          </Field>
          <Field label="Pairing code">{(id) => <TextInput id={id} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />}</Field>
          <div className="col-span-2 flex justify-end">
            <Button variant="primary" disabled={busy || !address.trim() || code.length !== 6} onClick={pairWithCode}>
              {busy ? <Spinner /> : null} Pair
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </div>
  )
}
