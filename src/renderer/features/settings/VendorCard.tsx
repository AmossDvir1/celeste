import { useState } from 'react'
import { Check, KeyRound } from 'lucide-react'
import type { VendorId } from '@shared/agent'
import { cn } from '@/lib/cn'
import { Badge, Button, Spinner, TextInput } from '@/components/ui'
import { VendorTile } from '@/components/VendorLogo'
import { VENDORS } from '@/mocks/models'
import { useVendors } from '@/stores/vendors'

/** One Connect button per vendor. It opens the browser, you authorize there, and the card turns to Connected. */
export function VendorCard({ id, compact }: { id: VendorId; compact?: boolean }) {
  const meta = VENDORS[id]
  const v = useVendors((s) => s.vendors[id])
  const connect = useVendors((s) => s.connect)
  const cancel = useVendors((s) => s.cancel)
  const saveKey = useVendors((s) => s.saveKey)
  const disconnect = useVendors((s) => s.disconnect)
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')

  const status = {
    'not-installed': 'Not on this computer yet. Celeste downloads it when you connect.',
    ready: meta.blurb,
    downloading: `Downloading… ${Math.round((v.progress ?? 0) * 100)}%`,
    waiting: 'Waiting for you in your browser…',
    connected: v.account ? `Connected · ${v.account}` : 'Connected'
  }[v.status]

  return (
    <div
      className={cn(
        'rounded-xl border bg-field/50 p-4',
        v.status === 'connected' ? 'border-success/30' : v.status === 'waiting' || v.status === 'downloading' ? 'border-accent-edge' : 'border-edge'
      )}
    >
      <div className="flex items-start gap-3.5">
        <VendorTile id={id} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-medium text-ink">{meta.name}</h3>
            {v.status === 'connected' && (
              <Badge tone="success">
                <Check className="h-3 w-3" strokeWidth={3} /> Connected
              </Badge>
            )}
          </div>
          <p role="status" className={cn('mt-0.5 text-[13px] leading-snug', v.status === 'waiting' ? 'text-accent-text' : 'text-ink-muted')}>
            {status}
          </p>
          {!compact && v.status !== 'connected' && v.status !== 'waiting' && v.status !== 'downloading' && (
            <p className="mt-1 text-xs text-ink-faint">
              {meta.connectHint} Billed to {meta.billedTo.replace(/^Your/, 'your')}.
            </p>
          )}
          {v.status === 'downloading' && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-edge-strong" role="progressbar" aria-valuenow={Math.round((v.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${meta.name}`}>
              <div className="h-full rounded-full bg-gradient-to-r from-[#8f3b76] to-accent transition-[width]" style={{ width: `${(v.progress ?? 0) * 100}%` }} />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {(v.status === 'ready' || v.status === 'not-installed') && (
            <Button variant="soft" size="md" onClick={() => connect(id)}>
              Connect
            </Button>
          )}
          {(v.status === 'waiting' || v.status === 'downloading') && (
            <>
              <Spinner />
              <Button variant="ghost" size="sm" onClick={() => cancel(id)}>
                Cancel
              </Button>
            </>
          )}
          {v.status === 'connected' && (
            <Button variant="ghost" size="sm" onClick={() => disconnect(id)}>
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {(v.status === 'ready' || v.status === 'not-installed') && (
        <div className="mt-3 pl-[58px]">
          {!keyOpen ? (
            <button type="button" onClick={() => setKeyOpen(true)} className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted underline decoration-edge-strong underline-offset-2 hover:text-ink">
              <KeyRound className="h-3.5 w-3.5" /> {meta.keyHint}
            </button>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!key.trim()) return
                void saveKey(id, key).then((stored) => {
                  if (!stored) return
                  setKey('')
                  setKeyOpen(false)
                })
              }}
            >
              <TextInput
                type="password"
                autoFocus
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Paste key"
                aria-label={`${meta.name} API key`}
                className="h-9"
              />
              <Button type="submit" variant="secondary" size="md" disabled={!key.trim()}>
                Save key
              </Button>
              <Button type="button" variant="ghost" size="md" onClick={() => setKeyOpen(false)}>
                Cancel
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
