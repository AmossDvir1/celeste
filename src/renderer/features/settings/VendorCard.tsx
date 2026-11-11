import { useEffect, useState } from 'react'
import { Check, KeyRound } from 'lucide-react'
import type { VendorId } from '@shared/agent'
import type { VendorProgram } from '@shared/api'
import { core } from '@/api'
import { cn } from '@/lib/cn'
import { Badge, Button, Spinner, TextInput } from '@/components/ui'
import { VendorTile } from '@/components/VendorLogo'
import { VENDORS } from '@/lib/vendors'
import { openExternal, useVendors } from '@/stores/vendors'

const PROGRAM_NAME: Partial<Record<VendorId, string>> = { claude: 'Claude Code', copilot: 'Copilot CLI' }

/** Which copy of the vendor's program is in use, in a sentence. Nothing when there is nothing to say yet. */
function programLine(id: VendorId, p: VendorProgram | undefined): string | undefined {
  const name = PROGRAM_NAME[id]
  if (!p || !name) return undefined
  if (p.using === 'yours') return `Using the ${name} already on this computer${p.version ? ` (${p.version})` : ''}.`
  // The reason already says that Celeste's own copy is the one in use.
  return p.why ?? (p.using === 'celeste' ? 'Using Celeste’s own copy.' : undefined)
}

/** One Connect button per vendor. It opens the browser, you authorize there, and the card turns to Connected. */
export function VendorCard({ id, compact }: { id: VendorId; compact?: boolean }) {
  const meta = VENDORS[id]
  const v = useVendors((s) => s.vendors[id])
  const connect = useVendors((s) => s.connect)
  const connectWithCode = useVendors((s) => s.connectWithCode)
  const cancel = useVendors((s) => s.cancel)
  const saveKey = useVendors((s) => s.saveKey)
  const disconnect = useVendors((s) => s.disconnect)
  const prepare = useVendors((s) => s.prepare)
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [program, setProgram] = useState<VendorProgram>()
  useEffect(() => {
    if (!meta.available || id === 'openai' || id === 'gemini') return
    let alive = true
    core.call('vendor.program', id).then((p) => alive && setProgram(p), () => undefined)
    return () => {
      alive = false
    }
  }, [id, meta.available, v.status])
  const programText = programLine(id, program)
  const getting = v.getting !== undefined && v.status !== 'downloading' ? v.getting : undefined

  const status = {
    'not-installed': 'Not on this computer yet. Celeste downloads it when you connect.',
    ready: meta.available ? meta.blurb : 'Celeste cannot talk to this vendor yet.',
    downloading: `Downloading… ${Math.round((v.progress ?? 0) * 100)}%`,
    waiting: v.step?.kind === 'device-code' ? 'Type this code on GitHub to finish.' : v.step ? 'Finish signing in in your browser…' : 'Waiting for you in your browser…',
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
            {!meta.available && <Badge tone="accent">Coming soon</Badge>}
            {v.status === 'connected' && (
              <Badge tone="success">
                <Check className="h-3 w-3" strokeWidth={3} /> Connected
              </Badge>
            )}
          </div>
          <p role="status" className={cn('mt-0.5 text-[13px] leading-snug', v.status === 'waiting' ? 'text-accent-text' : 'text-ink-muted')}>
            {status}
          </p>
          {!compact && programText && <p className="mt-1 text-xs text-ink-faint">{programText}</p>}
          {v.error && (
            <p role="alert" className="mt-1 text-[13px] leading-snug text-danger">
              {v.error}
            </p>
          )}
          {v.status === 'waiting' && v.step?.kind === 'device-code' && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <code aria-label={`Code ${v.step.code}`} className="selectable rounded-lg bg-field px-3 py-1.5 font-mono text-[18px] tracking-[0.2em] text-ink">
                {v.step.code}
              </code>
              <Button variant="secondary" size="sm" onClick={() => v.step && openExternal(v.step.url)}>
                Open GitHub
              </Button>
            </div>
          )}
          {v.status === 'waiting' && v.step?.kind === 'open-url' && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-muted">
              <button type="button" onClick={() => v.step && openExternal(v.step.url)} className="underline decoration-edge-strong underline-offset-2 hover:text-ink">
                Open the sign-in page again
              </button>
              <button type="button" onClick={() => connectWithCode(id)} className="underline decoration-edge-strong underline-offset-2 hover:text-ink">
                Use a code instead
              </button>
            </p>
          )}
          {!compact && meta.available && v.status !== 'connected' && v.status !== 'waiting' && v.status !== 'downloading' && !v.error && (
            <p className="mt-1 text-xs text-ink-faint">
              {meta.connectHint} Billed to {meta.billedTo.replace(/^Your/, 'your')}.
            </p>
          )}
          {v.status === 'downloading' && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-edge-strong" role="progressbar" aria-valuenow={Math.round((v.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Downloading ${meta.name}`}>
              <div className="h-full rounded-full bg-gradient-to-r from-[#8f3b76] to-accent transition-[width]" style={{ width: `${(v.progress ?? 0) * 100}%` }} />
            </div>
          )}
          {getting !== undefined && (
            <div className="mt-2">
              <p role="status" className="text-xs text-ink-faint">
                Getting {meta.name} ready in the background… {Math.round(getting * 100)}%
              </p>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-edge-strong" role="progressbar" aria-valuenow={Math.round(getting * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Getting ${meta.name} ready`}>
                <div className="h-full rounded-full bg-gradient-to-r from-[#8f3b76] to-accent transition-[width]" style={{ width: `${getting * 100}%` }} />
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {meta.available && (v.status === 'ready' || v.status === 'not-installed') && (
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

      {meta.available && meta.keyHint && (v.status === 'ready' || v.status === 'not-installed') && (
        <div className="mt-3 pl-[58px]">
          {!keyOpen ? (
            <button
              type="button"
              onClick={() => {
                setKeyOpen(true)
                // Someone who pastes a key has chosen this vendor, so its program starts coming while they find the key.
                void prepare(id)
              }}
              className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted underline decoration-edge-strong underline-offset-2 hover:text-ink">
              <KeyRound className="h-3.5 w-3.5" /> {meta.keyHint}
            </button>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!key.trim() || saving) return
                setSaving(true)
                void saveKey(id, key).then((stored) => {
                  setSaving(false)
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
              <Button type="submit" variant="secondary" size="md" disabled={!key.trim() || saving}>
                {saving ? 'Saving…' : 'Save key'}
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
