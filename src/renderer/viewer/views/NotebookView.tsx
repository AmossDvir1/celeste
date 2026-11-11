import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { Bar } from '../ui'
import { decodeText } from '../lib/text'
import { parseNotebook } from '../lib/notebook'
import CodeView from './CodeView'
import { Md } from './Md'
import type { ViewProps } from '../App'

/** A Jupyter notebook, read only: its text cells drawn, its code with what it printed and drew. */
export default function NotebookView({ file, data }: ViewProps) {
  const parsed = useMemo(() => {
    try {
      return { notebook: parseNotebook(decodeText(data, 100 * 1024 * 1024).text) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'This is not a notebook.' }
    }
  }, [data])
  if ('error' in parsed) return <CodeView file={file} data={data} />
  const { notebook } = parsed
  return (
    <div className="min-h-screen bg-panel text-ink">
      <Bar>
        <span>
          {notebook.cells.length} cells · {notebook.language}
        </span>
      </Bar>
      <div className="mx-auto max-w-[900px] space-y-4 px-6 py-6">
        {notebook.cells.map((cell, i) =>
          cell.kind === 'markdown' ? (
            <div key={i} className="text-[15px] text-ink-soft">
              <Md source={cell.source} />
            </div>
          ) : (
            <div key={i} className="overflow-hidden rounded-xl border border-edge">
              <div className="flex">
                <span aria-hidden className="w-14 shrink-0 bg-field px-2 py-2 text-right font-mono text-[11.5px] text-ink-faint select-none">
                  {cell.kind === 'code' ? `[${cell.count ?? ' '}]` : 'raw'}
                </span>
                <pre className="min-w-0 flex-1 overflow-x-auto bg-field/60 px-3 py-2 font-mono text-[12.5px] leading-[1.6]">{cell.source || ' '}</pre>
              </div>
              {cell.outputs.map((o, j) =>
                o.kind === 'image' ? (
                  <div key={j} className="border-t border-edge bg-white p-3">
                    <img src={`data:${o.mime};base64,${o.data}`} alt="Output of the cell above" className="max-w-full" />
                  </div>
                ) : (
                  <pre key={j} className={cn('overflow-x-auto border-t border-edge px-3 py-2 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap', o.error ? 'bg-danger/10 text-danger' : 'text-ink-soft')}>
                    {o.text}
                  </pre>
                )
              )}
            </div>
          )
        )}
      </div>
    </div>
  )
}
