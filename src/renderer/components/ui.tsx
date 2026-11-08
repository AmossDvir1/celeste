import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { Switch as RSwitch, Tooltip as RTooltip } from 'radix-ui'
import { Check, LoaderCircle, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { initials } from '@/lib/format'

type Variant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent-fill text-accent-ink hover:brightness-110 active:brightness-95',
  secondary: 'border border-edge-strong bg-raised/60 text-ink hover:bg-raised-2',
  ghost: 'text-ink-muted hover:bg-hover hover:text-ink',
  soft: 'bg-accent-soft text-accent-text hover:bg-accent/20',
  danger: 'border border-danger/40 text-danger hover:bg-danger/10'
}
const SIZE: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-3 text-[13px]',
  md: 'h-9 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-[15px]'
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-control font-medium whitespace-nowrap transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...props}
    />
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'sm' | 'md' | 'lg'
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', active, className, type = 'button', children, ...props },
  ref
) {
  const dim = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-11 w-11' : 'h-9 w-9'
  return (
    <Tip label={label}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-control text-ink-muted transition-colors',
          'hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50',
          active && 'bg-hover text-ink',
          dim,
          className
        )}
        {...props}
      >
        {children}
      </button>
    </Tip>
  )
})

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RTooltip.Provider delayDuration={350}>{children}</RTooltip.Provider>
}

export function Tip({
  label,
  children,
  side = 'top'
}: {
  label: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          // The window's title bar overlay covers the top 56px, so tooltips must flip below it.
          collisionPadding={{ top: 60, right: 8, bottom: 8, left: 8 }}
          className="pop-in z-[70] max-w-[260px] rounded-md border border-edge-strong bg-raised-2 px-2.5 py-1.5 text-xs text-ink shadow-pop"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-edge-strong bg-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
      {children}
    </kbd>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'info'
  className?: string
}) {
  const tones = {
    neutral: 'border-edge-strong text-ink-muted',
    accent: 'border-accent-edge bg-accent-soft text-accent-text',
    success: 'border-success/35 bg-success/10 text-success',
    warning: 'border-warning/35 bg-warning/10 text-warning',
    info: 'border-info/35 bg-info/10 text-info'
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn('animate-spin text-ink-muted', className ?? 'h-4 w-4')} aria-hidden />
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-edge-strong bg-raised font-semibold text-ink"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}

export function Switch({
  checked,
  onCheckedChange,
  label
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  label: string
}) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="relative h-6 w-11 shrink-0 rounded-full border border-edge-strong bg-raised transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent"
    >
      <RSwitch.Thumb className="block h-[18px] w-[18px] translate-x-[3px] rounded-full bg-ink-muted shadow transition-transform data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-white" />
    </RSwitch.Root>
  )
}

export function Checkbox({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'inline-flex h-[18px] w-[18px] items-center justify-center rounded border transition-colors',
          checked ? 'border-accent bg-accent text-white' : 'border-edge-strong bg-field'
        )}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      {label}
    </label>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; icon?: ReactNode }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-edge bg-field p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors',
            value === o.value ? 'bg-accent-soft text-accent-text' : 'text-ink-muted hover:text-ink'
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-control border border-edge bg-field px-3 text-sm text-ink placeholder:text-ink-faint',
        'transition-colors focus:border-accent-edge focus:outline-none',
        className
      )}
      {...props}
    />
  )
})

export function SearchInput({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <label
      className={cn(
        'flex h-9 items-center gap-2 rounded-control border border-edge bg-raised/70 px-2.5 text-ink-muted transition-colors focus-within:border-accent-edge',
        className
      )}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
      />
    </label>
  )
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-2 text-[13px] font-medium text-ink-muted', className)}>{children}</div>
}
