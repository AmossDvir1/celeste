import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, PenLine, Trash2, Undo2, X } from 'lucide-react'
import { SKETCH_COLORS, SKETCH_FILE, SKETCH_PAPER, SKETCH_PENS, exportSize, hasInk, keepPoint, withStroke, type SketchPen, type Stroke } from '@shared/sketch'
import { useApp } from './store'
import { buzz } from './ui'

/*
 * A page to draw on with a finger or a pen, sent with the message as a picture (docs/plans/PHONE_PLAN.md, the sketch pad). It is only a picture:
 * the assistant reads it as it reads a photo. The drawing board on the computer, with its shapes and its file, is a different thing.
 */

/** Draws the strokes on a canvas whose width is `width` pixels (a stroke's points and thickness are fractions of it). */
function paint(ctx: CanvasRenderingContext2D, strokes: Stroke[], width: number, height: number): void {
  ctx.fillStyle = SKETCH_PAPER
  ctx.fillRect(0, 0, width, height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of strokes) {
    ctx.strokeStyle = s.color
    ctx.fillStyle = s.color
    ctx.lineWidth = s.width * width
    const [first, ...rest] = s.points
    if (!first) continue
    if (rest.length === 0) {
      // A tap is a dot.
      ctx.beginPath()
      ctx.arc(first.x * width, first.y * width, (s.width * width) / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.beginPath()
    ctx.moveTo(first.x * width, first.y * width)
    for (const p of rest) ctx.lineTo(p.x * width, p.y * width)
    ctx.stroke()
  }
}

export function SketchButton({ onPick, disabled }: { onPick: (files: File[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="camerabtn" aria-label="Draw a sketch" disabled={disabled} onClick={() => setOpen(true)}>
        <PenLine size={20} />
      </button>
      {open &&
        createPortal(
          <SketchPad
            onClose={() => setOpen(false)}
            onDone={(file) => {
              setOpen(false)
              onPick([file])
            }}
          />,
          document.body
        )}
    </>
  )
}

function SketchPad({ onClose, onDone }: { onClose: () => void; onDone: (file: File) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Stroke[]>([])
  /** The stroke being drawn, kept apart until the finger lifts. */
  const drawing = useRef<Stroke | null>(null)
  const pointer = useRef<number | null>(null)
  /** The page's size on the screen, in CSS pixels. */
  const size = useRef({ width: 1, height: 1 })
  const [color, setColor] = useState<string>(SKETCH_COLORS[0].value)
  const [pen, setPen] = useState<SketchPen>('thin')
  // Whether there is anything to undo or to send: the stroke list itself is a ref, so this says when it changed.
  const [count, setCount] = useState(0)
  const [ink, setInk] = useState(false)
  const [saving, setSaving] = useState(false)

  const redraw = useCallback(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    paint(ctx, drawing.current ? [...strokes.current, drawing.current] : strokes.current, c.width, c.height)
  }, [])

  // The page fills its box; when the box changes (the screen turns) the drawing is drawn again at the new size.
  useLayoutEffect(() => {
    const el = wrap.current
    const c = canvas.current
    if (!el || !c) return
    const fit = () => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(3, window.devicePixelRatio || 1)
      size.current = { width: Math.max(1, r.width), height: Math.max(1, r.height) }
      c.width = Math.max(1, Math.round(r.width * dpr))
      c.height = Math.max(1, Math.round(r.height * dpr))
      redraw()
    }
    fit()
    const watch = new ResizeObserver(fit)
    watch.observe(el)
    return () => watch.disconnect()
  }, [redraw])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const changed = () => {
    setCount(strokes.current.length)
    setInk(hasInk(strokes.current))
  }

  /** A point on the page, as a fraction of its width. */
  const at = (e: React.PointerEvent): { x: number; y: number } => {
    const r = (canvas.current as HTMLCanvasElement).getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.width }
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // One finger at a time: a second touch (a palm, a pinch) is left alone while one is drawing.
    if (pointer.current !== null || e.button > 0) return
    pointer.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = { color: pen === 'eraser' ? SKETCH_PAPER : color, width: SKETCH_PENS[pen], points: [at(e)] }
    redraw()
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = drawing.current
    if (!s || e.pointerId !== pointer.current) return
    // The browser batches fast moves: every one of them is a point of the line.
    const batch = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : []
    const events = batch.length ? batch : [e.nativeEvent]
    const r = (canvas.current as HTMLCanvasElement).getBoundingClientRect()
    let drew = false
    for (const ev of events) {
      const p = { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.width }
      if (keepPoint(s.points[s.points.length - 1], p, 0.002)) {
        s.points.push(p)
        drew = true
      }
    }
    if (drew) redraw()
  }

  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== pointer.current) return
    pointer.current = null
    const s = drawing.current
    drawing.current = null
    if (s && s.points.length > 0) strokes.current = withStroke(strokes.current, s)
    changed()
    redraw()
  }

  const undo = () => {
    buzz(6)
    strokes.current = strokes.current.slice(0, -1)
    changed()
    redraw()
  }

  const clear = () => {
    buzz(10)
    strokes.current = []
    changed()
    redraw()
  }

  const add = () => {
    if (saving || !hasInk(strokes.current)) return
    setSaving(true)
    // Drawn again at the size that is sent, so the lines are as sharp there as on the screen.
    const out = exportSize(size.current.width, size.current.height)
    const c = document.createElement('canvas')
    c.width = out.width
    c.height = out.height
    const ctx = c.getContext('2d')
    if (!ctx) {
      setSaving(false)
      return useApp.getState().say('That sketch could not be saved.')
    }
    paint(ctx, strokes.current, out.width, out.height)
    c.toBlob((blob) => {
      if (!blob) {
        setSaving(false)
        return useApp.getState().say('That sketch could not be saved.')
      }
      buzz(12)
      onDone(new File([blob], SKETCH_FILE, { type: 'image/png' }))
    }, 'image/png')
  }

  return (
    <div className="sketch" role="dialog" aria-modal="true" aria-label="Sketch">
      <div className="sketch-head">
        <button type="button" className="iconbtn" aria-label="Close the sketch" onClick={onClose}>
          <X size={22} />
        </button>
        <h1 className="h-l" style={{ fontSize: 18, flex: 1 }}>
          Sketch
        </h1>
        <button type="button" className="btn primary" style={{ height: 40 }} disabled={!ink || saving} onClick={add}>
          Add to message
        </button>
      </div>
      <div className="sketch-board" ref={wrap}>
        <canvas
          ref={canvas}
          aria-label="Drawing page"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div className="sketch-tools">
        <div className="sketch-row" role="radiogroup" aria-label="Colour">
          {SKETCH_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={pen !== 'eraser' && color === c.value}
              aria-label={c.label}
              className={`swatch${pen !== 'eraser' && color === c.value ? ' on' : ''}`}
              style={{ background: c.value }}
              onClick={() => {
                buzz(5)
                setColor(c.value)
                if (pen === 'eraser') setPen('thin')
              }}
            />
          ))}
        </div>
        <div className="sketch-row">
          <button type="button" role="radio" aria-checked={pen === 'thin'} aria-label="Thin pen" className={`pen${pen === 'thin' ? ' on' : ''}`} onClick={() => setPen('thin')}>
            <i style={{ height: 3 }} />
          </button>
          <button type="button" role="radio" aria-checked={pen === 'thick'} aria-label="Thick pen" className={`pen${pen === 'thick' ? ' on' : ''}`} onClick={() => setPen('thick')}>
            <i style={{ height: 9 }} />
          </button>
          <button type="button" role="radio" aria-checked={pen === 'eraser'} aria-label="Eraser" className={`pen${pen === 'eraser' ? ' on' : ''}`} onClick={() => setPen('eraser')}>
            <Eraser size={18} />
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="pen" aria-label="Undo" disabled={count === 0} onClick={undo}>
            <Undo2 size={18} />
          </button>
          <button type="button" className="pen" aria-label="Clear" disabled={count === 0} onClick={clear}>
            <Trash2 size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
