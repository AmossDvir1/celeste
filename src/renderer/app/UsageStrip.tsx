import { useEffect, useState } from 'react'
import { Popover as RPopover } from 'radix-ui'
import { RefreshCw } from 'lucide-react'
import type { VendorId } from '@shared/agent'
import { USAGE_REFRESH_MS, USAGE_STALE_MS, mainWindow, untilText, usageLevel, type UsageWindow, type VendorUsage } from '@shared/usage'
import { cn } from '@/lib/cn'
import { VENDORS } from '@/lib/vendors'
import { connectedVendors, useVendors } from '@/stores/vendors'
import { useUsage } from '@/stores/usage'

const SHORT: Record<VendorId, string> = { copilot: 'Copilot', claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini' }

const BAR: Record<'ok' | 'warn' | 'limit', string> = { ok: 'bg-accent', warn: 'bg-warning', limit: 'bg-danger' }
const WORDS: Record<'ok' | 'warn' | 'limit', string> = { ok: '', warn: 'getting low', limit: 'at the limit' }

/** The time now, redrawn every half minute, so "resets in 3 h" and "updated 2 min ago" stay true while the window is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

const percentText = (w: UsageWindow): string => (w.unlimited ? 'Unlimited' : w.percentUsed === null ? '—' : `${Math.round(w.percentUsed)}%`)

/** A thin bar for one meter. A meter for assistive technology, with the number in words: colour is never the only signal. */
function Bar({ w, label, className }: { w: UsageWindow; label: string; className?: string }) {
  if (w.unlimited || w.percentUsed === null) return null
  const level = usageLevel(w.percentUsed)
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(w.percentUsed)}
      aria-valuetext={`${Math.round(w.percentUsed)}% used${WORDS[level] ? `, ${WORDS[level]}` : ''}`}
      className={cn('h-1.5 overflow-hidden rounded-full bg-edge-strong/60', className)}
    >
      <div className={cn('h-full rounded-full transition-[width]', BAR[level])} style={{ width: `${Math.max(2, w.percentUsed)}%` }} />
    </div>
  )
}

function ago(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000)
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`
}

function Details({ u, now }: { u: VendorUsage; now: number }) {
  const refreshing = useUsage((s) => s.refreshing)
  const refresh = useUsage((s) => s.refresh)
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[14px] font-medium text-ink">{VENDORS[u.vendor].name}</div>
        {u.plan && <div className="text-[12px] text-ink-muted">{u.plan}</div>}
      </div>
      {u.windows.map((w) => (
        <div key={w.key} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-ink">{w.label}</span>
            <span className="text-ink-muted">{w.text && !w.unlimited ? w.text : percentText(w)}</span>
          </div>
          <Bar w={w} label={`${SHORT[u.vendor]}, ${w.label}`} className="h-2" />
          <div className="text-[12px] text-ink-faint">
            {w.resetsAt !== null ? `Resets in ${untilText(w.resetsAt, now)} (${new Date(w.resetsAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})` : w.unlimited ? 'Nothing to run out of' : ''}
          </div>
        </div>
      ))}
      {u.note && <div className="text-[12.5px] text-ink-muted">{u.note}</div>}
      <div className="flex items-center justify-between gap-2 border-t border-edge pt-2.5 text-[12px] text-ink-faint">
        <span>{u.failedAt ? `Could not update. Showing ${ago(u.at, now)}.` : `Updated ${ago(u.at, now)}`}</span>
        <button
          type="button"
          onClick={() => void refresh(u.vendor)}
          disabled={refreshing}
          aria-label={`Refresh the usage of ${VENDORS[u.vendor].name}`}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /> Refresh
        </button>
      </div>
    </div>
  )
}

function Row({ u, now }: { u: VendorUsage; now: number }) {
  const main = mainWindow(u)
  if (!main) return null
  const stale = now - u.at > USAGE_STALE_MS
  const level = usageLevel(main.percentUsed)
  return (
    <RPopover.Root>
      <RPopover.Trigger asChild>
        <button
          type="button"
          aria-label={`${SHORT[u.vendor]} usage: ${main.label}, ${main.unlimited ? 'unlimited' : `${Math.round(main.percentUsed ?? 0)}% used`}${WORDS[level] ? `, ${WORDS[level]}` : ''}${stale || u.failedAt ? ', not up to date' : ''}. Show details`}
          className="flex h-7 w-full items-center gap-2 rounded-md px-3 text-[12px] text-ink-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <span className="w-[52px] shrink-0 truncate text-left">{SHORT[u.vendor]}</span>
          <span className="min-w-0 flex-1">
            <Bar w={main} label={`${SHORT[u.vendor]}, ${main.label}`} />
          </span>
          <span className={cn('shrink-0 text-right tabular-nums', main.unlimited || main.percentUsed === null ? 'w-auto' : 'w-[34px]', level === 'limit' && 'text-danger', level === 'warn' && 'text-warning', (stale || !!u.failedAt) && 'opacity-60')}>
            {percentText(main)}
            {(stale || u.failedAt) && <span aria-hidden> ·</span>}
          </span>
        </button>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          side="right"
          align="end"
          sideOffset={10}
          collisionPadding={8}
          aria-label={`${VENDORS[u.vendor].name} usage`}
          className="pop-in z-[70] w-[300px] rounded-xl border border-edge-strong bg-raised-2 p-3.5 text-ink shadow-pop"
        >
          <Details u={u} now={now} />
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

/**
 * How much of each connected vendor's allowance is used: one thin row per vendor above Settings, the details in a popover. It asks Core to
 * read again when the window gains focus and every five minutes while it is open and visible, and only while some vendor is connected.
 */
export function UsageStrip() {
  const items = useUsage((s) => s.items)
  const refresh = useUsage((s) => s.refresh)
  const anyConnected = useVendors((s) => connectedVendors(s.vendors).length > 0)
  const now = useNow()

  useEffect(() => {
    if (!anyConnected) return
    const ask = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    ask()
    window.addEventListener('focus', ask)
    const timer = setInterval(ask, USAGE_REFRESH_MS)
    return () => {
      window.removeEventListener('focus', ask)
      clearInterval(timer)
    }
  }, [anyConnected, refresh])

  const rows = items.filter((u) => mainWindow(u))
  if (!anyConnected || rows.length === 0) return null
  return (
    <div role="group" aria-label="Usage" className="mt-2 space-y-0.5 border-t border-edge pt-2">
      {rows.map((u) => (
        <Row key={u.vendor} u={u} now={now} />
      ))}
    </div>
  )
}
