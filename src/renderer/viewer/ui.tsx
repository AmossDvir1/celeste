import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** The whole page, centred: a file is being opened, or could not be. */
export function Message({ children }: { children: ReactNode }) {
  return <div className="flex h-screen items-center justify-center bg-panel p-8 text-center text-[14px] text-ink-muted">{children}</div>
}

/** A thin bar along the top of a view, for its own controls. */
export function Bar({ children }: { children: ReactNode }) {
  return <div className="sticky top-0 z-10 flex min-h-11 flex-wrap items-center gap-2 border-b border-edge bg-panel px-4 py-1.5 text-[13px] text-ink-muted">{children}</div>
}

export function Btn({ active, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn('h-8 rounded-lg border px-3 text-[13px] transition-colors', active ? 'border-accent-edge bg-accent-soft text-accent-text' : 'border-edge text-ink-muted hover:bg-hover hover:text-ink', className)}
      {...props}
    />
  )
}

/** A line that says something about what is shown (a file was cut short, a sheet has more rows). */
export function Note({ children }: { children: ReactNode }) {
  return <div className="border-b border-edge bg-warning/10 px-4 py-2 text-[13px] text-ink">{children}</div>
}

/** Zoom buttons for a view, with the percentage between them. */
export function Zoom({ value, onChange, min = 0.5, max = 2.5 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const step = (d: number) => onChange(Math.min(max, Math.max(min, Math.round((value + d) * 100) / 100)))
  return (
    <span className="ml-auto flex items-center gap-1">
      <Btn aria-label="Zoom out" onClick={() => step(-0.1)} disabled={value <= min}>
        −
      </Btn>
      <button type="button" aria-label={`${Math.round(value * 100)}%, reset zoom`} onClick={() => onChange(1)} className="h-8 w-14 text-center text-[13px] text-ink-muted hover:text-ink">
        {Math.round(value * 100)}%
      </button>
      <Btn aria-label="Zoom in" onClick={() => step(0.1)} disabled={value >= max}>
        +
      </Btn>
    </span>
  )
}
