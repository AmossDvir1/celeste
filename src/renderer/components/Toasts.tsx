import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useUi } from '@/stores/ui'

/** How long a message stays, counted only while the pile is not being looked at. */
const LIFETIME_MS = 7000
/** A message that is about to go is given at least this long once the pointer leaves, so it is not gone as the hand moves away. */
const GRACE_MS = 1800
/** In the pile, this many are drawn, one behind the other; the rest wait underneath. */
const PEEK = 3
/** Space between two messages when the pile is spread out, and how much of each older one shows above the one in front. */
const GAP = 8
const EDGE = 9
/** The pointer crossing the gap between two spread messages is not leaving. */
const LEAVE_MS = 120

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
  const leaving = useRef<number>(undefined)
  // Every card is laid on the same spot and moved with a transform, so going between pile and spread is one smooth motion;
  // that needs each card's height.
  const [heights, setHeights] = useState<Record<number, number>>({})

  useLayoutEffect(() => {
    const read = () => {
      const next: Record<number, number> = {}
      box.current?.querySelectorAll<HTMLElement>('[data-toast-card]').forEach((el) => {
        next[Number(el.dataset.toastCard)] = el.offsetHeight
      })
      setHeights((prev) => {
        const keys = Object.keys(next)
        return keys.length === Object.keys(prev).length && keys.every((k) => prev[Number(k)] === next[Number(k)]) ? prev : next
      })
    }
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [toasts])

  useEffect(() => () => window.clearTimeout(leaving.current), [])

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
  const height = (id: number) => heights[id] ?? 0
  // How far up a card sits when spread: the cards in front of it, and the gaps between.
  const spreadLift = (index: number) => toasts.slice(index + 1).reduce((sum, t) => sum + height(t.id) + GAP, 0)
  const boxHeight = open ? toasts.reduce((sum, t) => sum + height(t.id), 0) + GAP * newest : height(toasts[newest].id) + Math.min(newest, PEEK - 1) * EDGE
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[90] flex justify-center px-4">
      <div
        ref={box}
        data-testid="toast-stack"
        data-open={open}
        onMouseEnter={() => {
          window.clearTimeout(leaving.current)
          setPointed(true)
        }}
        onMouseLeave={() => {
          leaving.current = window.setTimeout(() => setPointed(false), LEAVE_MS)
        }}
        // Only keyboard focus spreads the pile: a click on a button is over once it is done.
        onFocus={(e) => e.target.matches(':focus-visible') && setFocused(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
        style={{ height: boxHeight }}
        className="pointer-events-none relative w-full max-w-[32rem] transition-[height] duration-300 ease-out"
      >
        {toasts.map((t, index) => {
          // 0 is the newest, in front.
          const depth = newest - index
          const behind = !open && depth > 0
          const transform = open
            ? `translateY(${-spreadLift(index)}px)`
            : `translateY(${-Math.min(depth, PEEK - 1) * EDGE}px) scale(${1 - Math.min(depth, PEEK - 1) * 0.05})`
          return (
            // The outer layer only enters and stacks; the inner one moves, so the entrance does not fight the pile's motion.
            <div key={t.id} style={{ zIndex: 100 - depth }} className="animate-fade-up absolute inset-x-0 bottom-0 flex justify-center">
              <div
                data-testid="toast"
                data-toast-card={t.id}
                style={{ transform, transformOrigin: 'bottom center', opacity: !open && depth >= PEEK ? 0 : 1 }}
                className="pointer-events-auto relative flex max-w-full items-center gap-3 rounded-xl border border-accent/70 bg-raised-2 py-2 pr-2 pl-4 text-sm text-ink shadow-pop transition-[transform,opacity] duration-300 ease-out"
              >
                {/* Behind the newest only an edge shows; the words wait until it is spread out. */}
                <div aria-hidden={behind || undefined} className={cn('flex min-w-0 items-center gap-3 transition-opacity duration-200', behind && 'opacity-0')}>
                  <span className="min-w-0">{t.text}</span>
                  {t.actionLabel && (
                    <button
                      type="button"
                      tabIndex={behind ? -1 : 0}
                      onClick={() => {
                        t.onAction?.()
                        dismiss(t.id)
                      }}
                      className="rounded-md px-2.5 py-1 font-medium text-accent-text hover:bg-accent-soft"
                    >
                      {t.actionLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Dismiss"
                    tabIndex={behind ? -1 : 0}
                    onClick={() => dismiss(t.id)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
