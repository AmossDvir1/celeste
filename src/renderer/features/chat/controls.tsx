import { Slider } from 'radix-ui'
import {
  ChevronDown,
  ChevronRight,
  ListChecks,
  Plug,
  ShieldQuestion,
  SlidersHorizontal,
  Zap,
  FilePen
} from 'lucide-react'
import type { ApprovalMode, Effort, SessionMode } from '@shared/agent'
import { cn } from '@/lib/cn'
import { Menu, Popover } from '@/components/menu'
import { IconButton, Tip } from '@/components/ui'
import { VendorLogo } from '@/components/VendorLogo'
import {
  APPROVAL_OPTIONS,
  EFFORT_LABEL,
  VENDORS,
  VENDOR_ORDER,
  effortFor
} from '@/mocks/models'
import { lookupModel, useModels } from '@/stores/models'
import { useVendors } from '@/stores/vendors'
import { useUi } from '@/stores/ui'

export interface Prefs {
  model: string
  effort: Effort | null
  approval: ApprovalMode
}

// Small, quiet controls under the text box. The model and effort controls join into one segmented pill.
const control =
  'inline-flex h-[30px] items-center text-[13px] text-ink-soft transition-colors hover:bg-raised-2 hover:text-ink ' +
  'data-[state=open]:bg-raised-2 data-[state=open]:text-ink'
const pill = `${control} gap-1.5 rounded-lg border border-edge-strong bg-pill px-2.5`
const chevron = 'h-3.5 w-3.5 text-ink-faint'

/** Model and thinking effort, side by side: effort belongs to the model, so they share one outline. */
export function ModelControls({ prefs, onPrefs }: { prefs: Prefs; onPrefs: (p: Partial<Prefs>) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-edge-strong bg-pill">
      <ModelPicker prefs={prefs} onPrefs={onPrefs} />
      <span className="my-1.5 w-px bg-edge-strong" aria-hidden />
      <EffortPopover prefs={prefs} onPrefs={onPrefs} />
    </div>
  )
}

function ModelPicker({ prefs, onPrefs }: { prefs: Prefs; onPrefs: (p: Partial<Prefs>) => void }) {
  const vendors = useVendors((s) => s.vendors)
  const openSettings = useUi((s) => s.openSettings)
  const models = useModels((s) => s.list)
  const byId = useModels((s) => s.byId)
  const current = lookupModel(byId, prefs.model)
  const connected = VENDOR_ORDER.filter((v) => vendors[v].status === 'connected')

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          className={cn(control, 'gap-1.5 rounded-l-[7px] pr-2 pl-2.5')}
          aria-label={`Model: ${VENDORS[current.vendor].menuLabel} ${current.label}`}
        >
          <VendorLogo id={current.vendor} className="h-4 w-4" />
          <span>{current.label}</span>
          <ChevronDown className={chevron} />
        </button>
      </Menu.Trigger>
      <Menu.Content className="min-w-[210px]">
        <Menu.RadioGroup
          value={current.id}
          onValueChange={(id) => {
            const m = byId[id]
            if (m) onPrefs({ model: id, effort: effortFor(m, prefs.effort) })
          }}
        >
          {connected.map((v) => (
            <div key={v}>
              <Menu.Label className="flex items-center gap-1.5">
                <VendorLogo id={v} className="h-3.5 w-3.5 text-ink-soft" />
                {VENDORS[v].menuLabel}
              </Menu.Label>
              {models.filter((m) => m.vendor === v).map((m) => (
                <Menu.RadioItem key={m.id} value={m.id}>
                  {m.label}
                </Menu.RadioItem>
              ))}
            </div>
          ))}
        </Menu.RadioGroup>
        <Menu.Separator />
        <Menu.Item onSelect={() => openSettings('vendors')} className="text-ink-muted">
          <Plug className="h-3.5 w-3.5" />
          Connect another vendor…
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  )
}

const APPROVAL_ICON: Record<ApprovalMode, typeof Zap> = {
  auto: Zap,
  edits: FilePen,
  ask: ShieldQuestion,
  plan: ListChecks
}

export function ApprovalPicker({
  value,
  onChange,
  mode
}: {
  value: ApprovalMode
  onChange: (v: ApprovalMode) => void
  mode: SessionMode
}) {
  const options = APPROVAL_OPTIONS.filter((o) => !o.developOnly || mode === 'develop')
  const current = options.find((o) => o.value === value) ?? options[0]
  const Icon = APPROVAL_ICON[current.value]
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" className={cn(pill, 'pr-2')} aria-label={`Approval: ${current.label}`}>
          <Icon className={cn('h-3.5 w-3.5', current.value === 'auto' ? 'text-accent-text' : 'text-ink-muted')} />
          <span>{current.short}</span>
          <ChevronDown className={chevron} />
        </button>
      </Menu.Trigger>
      <Menu.Content className="w-[270px]">
        <Menu.Label>When the agent wants to act</Menu.Label>
        <Menu.RadioGroup value={value} onValueChange={(v) => onChange(v as ApprovalMode)}>
          {options.map((o) => (
            <Menu.RadioItem key={o.value} value={o.value} description={o.description}>
              {o.label}
              {o.value === 'auto' && <span className="ml-1.5 text-[10.5px] text-ink-faint">default</span>}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  )
}

function EffortPopover({
  prefs,
  onPrefs
}: {
  prefs: Prefs
  onPrefs: (p: Partial<Prefs>) => void
}) {
  const setRight = useUi((s) => s.setRight)
  const byId = useModels((s) => s.byId)
  const model = lookupModel(byId, prefs.model)
  const efforts = model.efforts
  const idx = Math.max(0, prefs.effort ? efforts.indexOf(prefs.effort) : 0)
  const disabled = efforts.length === 0

  return (
    <Popover.Root>
      <Tip label={disabled ? 'Thinking effort and tools' : `Thinking effort: ${EFFORT_LABEL[efforts[idx]]}`}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Thinking effort and tools"
            className={cn(control, 'w-8 justify-center rounded-r-[7px]')}
          >
            <SlidersHorizontal className="h-[15px] w-[15px]" />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Content className="w-[320px]">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-ink">Thinking effort</span>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-text">
            {disabled ? 'Automatic' : EFFORT_LABEL[efforts[idx]]}
          </span>
        </div>

        <Slider.Root
          className={cn('relative mt-4 flex h-5 w-full touch-none items-center select-none', disabled && 'opacity-40')}
          min={0}
          max={Math.max(1, efforts.length - 1)}
          step={1}
          value={[idx]}
          disabled={disabled}
          onValueChange={([v]) => onPrefs({ effort: efforts[v] })}
        >
          <Slider.Track className="relative h-1.5 grow rounded-full bg-edge-strong">
            <Slider.Range className="absolute h-full rounded-full bg-gradient-to-r from-[#8f3b76] to-accent" />
          </Slider.Track>
          <Slider.Thumb
            aria-label="Thinking effort"
            className="block h-[18px] w-[18px] rounded-full border-2 border-accent bg-white shadow-md"
          />
        </Slider.Root>

        {disabled ? (
          <p className="mt-3 text-xs leading-snug text-ink-faint">
            This model has no effort setting. It decides how much to think on its own.
          </p>
        ) : (
          <div className="mt-2 flex justify-between text-[11px] text-ink-faint">
            {efforts.map((e: Effort) => (
              <span key={e} className={cn(e === efforts[idx] && 'text-ink')}>
                {EFFORT_LABEL[e]}
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 border-t border-edge pt-2">
          <Popover.Close asChild>
            <button
              type="button"
              onClick={() => setRight('tools')}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink hover:bg-hover"
            >
              <Plug className="h-4 w-4 text-ink-muted" />
              Tools &amp; Integrations
              <ChevronRight className="ml-auto h-4 w-4 text-ink-faint" />
            </button>
          </Popover.Close>
        </div>
      </Popover.Content>
    </Popover.Root>
  )
}

export { IconButton }
