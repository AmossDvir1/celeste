import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Bar, Btn, Note } from '../ui'
import { decodeText } from '../lib/text'
import CodeView from './CodeView'
import type { ViewProps } from '../App'

const PAGE = 100

function Scalar({ v }: { v: unknown }) {
  if (typeof v === 'string') return <span className="break-all text-success">“{v}”</span>
  if (typeof v === 'number') return <span className="text-info">{String(v)}</span>
  if (typeof v === 'boolean') return <span className="text-warning">{String(v)}</span>
  return <span className="text-ink-faint">null</span>
}

function Node({ k, v, depth, open }: { k: string | null; v: unknown; depth: number; open: boolean }) {
  const [shown, setShown] = useState(PAGE)
  const complex = v !== null && typeof v === 'object'
  const [expanded, setExpanded] = useState(open || depth < 1)
  const label = k !== null ? <span className="text-accent-text">{k}</span> : null
  if (!complex) {
    return (
      <div className="flex gap-1.5 py-px pl-5">
        {label}
        {label && <span className="text-ink-faint">:</span>}
        <Scalar v={v} />
      </div>
    )
  }
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>)
  const brackets = Array.isArray(v) ? ['[', ']'] : ['{', '}']
  return (
    <div>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="flex items-center gap-1 py-px text-left hover:text-ink">
        <ChevronRight aria-hidden className={cn('h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform', expanded && 'rotate-90')} />
        {label}
        {label && <span className="text-ink-faint">:</span>}
        <span className="text-ink-faint">
          {brackets[0]}
          {!expanded && ` ${entries.length} ${Array.isArray(v) ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'} `}
          {!expanded && brackets[1]}
        </span>
      </button>
      {expanded && (
        <div className="ml-2 border-l border-edge pl-3">
          {entries.slice(0, shown).map(([key, child]) => (
            <Node key={key} k={key} v={child} depth={depth + 1} open={open} />
          ))}
          {entries.length > shown && (
            <button type="button" onClick={() => setShown(shown + PAGE * 5)} className="py-1 pl-5 text-[12.5px] text-accent-text hover:underline">
              Show {Math.min(PAGE * 5, entries.length - shown)} more of {entries.length - shown}
            </button>
          )}
          <div className="text-ink-faint">{brackets[1]}</div>
        </div>
      )}
    </div>
  )
}

/** JSON as a tree that opens and closes, with the raw text a click away; text that is not JSON is shown as text. */
export default function JsonView({ file, data }: ViewProps) {
  const parsed = useMemo(() => {
    const { text, cut } = decodeText(data, 50 * 1024 * 1024)
    if (cut) return { error: 'This file is too large to read as a tree.' }
    try {
      return { value: JSON.parse(text) as unknown }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'This is not valid JSON.' }
    }
  }, [data])
  const [raw, setRaw] = useState(false)
  const [all, setAll] = useState(0)
  if ('error' in parsed || raw) {
    return (
      <div>
        {'error' in parsed && <Note>This is not valid JSON ({parsed.error}), so it is shown as text.</Note>}
        {!('error' in parsed) && (
          <Bar>
            <Btn onClick={() => setRaw(false)}>Show as a tree</Btn>
          </Bar>
        )}
        <CodeView file={file} data={data} />
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-panel font-mono text-[12.5px] leading-[1.65] text-ink">
      <Bar>
        <Btn onClick={() => setAll(all > 0 ? -all - 1 : all - 1)}>Open or close all</Btn>
        <Btn onClick={() => setRaw(true)}>Show the text</Btn>
      </Bar>
      <div className="p-4" key={all}>
        <Node k={null} v={parsed.value} depth={0} open={all < 0 ? false : all > 0} />
      </div>
    </div>
  )
}
