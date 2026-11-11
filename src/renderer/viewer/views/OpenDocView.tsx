import { useEffect, useState } from 'react'
import { Bar, Message, Note } from '../ui'
import { odfBlocks, type OdfBlock } from '../lib/opendoc'
import type { ViewProps } from '../App'

/** An OpenDocument text or presentation (.odt, .odp), as its words: headings, paragraphs, lists, tables, and the slides. Not the layout. */
export default function OpenDocView({ file, data }: ViewProps) {
  const [blocks, setBlocks] = useState<OdfBlock[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { default: JSZip } = await import('jszip')
        const zip = await JSZip.loadAsync(data)
        const content = zip.file('content.xml')
        if (!content) throw new Error('There is no text in this file.')
        const list = odfBlocks(await content.async('string'))
        if (live) setBlocks(list)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'The file could not be read.')
      }
    })()
    return () => {
      live = false
    }
  }, [data])

  if (error) throw new Error(error)
  if (!blocks) return <Message>Reading {file.name}…</Message>
  return (
    <div className="min-h-screen bg-panel text-ink-soft">
      <Bar>
        <span>{file.name}</span>
      </Bar>
      <Note>A simplified view: the words and their order, not the layout. Open the file in your own program to see it as it was made.</Note>
      <article className="mx-auto max-w-[780px] px-6 py-6 text-[15px] leading-[1.75]">
        {blocks.map((b, i) => {
          if (b.type === 'heading') {
            const sizes = ['text-[26px]', 'text-[21px]', 'text-[17px]', 'text-[15px]']
            return (
              <h2 key={i} className={`mt-6 mb-2 font-semibold text-ink ${sizes[Math.min(b.level, 4) - 1]}`}>
                {b.text}
              </h2>
            )
          }
          if (b.type === 'item')
            return (
              <p key={i} className="my-1 flex gap-2" style={{ paddingLeft: `${(b.depth - 1) * 20 + 8}px` }}>
                <span aria-hidden className="text-ink-faint">
                  •
                </span>
                <span className="whitespace-pre-wrap">{b.text}</span>
              </p>
            )
          if (b.type === 'row')
            return (
              <div key={i} className="my-0.5 grid gap-px overflow-hidden rounded bg-edge text-[14px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, b.cells.length)}, minmax(0, 1fr))` }}>
                {b.cells.map((c, j) => (
                  <div key={j} className="bg-panel px-2 py-1 whitespace-pre-wrap">
                    {c || ' '}
                  </div>
                ))}
              </div>
            )
          if (b.type === 'slide')
            return (
              <h3 key={i} className="mt-8 mb-2 border-t border-edge pt-4 text-[12px] font-medium tracking-wider text-ink-faint uppercase">
                Slide {b.number}
              </h3>
            )
          return (
            <p key={i} className="my-3 whitespace-pre-wrap">
              {b.text}
            </p>
          )
        })}
      </article>
    </div>
  )
}
