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
import {
  APPROVAL_OPTIONS,
  EFFORT_LABEL,
  MODELS,
  MODEL_BY_ID,
  VENDORS,
  VENDOR_ORDER,
  effortFor
} from '@/mocks/models'
import { useVendors } from '@/stores/vendors'
import { useUi } from '@/stores/ui'

export interface Prefs {
  model: string
  effort: Effort | null
  approval: ApprovalMode
}

const pill =
  'inline-flex h-[34px] items-center gap-2.5 rounded-control border border-edge-strong bg-pill px-3.5 text-[15px] text-ink-soft ' +
  'transition-colors hover:bg-raised-2 data-[state=open]:bg-raised-2'

export function ModelPicker({ prefs, onPrefs }: { prefs: Prefs; onPrefs: (p: Partial<Prefs>) => void }) {
  const vendors = useVendors((s) => s.vendors)
  const openSettings = useUi((s) => s.openSettings)
  const current = MODEL_BY_ID[prefs.model] ?? MODELS[0]
  const connected = VENDOR_ORDER.filter((v) => vendors[v].status === 'connected')

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" className={pill} aria-label={`Model: ${current.label}`}>
          <span>{current.label}</span>
          <ChevronDown className="ml-2.5 h-4 w-4 text-ink-muted" />
        </button>
      </Menu.Trigger>
      <Menu.Content className="min-w-[240px]">
        <Menu.RadioGroup
          value={prefs.model}
          onValueChange={(id) => {
            const m = MODEL_BY_ID[id]
            if (m) onPrefs({ model: id, effort: effortFor(m, prefs.effort) })
          }}
        >
          {connected.map((v) => (
            <div key={v}>
              <Menu.Label>{VENDORS[v].menuLabel}</Menu.Label>
              {MODELS.filter((m) => m.vendor === v).map((m) => (
                <Menu.RadioItem key={m.id} value={m.id}>
                  {m.label}
                </Menu.RadioItem>
              ))}
            </div>
          ))}
        </Menu.RadioGroup>
        <Menu.Separator />
        <Menu.Item onSelect={() => openSettings('vendors')} className="text-ink-muted">
          <Plug className="h-4 w-4" />
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
        <button type="button" className={pill} aria-label={`Approval: ${current.label}`}>
          <Icon className={cn('h-4 w-4', current.value === 'auto' ? 'text-accent-text' : 'text-ink-muted')} />
          <span>{current.short}</span>
          <ChevronDown className="ml-1.5 h-4 w-4 text-ink-muted" />
        </button>
      </Menu.Trigger>
      <Menu.Content className="w-[290px]">
        <Menu.Label>When the agent wants to act</Menu.Label>
        <Menu.RadioGroup value={value} onValueChange={(v) => onChange(v as ApprovalMode)}>
          {options.map((o) => (
            <Menu.RadioItem key={o.value} value={o.value} description={o.description}>
              {o.label}
              {o.value === 'auto' && <span className="ml-2 text-[11px] text-ink-faint">default</span>}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  )
}

export function EffortPopover({
  prefs,
  onPrefs
}: {
  prefs: Prefs
  onPrefs: (p: Partial<Prefs>) => void
}) {
  const setRight = useUi((s) => s.setRight)
  const model = MODEL_BY_ID[prefs.model] ?? MODELS[0]
  const efforts = model.efforts
  const idx = Math.max(0, prefs.effort ? efforts.indexOf(prefs.effort) : 0)
  const disabled = efforts.length === 0

  return (
    <Popover.Root>
      <Tip label="Thinking effort and tools">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Thinking effort and tools"
            className="inline-flex h-9 w-11 items-center justify-center rounded-control text-ink-soft transition-colors hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink"
          >
            <SlidersHorizontal className="h-[21px] w-[21px]" />
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
            {model.label} has no effort setting. It decides how much to think on its own.
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
