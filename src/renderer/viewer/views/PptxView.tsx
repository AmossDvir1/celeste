import { useEffect, useRef, useState } from 'react'
import { Bar, Btn, Message, Zoom } from '../ui'
import type { ViewProps } from '../App'

/** A PowerPoint presentation (.pptx), drawn with pptx-preview: all the slides in a column, or one at a time. */
export default function PptxView({ file, data }: ViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | string>('loading')
  const [mode, setMode] = useState<'list' | 'slide'>('list')
  const [zoom, setZoom] = useState(1)
  const [slides, setSlides] = useState(0)

  useEffect(() => {
    let live = true
    let previewer: { destroy(): void } | null = null
    void (async () => {
      try {
        const { init } = await import('pptx-preview')
        const el = host.current
        if (!live || !el) return
        el.innerHTML = ''
        const width = Math.max(320, Math.round(Math.min(1100, (el.clientWidth || 900) - 48) * zoom))
        const p = init(el, { width, height: Math.round((width * 9) / 16), mode })
        previewer = p
        await p.preview(data)
        // The library does not report a file it could not read: it just draws nothing.
        if (!p.slideCount) throw new Error('No slides could be read from this presentation. It may use something this viewer does not support: open it in PowerPoint.')
        // The slides keep the shape the file gave them; the area around them is as tall as they are (one at a time) or as all of them (a column).
        const wrapper = p.wrapper
        if (mode === 'list') {
          wrapper.style.height = 'auto'
          wrapper.style.overflow = 'visible'
        } else {
          wrapper.style.height = `${Math.round((width * p.pptx.height) / p.pptx.width)}px`
        }
        if (live) {
          setSlides(p.slideCount)
          setState('ready')
        }
      } catch (e) {
        if (live) setState(e instanceof Error ? e.message : 'The presentation could not be drawn.')
      }
    })()
    return () => {
      live = false
      try {
        previewer?.destroy()
      } catch {
        // Already gone.
      }
    }
  }, [data, mode, zoom])

  if (state !== 'loading' && state !== 'ready') throw new Error(state)
  return (
    <div className="min-h-screen bg-canvas">
      <Bar>
        <span>
          {file.name}
          {slides ? ` · ${slides} ${slides === 1 ? 'slide' : 'slides'}` : ''}
        </span>
        <Btn active={mode === 'list'} onClick={() => setMode('list')}>
          All slides
        </Btn>
        <Btn active={mode === 'slide'} onClick={() => setMode('slide')}>
          One at a time
        </Btn>
        <Zoom value={zoom} onChange={setZoom} min={0.5} max={1.5} />
      </Bar>
      {state === 'loading' && <Message>Drawing {file.name}…</Message>}
      <div ref={host} className="flex justify-center overflow-auto p-6" />
    </div>
  )
}
