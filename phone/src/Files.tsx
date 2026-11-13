import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ChevronRight, File as FileIcon, FileImage, FileSpreadsheet, FileText, Globe, LoaderCircle, RotateCw, X } from 'lucide-react'
import { fileKind, formatBytes, type FileKind, type ProducedFile } from '@shared/produced'
import type { PhoneFilePart } from '@shared/phone'
import { useApp } from './store'

/*
 * Files and pictures the assistant made in a chat (docs/PHONE_PLAN.md, "Files and pictures from the agent"). The chat lists them
 * under the answer; a picture opens in a viewer. The computer sends a file in parts of about 1 MB (`phone.file`), because the relay,
 * the direct link and a Wi-Fi call each refuse one large message, and the phone puts the parts back together here.
 */

const ICON: Record<FileKind, typeof FileText> = { image: FileImage, document: FileText, text: FileText, data: FileSpreadsheet, web: Globe, archive: Archive, other: FileIcon }
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** A picture the phone can show: the kinds a WebView draws. */
export const isPicture = (name: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)

const PART_TIMEOUT_MS = 30_000
const transient = (err: unknown) => err instanceof Error && (err.message.startsWith('Can’t reach') || err.message.includes('did not answer') || err.message === 'timeout')

const withTimeout = <T,>(work: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    work.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    )
  })

function bytesOf(base64: string): Uint8Array {
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Pictures fetched already, so reopening one is instant. A few only: each is held in the phone's memory. */
const kept = new Map<string, Blob>()
const KEPT_MAX = 6

/**
 * A file of a chat, part by part. `progress` is called with 0 to 1 as parts arrive. A part that is not answered is asked for again
 * (twice); a file that changes on the computer between parts is refused rather than joined into something that never existed.
 */
export async function fetchChatFile(sessionId: string, file: ProducedFile, progress: (done: number) => void, signal: AbortSignal): Promise<Blob> {
  const key = `${sessionId}|${file.path}|${file.size}`
  const had = kept.get(key)
  if (had) return had
  const link = useApp.getState().link
  if (!link) throw new Error('Not connected to the computer.')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let first: PhoneFilePart | null = null
  for (let n = 0; ; n++) {
    let part: PhoneFilePart | null = null
    for (let attempt = 0; part === null; attempt++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      try {
        part = await withTimeout(link.call<PhoneFilePart>('phone.file', sessionId, file.path, n), PART_TIMEOUT_MS)
      } catch (err) {
        if (attempt >= 2 || !transient(err)) throw err instanceof Error && err.message === 'timeout' ? new Error('The computer did not answer. Try again.') : err
      }
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (first && part.size !== first.size) throw new Error('The file changed on the computer. Try again.')
    first ??= part
    chunks.push(bytesOf(part.data) as Uint8Array<ArrayBuffer>)
    progress((n + 1) / part.parts)
    if (n + 1 >= part.parts) break
  }
  const blob = new Blob(chunks, { type: first.mime })
  kept.set(key, blob)
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value as string)
  return blob
}

/** The files the assistant made while answering, under the answer. A picture opens; the rest stay on the computer. */
export function FileCards({ sessionId, files, more }: { sessionId: string; files: ProducedFile[]; more: number }) {
  const setViewing = useApp((s) => s.setViewing)
  return (
    <div className="filecards">
      {files.map((f) => {
        const name = nameOf(f.path)
        const Icon = ICON[fileKind(name)]
        const pic = isPicture(name)
        const body = (
          <>
            <Icon size={17} />
            <div className="grow">
              <div className="l">{name}</div>
              <div className="d">
                {formatBytes(f.size)}
                {f.status === 'added' ? ' · new' : ' · changed'}
                {!pic && ' · on the computer'}
              </div>
            </div>
            {pic && <ChevronRight size={16} />}
          </>
        )
        return pic ? (
          <button key={f.path} className="m-tool tap" onClick={() => setViewing({ sessionId, file: f })}>
            {body}
          </button>
        ) : (
          <div key={f.path} className="m-tool">
            {body}
          </div>
        )
      })}
      {more > 0 && <div className="notice">and {more} more on the computer</div>}
    </div>
  )
}

type Load = { phase: 'loading'; done: number } | { phase: 'ready'; url: string } | { phase: 'failed'; message: string }

/** The picture, full screen: fetched part by part with a progress bar, then pinched, dragged and double-tapped to zoom. */
export function PictureViewer() {
  const viewing = useApp((s) => s.viewing)
  const setViewing = useApp((s) => s.setViewing)
  const [load, setLoad] = useState<Load>({ phase: 'loading', done: 0 })
  const [attempt, setAttempt] = useState(0)
  const [bar, setBar] = useState(true)

  useEffect(() => {
    if (!viewing) return
    setBar(true)
    setLoad({ phase: 'loading', done: 0 })
    const ctl = new AbortController()
    let url = ''
    fetchChatFile(viewing.sessionId, viewing.file, (done) => setLoad({ phase: 'loading', done }), ctl.signal).then(
      (blob) => {
        if (ctl.signal.aborted) return
        url = URL.createObjectURL(blob)
        setLoad({ phase: 'ready', url })
      },
      (err: unknown) => {
        if (ctl.signal.aborted) return
        setLoad({ phase: 'failed', message: err instanceof Error ? err.message : 'The picture could not be fetched.' })
      }
    )
    return () => {
      ctl.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [viewing, attempt])

  if (!viewing) return null
  const name = nameOf(viewing.file.path)
  return createPortal(
    <div className="viewer" role="dialog" aria-label={name}>
      {load.phase === 'ready' && <ZoomImage src={load.url} alt={name} onTap={() => setBar((b) => !b)} />}
      {load.phase === 'loading' && (
        <div className="viewer-msg">
          <LoaderCircle className="spin" size={26} />
          <div>{load.done > 0 ? `Fetching ${Math.round(load.done * 100)}%` : 'Fetching from the computer'}</div>
          <div className="viewer-track">
            <div className="viewer-fill" style={{ width: `${Math.max(4, load.done * 100)}%` }} />
          </div>
        </div>
      )}
      {load.phase === 'failed' && (
        <div className="viewer-msg">
          <div>{load.message}</div>
          <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCw size={16} /> Try again
          </button>
        </div>
      )}
      <div className={`viewer-bar${bar || load.phase !== 'ready' ? '' : ' hide'}`}>
        <div className="grow">
          <div className="l">{name}</div>
          <div className="d">{formatBytes(viewing.file.size)}</div>
        </div>
        <button className="iconbtn" aria-label="Close" onClick={() => setViewing(null)}>
          <X size={22} />
        </button>
      </div>
    </div>,
    document.body
  )
}

const MAX_ZOOM = 8
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** An image that zooms with two fingers, drags when zoomed, and zooms in and out on a double tap. One tap is `onTap`. */
function ZoomImage({ src, alt, onTap }: { src: string; alt: string; onTap: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  // Scale and offset from the middle of the box; kept out of React state so a gesture never waits for a render.
  const tf = useRef({ s: 1, x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ dist: number; s: number; x: number; y: number; mx: number; my: number } | null>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const tap = useRef<{ at: number; x: number; y: number; moved: boolean; last: { at: number; x: number; y: number } | null }>({ at: 0, x: 0, y: 0, moved: false, last: null })

  const apply = () => {
    const el = img.current
    const b = box.current
    if (!el || !b) return
    const t = tf.current
    const maxX = Math.max(0, (el.offsetWidth * t.s - b.clientWidth) / 2)
    const maxY = Math.max(0, (el.offsetHeight * t.s - b.clientHeight) / 2)
    t.x = clamp(t.x, -maxX, maxX)
    t.y = clamp(t.y, -maxY, maxY)
    el.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`
  }

  // Relative to the middle of the box.
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
  }

  const zoomAt = (p: { x: number; y: number }, to: number) => {
    const t = tf.current
    const s = clamp(to, 1, MAX_ZOOM)
    t.x = p.x - ((p.x - t.x) / t.s) * s
    t.y = p.y - ((p.y - t.y) / t.s) * s
    t.s = s
    if (s === 1) (t.x = 0), (t.y = 0)
  }

  const onDown = (e: React.PointerEvent) => {
    box.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, local(e))
    const t = tf.current
    if (pointers.current.size === 1) {
      const p = local(e)
      drag.current = { x: p.x, y: p.y, ox: t.x, oy: t.y }
      tap.current = { ...tap.current, at: Date.now(), x: p.x, y: p.y, moved: false }
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: t.s, x: t.x, y: t.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
      tap.current.moved = true
    }
  }

  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const p = local(e)
    pointers.current.set(e.pointerId, p)
    const t = tf.current
    if (pointers.current.size >= 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }]
      const g = gesture.current
      const s = clamp((g.s * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist, 1, MAX_ZOOM)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      // The point of the picture that was under the fingers' middle stays under it.
      t.x = mx - ((g.mx - g.x) / g.s) * s
      t.y = my - ((g.my - g.y) / g.s) * s
      t.s = s
      apply()
    } else if (drag.current) {
      if (Math.hypot(p.x - drag.current.x, p.y - drag.current.y) > 8) tap.current.moved = true
      if (t.s > 1) {
        t.x = drag.current.ox + (p.x - drag.current.x)
        t.y = drag.current.oy + (p.y - drag.current.y)
        apply()
      }
    }
  }

  const onUp = (e: React.PointerEvent) => {
    const had = pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) gesture.current = null
    if (pointers.current.size === 1) {
      // One finger stays after a pinch: carry on dragging from where it is.
      const [rest] = [...pointers.current.values()] as [{ x: number; y: number }]
      drag.current = { x: rest.x, y: rest.y, ox: tf.current.x, oy: tf.current.y }
      return
    }
    if (pointers.current.size > 0 || !had) return
    drag.current = null
    const k = tap.current
    if (k.moved || Date.now() - k.at > 350) return
    const now = Date.now()
    if (k.last && now - k.last.at < 300 && Math.hypot(k.x - k.last.x, k.y - k.last.y) < 40) {
      // Double tap: in to where it was tapped, or back out.
      zoomAt({ x: k.x, y: k.y }, tf.current.s > 1.05 ? 1 : 2.5)
      apply()
      k.last = null
    } else {
      k.last = { at: now, x: k.x, y: k.y }
      // A single tap waits a moment to see whether a second one follows.
      const mark = k.last
      setTimeout(() => k.last === mark && (onTap(), (k.last = null)), 300)
    }
  }

  return (
    <div ref={box} className="zoombox" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <img ref={img} src={src} alt={alt} draggable={false} onLoad={apply} />
    </div>
  )
}
