import { useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import { openLink } from '@/lib/links'
import { ErrorNote } from './ErrorNote'
import { chatNow } from './chat'
import { hashOf, parseSteps } from './spec'

/** The steps ticked off, kept in this window per chat and per block, so they are still ticked after a reload. Never shared. */
function loadTicks(key: string): number[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

function saveTicks(key: string, ticks: number[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ticks))
  } catch {
    /* private window or no room: the ticks last until the page does */
  }
}

/** A how-to as steps: read-only. Copy copies, a link opens through the browser setting, and nothing is ever run. */
export function StepsBlock({ source }: { source: string }) {
  const parsed = parseSteps(source)
  const key = `celeste.steps.${chatNow()?.id ?? 'none'}.${hashOf(source)}`
  const [ticks, setTicks] = useState(() => loadTicks(key))
  const [copied, setCopied] = useState<number | null>(null)
  if (!parsed.ok) return <ErrorNote kind="steps" error={parsed.error} source={source} />
  const spec = parsed.value
  const done = spec.steps.filter((_, i) => ticks.includes(i)).length
  const toggle = (i: number) => {
    const next = ticks.includes(i) ? ticks.filter((t) => t !== i) : [...ticks, i]
    setTicks(next)
    saveTicks(key, next)
  }
  return (
    <section aria-label={spec.title} className="my-3 max-w-[760px] rounded-xl border border-edge bg-field p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-ink">{spec.title}</h3>
        <span className="shrink-0 text-[12.5px] text-ink-muted" aria-live="polite">
          {done} of {spec.steps.length} done
        </span>
      </div>
      {spec.summary && <p className="mt-1 text-[13px] text-ink-muted">{spec.summary}</p>}
      <ol className="mt-3 space-y-2.5">
        {spec.steps.map((s, i) => {
          const on = ticks.includes(i)
          return (
            <li key={i} className="flex items-start gap-3">
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={`Step ${i + 1}: ${s.title}`}
                onClick={() => toggle(i)}
                className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors', on ? 'border-accent bg-accent text-accent-ink' : 'border-edge-strong hover:border-accent-edge')}
              >
                {on && <Check className="h-3.5 w-3.5" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className={cn('text-[14px] font-medium', on ? 'text-ink-muted line-through decoration-ink-faint' : 'text-ink')}>
                  <span className="mr-1.5 text-ink-faint tabular-nums">{i + 1}.</span>
                  {s.title}
                </div>
                {s.text && <div className="mt-0.5 text-[13.5px] leading-[1.6] text-ink-muted">{s.text}</div>}
                {(s.copy || s.link) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {s.copy && (
                      <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-[12.5px]">
                        <code className="selectable min-w-0 truncate font-mono text-ink">{s.copy}</code>
                        <button
                          type="button"
                          aria-label={`Copy: ${s.copy}`}
                          onClick={() => {
                            void navigator.clipboard?.writeText(s.copy as string)
                            setCopied(i)
                            setTimeout(() => setCopied((c) => (c === i ? null : c)), 1400)
                          }}
                          className="flex shrink-0 items-center gap-1 text-ink-muted hover:text-ink"
                        >
                          {copied === i ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                          {copied === i ? 'Copied' : 'Copy'}
                        </button>
                      </span>
                    )}
                    {s.link && (
                      <a
                        href={s.link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.preventDefault()
                          void openLink((s.link as { url: string }).url, e)
                        }}
                        className="inline-flex items-center gap-1 text-[13px] text-accent-text underline decoration-accent-text/40 underline-offset-2 hover:decoration-accent-text"
                      >
                        {s.link.label} <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
