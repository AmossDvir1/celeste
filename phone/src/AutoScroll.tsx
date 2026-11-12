import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** How long the bar stays after the last scroll. */
const HIDE_AFTER_MS = 1000
const MIN_THUMB = 28

/** A box that scrolls under a thin bar. The bar fades in while the box is scrolled and fades out a second after it stops. */
export function AutoScroll({ className, children }: { className?: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null)
  const timer = useRef(0)
  const [bar, setBar] = useState({ top: 0, height: 0 })
  const [shown, setShown] = useState(false)

  const measure = () => {
    const el = body.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    const overflow = scrollHeight > clientHeight
    const height = overflow ? Math.max(MIN_THUMB, (clientHeight * clientHeight) / scrollHeight) : 0
    const top = overflow ? (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height) : 0
    setBar((prev) => (prev.top === top && prev.height === height ? prev : { top, height }))
  }

  // The content can change without a scroll (a running command), so the bar is worked out after every render.
  useLayoutEffect(measure)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onScroll = () => {
    measure()
    setShown(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setShown(false), HIDE_AFTER_MS)
  }

  return (
    <div className={`autoscroll${className ? ` ${className}` : ''}`}>
      <div ref={body} className="as-body" onScroll={onScroll}>
        {children}
      </div>
      <span className={`as-bar${shown ? ' on' : ''}`} style={{ top: bar.top, height: bar.height }} />
    </div>
  )
}
