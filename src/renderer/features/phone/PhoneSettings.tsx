import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Smartphone, Trash2 } from 'lucide-react'
import { Button, Switch } from '@/components/ui'
import { usePhone } from '@/stores/phone'

const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })

/** Settings → Phone: let the Android app connect, the QR code that installs it, and the phones that may connect. */
export function PhoneSettings() {
  const status = usePhone((s) => s.status)
  const refresh = usePhone((s) => s.refresh)
  const setEnabled = usePhone((s) => s.setEnabled)
  const remove = usePhone((s) => s.remove)
  const setWatch = usePhone((s) => s.setWatch)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const url = status?.installUrl ?? null
  useEffect(() => {
    let live = true
    if (!url) setQr(null)
    else void QRCode.toDataURL(url, { margin: 1, width: 208, errorCorrectionLevel: 'M' }).then((d) => live && setQr(d))
    return () => {
      live = false
    }
  }, [url])

  if (!status) return <p className="text-[13px] text-ink-faint">Phones can connect from the Celeste app only.</p>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-6">
        <div>
          <div className="text-[14px] text-ink">Let my phone connect</div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">
            Celeste listens on your Wi-Fi while this is on. A phone has to be allowed here once, and can then chat, follow your sessions and answer
            approvals. It cannot change settings, sign-ins or devices.
          </p>
        </div>
        <Switch
          label="Let my phone connect"
          checked={status.enabled}
          onCheckedChange={(on) => {
            if (busy) return
            setBusy(true)
            void setEnabled(on).finally(() => setBusy(false))
          }}
        />
      </div>

      {status.error && <p className="text-[13px] text-danger">{status.error}</p>}
      {status.network && (
        <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-ink">
          {status.network}
        </p>
      )}

      {status.relay !== 'off' && (
        <p className="text-[12.5px] text-ink-muted">
          {status.relay === 'connected'
            ? 'Away from home: your phone reaches this computer through Celeste’s relay, which can read nothing it passes.'
            : 'Away from home: connecting to Celeste’s relay…'}
        </p>
      )}

      {status.enabled && status.running && (
        <div className="flex gap-5 rounded-xl border border-edge p-4">
          <div className="grid h-[208px] w-[208px] shrink-0 place-items-center rounded-lg bg-white">
            {qr ? <img src={qr} alt="QR code to scan with the phone's camera" width={208} height={208} className="rounded-lg" /> : null}
          </div>
          <div className="min-w-0 space-y-2 text-[13.5px] text-ink-muted">
            <div className="text-[14px] font-medium text-ink">Connect an Android phone</div>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Put the phone on the same Wi-Fi as this computer.</li>
              <li>Scan this code with the phone’s camera, and install the app from the page it opens.</li>
              <li>Open the app. It finds this computer by itself; compare the three pictures and press <b className="text-ink">Allow</b> here.</li>
            </ol>
            {!status.apk && <p className="text-warning">The app file is not on this computer yet, so the page cannot offer it. Build it from the project’s phone folder.</p>}
            <p className="text-[12.5px] text-ink-faint">
              Address: {status.addresses[0] ?? 'no Wi-Fi address'}:{status.port}
              {status.addresses.length > 1 ? ` (also ${status.addresses.slice(1).join(', ')})` : ''}. If Windows asks, allow Celeste on private networks.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[13px] text-ink-muted">Phones that may connect</div>
        {status.phones.length === 0 ? (
          <p className="text-[13px] text-ink-faint">None yet.</p>
        ) : (
          <ul className="divide-y divide-edge/70 rounded-xl border border-edge">
            {status.phones.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <Smartphone className="h-4 w-4 text-ink-soft" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-ink">{p.name}</div>
                  <div className="text-[12.5px] text-ink-faint">
                    Allowed {when(p.pairedAt)} · last seen {when(p.lastSeen)}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-[12.5px] text-ink-muted" title="While the assistant is using this computer, this phone can show its screen live. Off by default: the screen can show private things.">
                  Show my screen on it
                  <Switch label={`Show the computer’s screen on ${p.name}`} checked={p.watch === true} onCheckedChange={(on) => void setWatch(p.id, on)} />
                </label>
                <Button variant="danger" size="sm" onClick={() => void remove(p.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[12.5px] leading-relaxed text-ink-faint">
        Everything between the phone and this computer is encrypted end to end, and nothing goes through a server. Away from home the phone cannot
        reach this computer yet.
      </p>
    </div>
  )
}
