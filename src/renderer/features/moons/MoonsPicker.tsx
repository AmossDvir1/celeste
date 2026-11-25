import { useState } from 'react'
import { ChevronDown, Moon, Plus } from 'lucide-react'
import { MOON_PATTERN_ORDER, PATTERNS, moonName, type MoonPattern, type Seat } from '@shared/moons'
import { cn } from '@/lib/cn'
import { Popover } from '@/components/menu'
import { ModelControls } from '@/features/chat/controls'
import { lookupModel, useModels } from '@/stores/models'
import { useUi } from '@/stores/ui'
import { connectedVendors, useVendors } from '@/stores/vendors'

/**
 * On the home screen, under the composer: a quiet way to make this a chat with two moons. The pattern is chosen by what it does, and the
 * second moon gets its own model. The composer's own model belongs to the moon that holds the pen, so only the other one is chosen here.
 */
export function MoonsPicker() {
  const draft = useUi((s) => s.draft)
  const setDraft = useUi((s) => s.setDraft)
  const byId = useModels((s) => s.byId)
  const noVendor = useVendors((s) => connectedVendors(s.vendors).length === 0)
  const [open, setOpen] = useState(false)
  const moons = draft.moons

  const choose = (pattern: MoonPattern) => setDraft({ moons: { pattern, model: moons?.model ?? draft.model, effort: moons ? moons.effort : draft.effort } })

  if (!moons) {
    return (
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          disabled={noVendor}
          title={noVendor ? 'Connect a vendor first, as for any message.' : undefined}
          onClick={() => {
            choose('build')
            setOpen(true)
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add a second moon
          {noVendor && <span className="sr-only">. Not available: connect a vendor first</span>}
        </button>
      </div>
    )
  }

  const def = PATTERNS[moons.pattern]
  const pen = def.pen
  const composerModel = lookupModel(byId, draft.model).label
  const row = (seat: Seat) => {
    const name = moonName(moons.pattern, seat)
    return (
      <div key={seat} className="flex min-h-[34px] items-center gap-3 text-[13.5px] text-ink-soft">
        {seat === pen ? (
          <span>
            {name} uses <span className="text-ink">{composerModel}</span>
          </span>
        ) : (
          <>
            <span>{name} uses</span>
            <ModelControls prefs={{ model: moons.model, effort: moons.effort, approval: draft.approval }} onPrefs={(p) => setDraft({ moons: { ...moons, model: p.model ?? moons.model, effort: p.effort !== undefined ? p.effort : moons.effort } })} />
          </>
        )}
      </div>
    )
  }

  return (
    <div className="mt-3 flex justify-center">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-accent-edge bg-accent-soft/50 px-3 text-[13px] text-accent-text transition-colors hover:bg-accent-soft"
          >
            <Moon className="h-3.5 w-3.5" aria-hidden />
            Two Moons · {def.label}
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        </Popover.Trigger>
        <Popover.Content role="group" aria-label="Two Moons" align="center" className="w-[min(560px,calc(100vw-24px))]">
          <div role="group" aria-label="What should happen" className="flex flex-wrap gap-2">
            {MOON_PATTERN_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={p === moons.pattern}
                onClick={() => choose(p)}
                className={cn(
                  'h-8 rounded-full border px-3.5 text-[13px] transition-colors',
                  p === moons.pattern ? 'border-accent-edge bg-accent-soft text-accent-text' : 'border-edge-strong text-ink-soft hover:bg-hover hover:text-ink'
                )}
              >
                {PATTERNS[p].label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[13.5px] leading-snug text-ink-muted">{def.says}</p>
          <div className="mt-3 flex flex-col gap-1">{([0, 1] as Seat[]).map(row)}</div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setDraft({ moons: null })
                setOpen(false)
              }}
              className="rounded-md px-2 py-1 text-[13px] text-ink-muted hover:bg-hover hover:text-ink"
            >
              Remove
            </button>
          </div>
        </Popover.Content>
      </Popover.Root>
    </div>
  )
}
