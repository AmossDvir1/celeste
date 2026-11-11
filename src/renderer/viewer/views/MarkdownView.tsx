import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { Bar, Btn, Note } from '../ui'
import { decodeText, sizeLabel } from '../lib/text'
import { outline } from '../lib/outline'
import CodeView from './CodeView'
import { Md } from './Md'
import type { ViewProps } from '../App'

/** A Markdown file, drawn for reading with a list of its headings; the source is one click away. */
export default function MarkdownView({ file, data }: ViewProps) {
  const { text, cut } = useMemo(() => decodeText(data, 5 * 1024 * 1024), [data])
  const headings = useMemo(() => outline(text), [text])
  const [source, setSource] = useState(false)
  // Beside the text when the page is wide; above it, closed to begin with, when it is narrow (the browser's pane often is).
  const [wide, setWide] = useState(() => window.innerWidth >= 900)
  const [contents, setContents] = useState(() => window.innerWidth >= 900)
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 900)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  if (source) {
    return (
      <div>
        <Bar>
          <Btn onClick={() => setSource(false)}>Show it drawn</Btn>
        </Bar>
        <CodeView file={file} data={data} />
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-panel text-[15px] text-ink-soft">
      <Bar>
        <span>{sizeLabel(file.size)}</span>
        {headings.length > 1 && (
          <Btn active={contents} onClick={() => setContents(!contents)}>
            Contents
          </Btn>
        )}
        <Btn onClick={() => setSource(true)} className="ml-auto">
          Show the source
        </Btn>
      </Bar>
      {cut && <Note>Only the first 5 megabytes of this {sizeLabel(file.size)} file are shown.</Note>}
      {contents && headings.length > 1 && !wide && (
        <nav aria-label="Contents" className="max-h-56 overflow-y-auto border-b border-edge bg-field/50 px-5 py-3 text-[13px]">
          <ul className="space-y-1">
            {headings.map((h) => (
              <li key={h.id} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                <a href={`#${h.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(h.id)?.scrollIntoView({ block: 'start' }))} className="block min-h-6 truncate py-0.5 text-ink-muted hover:text-ink">
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className={cn('mx-auto flex max-w-[1100px] gap-8 px-6 py-6', !(contents && wide && headings.length > 1) && 'max-w-[780px]')}>
        {contents && wide && headings.length > 1 && (
          <nav aria-label="Contents" className="sticky top-16 max-h-[calc(100vh-5rem)] w-56 shrink-0 self-start overflow-y-auto text-[13px]">
            <ul className="space-y-1">
              {headings.map((h) => (
                <li key={h.id} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                  <a href={`#${h.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(h.id)?.scrollIntoView({ block: 'start' }))} className="block min-h-6 truncate py-0.5 text-ink-muted hover:text-ink">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <article className="min-w-0 max-w-[780px] flex-1">
          <Md source={text} />
        </article>
      </div>
    </div>
  )
}
