import { useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { Bar, Btn, Note } from '../ui'
import { decodeText, sizeLabel } from '../lib/text'
import type { ViewProps } from '../App'

/** Plain text and source files: line numbers, wrapping on or off, and a search. */
export default function CodeView({ file, data }: ViewProps) {
  const { text, cut } = useMemo(() => decodeText(data), [data])
  const lines = useMemo(() => {
    const all = text.split(/\r\n|\r|\n/)
    // A file that ends with a line break has no empty line after it.
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    return all
  }, [text])
  const [wrap, setWrap] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<boolean | null>(null)
  const box = useRef<HTMLInputElement>(null)
  const find = (backwards: boolean) => {
    if (!query) return
    // The page's own search, which scrolls to and marks the match.
    const ok = (window as unknown as { find: (q: string, c: boolean, b: boolean, w: boolean) => boolean }).find(query, false, backwards, true)
    setFound(ok)
  }
  const width = String(lines.length).length
  return (
    <div className="min-h-screen bg-panel text-ink">
      <Bar>
        <span>
          {lines.length.toLocaleString()} {lines.length === 1 ? 'line' : 'lines'} · {sizeLabel(file.size)}
        </span>
        <input
          ref={box}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setFound(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && find(e.shiftKey)}
          aria-label="Find in this file"
          placeholder="Find"
          className="h-8 w-44 rounded-lg border border-edge bg-field px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
        />
        <Btn onClick={() => find(false)}>Next</Btn>
        {found === false && <span className="text-warning">Not found</span>}
        <Btn active={wrap} onClick={() => setWrap(!wrap)} className="ml-auto">
          Wrap lines
        </Btn>
      </Bar>
      {cut && <Note>Only the first megabyte of this {sizeLabel(file.size)} file is shown.</Note>}
      <div className="py-2 font-mono text-[12.5px] leading-[1.65]" role="document" aria-label={file.name}>
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span aria-hidden className="shrink-0 pr-4 pl-4 text-right text-ink-faint select-none" style={{ minWidth: `${width + 3}ch` }}>
              {i + 1}
            </span>
            <span className={cn('min-w-0 flex-1 pr-4 text-ink', wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre')}>{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
