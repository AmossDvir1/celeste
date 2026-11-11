import { useEffect, useRef, useState } from 'react'
import { Bar, Message, Zoom } from '../ui'
import type { ViewProps } from '../App'

/** A Word document (.docx), drawn page by page with docx-preview. The paper is white in both themes, as it would print. */
export default function DocxView({ file, data }: ViewProps) {
  const body = useRef<HTMLDivElement>(null)
  const styles = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | string>('loading')
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview')
        if (!live || !body.current || !styles.current) return
        body.current.innerHTML = ''
        await renderAsync(data, body.current, styles.current, { className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, renderFootnotes: true, renderEndnotes: true, renderHeaders: true, renderFooters: true })
        if (!live) return
        // A page is wider than a narrow pane: it is shown at the size that fits (the zoom buttons change that), and is never cut off at the left.
        const wrapper = body.current.querySelector<HTMLElement>('.docx-wrapper')
        if (wrapper) wrapper.style.alignItems = 'safe center'
        const page = body.current.querySelector<HTMLElement>('section.docx')
        if (page && page.offsetWidth > 0) setZoom(Math.min(1, Math.floor(((window.innerWidth - 32) / page.offsetWidth) * 100) / 100))
        setState('ready')
      } catch (e) {
        if (live) setState(e instanceof Error ? e.message : 'The document could not be drawn.')
      }
    })()
    return () => {
      live = false
    }
  }, [data])

  if (state !== 'loading' && state !== 'ready') throw new Error(state)
  return (
    <div className="min-h-screen bg-canvas">
      <Bar>
        <span>{file.name}</span>
        <Zoom value={zoom} onChange={setZoom} />
      </Bar>
      {state === 'loading' && <Message>Drawing {file.name}…</Message>}
      <div ref={styles} />
      {/* docx-preview draws its own pages, and its wrapper has a grey background of its own. */}
      <div ref={body} style={{ zoom }} className="[&_.docx-wrapper]:bg-transparent! [&_.docx-wrapper]:p-6!" />
    </div>
  )
}
