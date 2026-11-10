import { useEffect, useState, type RefObject } from 'react'
import { browserCall } from '@/stores/browser'

const MODAL = '[role="dialog"],[role="alertdialog"]'
const POPPER = '[data-radix-popper-content-wrapper]'

const overlaps = (a: DOMRect, b: DOMRect) => a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

/**
 * Whether something of the window is drawn over the page: a dialog (always, it covers the window), or a menu, a popover or a message that
 * reaches into the page's area. The page is a native layer above the window, so it would hide them.
 */
export function overlayOver(area: DOMRect): boolean {
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child.id === 'root') continue
    if (child.matches(MODAL) || child.querySelector(MODAL)) return true
    const poppers = child.matches(POPPER) ? [child] : Array.from(child.querySelectorAll<HTMLElement>(POPPER))
    for (const el of poppers) {
      // A tooltip is small and brief: it is not worth taking the page away for.
      if (el.querySelector('[role="tooltip"]')) continue
      if (overlaps(el.getBoundingClientRect(), area)) return true
    }
  }
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('[data-toast-card]'))) {
    if (overlaps(card.getBoundingClientRect(), area)) return true
  }
  return false
}

/**
 * Keeps the page where the placeholder is. It watches the placeholder every frame (it moves with the panel's slide-in, a drag, a window
 * resize), tells the main process where it is, and takes the page off the screen while something is drawn over it, leaving its picture.
 * Returns that picture, or null when the page is showing.
 */
export function useBrowserArea(body: RefObject<HTMLElement | null>, chatId: string, forceCover: boolean): { shot: string | null } {
  const [shot, setShot] = useState<string | null>(null)
  const [forced, setForced] = useState(forceCover)
  useEffect(() => setForced(forceCover), [forceCover])

  useEffect(() => {
    let raf = 0
    let frame = 0
    let last = ''
    let covered = false
    let seq = 0
    let alive = true
    const cover = (on: boolean) => {
      covered = on
      const mine = ++seq
      void browserCall('cover', { on }).then(
        (picture) => {
          if (alive && mine === seq) setShot(on ? picture : null)
        },
        () => undefined
      )
    }
    const tick = () => {
      const el = body.current
      if (el) {
        const r = el.getBoundingClientRect()
        const key = `${r.x}|${r.y}|${r.width}|${r.height}`
        if (key !== last) {
          last = key
          void browserCall('show', { chatId, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }).catch(() => undefined)
        }
        if (++frame % 2 === 0) {
          const now = forced || overlayOver(r)
          if (now !== covered) cover(now)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      void browserCall('show', { chatId: null, rect: null }).catch(() => undefined)
      void browserCall('cover', { on: false }).catch(() => undefined)
    }
  }, [body, chatId, forced])

  return { shot }
}
