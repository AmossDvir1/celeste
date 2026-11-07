import { useState } from 'react'
import { ChevronRight, Package } from 'lucide-react'
import { cn } from '@/lib/cn'
import { DevicesPanelSection } from '@/features/devices/DevicesPanelSection'
import { PanelCard } from '@/components/PanelCard'
import { SearchInput, Switch } from '@/components/ui'
import { INTEGRATIONS } from '@/mocks/tools'
import { useUi } from '@/stores/ui'

function Tile({ letter, color }: { letter: string; color: string }) {
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[17px] font-semibold"
      style={{ background: `${color}26`, color }}
      aria-hidden
    >
      {letter}
    </span>
  )
}

/** Tools & Integrations: the MCP servers Celeste passes to whichever vendor runs the session. */
export function ToolsPanel() {
  const setRight = useUi((s) => s.setRight)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [off, setOff] = useState<Record<string, boolean>>({})
  const q = query.trim().toLowerCase()
  const list = INTEGRATIONS.filter((i) => !q || i.name.toLowerCase().includes(q) || i.blurb.toLowerCase().includes(q))

  return (
    <PanelCard title="Tools & Integrations" onClose={() => setRight(null)} className="h-full">
      <DevicesPanelSection />
      <div className="px-4 pt-3">
        <SearchInput value={query} onChange={setQuery} placeholder="Search tools…" className="h-10" />
      </div>
      <ul className="px-2 py-2">
        {list.map((i) => {
          const expanded = open === i.id
          return (
            <li key={i.id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : i.id)}
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-hover"
              >
                <Tile letter={i.letter} color={i.color} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block text-[14px] text-ink">{i.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{i.blurb}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden /> Connected
                </span>
                <ChevronRight className={cn('h-4 w-4 shrink-0 text-ink-faint transition-transform', expanded && 'rotate-90')} />
              </button>
              {expanded && (
                <ul className="mt-0.5 mb-2 ml-[66px] space-y-1 border-l border-edge pl-4">
                  {i.tools.map((t) => {
                    const key = `${i.id}:${t}`
                    return (
                      <li key={t} className="flex items-center justify-between gap-3 py-1 text-[13px] text-ink-muted">
                        <span className={cn(off[key] && 'line-through opacity-60')}>{t}</span>
                        <Switch label={`${t} enabled`} checked={!off[key]} onCheckedChange={(v) => setOff({ ...off, [key]: !v })} />
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
        {list.length === 0 && <li className="px-3 py-8 text-center text-sm text-ink-faint">No tools match “{query}”</li>}
        <li className="flex items-center gap-3 px-2.5 py-3 text-[13px] text-ink-faint">
          <Package className="h-[22px] w-[22px] shrink-0" />
          <span>More tools coming soon…</span>
        </li>
      </ul>
    </PanelCard>
  )
}
