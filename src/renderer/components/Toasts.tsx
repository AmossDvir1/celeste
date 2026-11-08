import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUi } from '@/stores/ui'

/** How long a message stays, counted only while the pile is not being looked at. */
const LIFETIME_MS = 7000
/** A message that is about to go is given at least this long once the pointer leaves, so it is not gone as the hand moves away. */
const GRACE_MS = 1800
/** In the pile, this many are drawn, one behind the other; the rest wait underneath. */
const PEEK = 3

/**
 * Short messages at the bottom of the window, for example "Deleted a chat" with Undo. One shows alone. Two or more are
 * piled, the newest in front with the older ones peeking out behind it; pointing at the pile (or tabbing into it) spreads
 * them all out, and while it is spread nothing disappears, so there is time to read each and press its button.
 */
export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)
  const [pointed, setPointed] = useState(false)
  const [focused, setFocused] = useState(false)
  const open = toasts.length > 1 && (pointed || focused)
  const paused = pointed || focused
  const left = useRef(new Map<number, number>())
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (paused) return
    const started = Date.now()
    const timers = toasts.map((t) => {
      const ms = left.current.get(t.id) ?? LIFETIME_MS
      left.current.set(t.id, ms)
      return setTimeout(() => dismiss(t.id), ms)
    })
    return () => {
      const used = Date.now() - started
      timers.forEach(clearTimeout)
      for (const t of toasts) left.current.set(t.id, Math.max(GRACE_MS, (left.current.get(t.id) ?? LIFETIME_MS) - used))
    }
  }, [toasts, paused, dismiss])

  // Nothing is left to point at once the pile is gone, so the state must not stay "pointed" for the next one.
  useEffect(() => {
    if (toasts.length === 0) {
      setPointed(false)
      setFocused(false)
      left.current.clear()
    }
  }, [toasts.length])

  // A card that is removed while it has focus never says it lost it, so look again whenever the cards change.
  useEffect(() => {
    if (focused && !box.current?.contains(document.activeElement)) setFocused(false)
  }, [toasts, focused])

  if (toasts.length === 0) return null
  const newest = toasts.length - 1
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[90] flex justify-center px-4">
      <div
        ref={box}
        data-testid="toast-stack"
        data-open={open}
        onMouseEnter={() => setPointed(true)}
        onMouseLeave={() => setPointed(false)}
        // Only keyboard focus spreads the pile: a click on a button is over once it is done.
        onFocus={(e) => e.target.matches(':focus-visible') && setFocused(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
        className={cn('pointer-events-auto max-w-full', open ? 'flex flex-col items-center gap-2' : 'grid items-end justify-items-center')}
      >
        {toasts.map((t, index) => {
          // 0 is the newest, in front.
          const depth = newest - index
          const behind = !open && depth > 0
          return (
            <div
              key={t.id}
              data-testid="toast"
              style={
                behind
                  ? { transform: `translateY(${-depth * 8}px) scale(${1 - depth * 0.05})`, zIndex: 10 - depth, opacity: depth < PEEK ? 1 : 0, transformOrigin: 'bottom center' }
                  : undefined
              }
              className={cn(
                'animate-fade-up flex max-w-full items-center gap-3 rounded-xl border border-accent/70 bg-raised-2 py-2 pr-2 pl-4 text-sm text-ink shadow-pop transition-[transform,opacity] duration-200',
                !open && '[grid-area:1/1]'
              )}
            >
              <span className={cn('min-w-0', behind && 'invisible')}>{t.text}</span>
              {t.actionLabel && (
                <button
                  type="button"
                  tabIndex={behind ? -1 : 0}
                  onClick={() => {
                    t.onAction?.()
                    dismiss(t.id)
                  }}
                  className={cn('rounded-md px-2.5 py-1 font-medium text-accent-text hover:bg-accent-soft', behind && 'invisible')}
                >
                  {t.actionLabel}
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss"
                tabIndex={behind ? -1 : 0}
                onClick={() => dismiss(t.id)}
                className={cn('flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-hover hover:text-ink', behind && 'invisible')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
