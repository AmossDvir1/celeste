import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { Bar, Btn, Message, Note } from '../ui'
import { columnName, decodeText, guessDelimiter, parseDelimited } from '../lib/text'
import type { ViewProps } from '../App'

interface Sheet {
  name: string
  rows: string[][]
  /** The sheet has more rows than were read. */
  more: boolean
}

const READ_ROWS = 5000
const MAX_COLUMNS = 200
const PAGE_ROWS = 1000

/** Reads a workbook (xlsx, xlsm, xlsb, xls, ods) with SheetJS, the first rows of each visible sheet, as the text a cell shows. */
async function readWorkbook(data: ArrayBuffer): Promise<Sheet[]> {
  const XLSX = await import('xlsx')
  const book = XLSX.read(new Uint8Array(data), { type: 'array', cellDates: true, sheetRows: READ_ROWS + 1 })
  const hidden = new Set((book.Workbook?.Sheets ?? []).map((s, i) => (s.Hidden ? book.SheetNames[i] : null)).filter(Boolean))
  return book.SheetNames.filter((n) => !hidden.has(n)).map((name) => {
    const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets[name]!, { header: 1, raw: false, defval: '', blankrows: true })
    return { name, rows: rows.slice(0, READ_ROWS).map((r) => r.map(String)), more: rows.length > READ_ROWS }
  })
}

function readDelimited(data: ArrayBuffer, name: string): Sheet[] {
  const { text, cut } = decodeText(data, 25 * 1024 * 1024)
  const delimiter = /\.tsv$/i.test(name) ? '\t' : guessDelimiter(text)
  const rows = parseDelimited(text, delimiter)
  return [{ name: name.replace(/\.[^.]+$/, ''), rows: rows.slice(0, READ_ROWS), more: cut || rows.length > READ_ROWS }]
}

/** A workbook or a delimited file as a grid: one tab for each sheet, column letters and row numbers, the header row kept in view. */
export default function SheetView({ file, data }: ViewProps) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const [rowsShown, setRowsShown] = useState(PAGE_ROWS)
  const delimited = /\.(csv|tsv)$/i.test(file.name)

  useEffect(() => {
    let live = true
    const read = delimited ? Promise.resolve(readDelimited(data, file.name)) : readWorkbook(data)
    read.then((s) => live && setSheets(s)).catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'The file could not be read.'))
    return () => {
      live = false
    }
  }, [data, delimited, file.name])

  const sheet = sheets?.[current]
  const columns = useMemo(() => Math.min(MAX_COLUMNS, Math.max(1, ...(sheet?.rows.map((r) => r.length) ?? [1]))), [sheet])
  if (error) throw new Error(error)
  if (!sheets) return <Message>Reading {file.name}…</Message>
  if (!sheet) return <Message>This workbook has no sheets to show.</Message>
  return (
    <div className="flex h-screen flex-col bg-panel text-ink">
      {sheets.length > 1 && (
        <Bar>
          <div role="tablist" aria-label="Sheets" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {sheets.map((s, i) => (
              <Btn
                key={s.name}
                role="tab"
                aria-selected={i === current}
                active={i === current}
                onClick={() => {
                  setCurrent(i)
                  setRowsShown(PAGE_ROWS)
                }}
              >
                {s.name}
              </Btn>
            ))}
          </div>
        </Bar>
      )}
      {sheet.more && (
        <Note>
          Only the first {sheet.rows.length.toLocaleString()} rows {delimited ? 'of this file ' : `of “${sheet.name}” `}are shown.
        </Note>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse font-mono text-[12.5px]" aria-label={sheet.name}>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 w-12 min-w-12 border-r border-b border-edge bg-raised px-2 py-1">
                <span className="sr-only">Row</span>
              </th>
              {Array.from({ length: columns }, (_, c) => (
                <th key={c} className="border-r border-b border-edge bg-raised px-3 py-1 text-center font-medium text-ink-muted">
                  {columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.slice(0, rowsShown).map((row, r) => (
              <tr key={r}>
                <th scope="row" className="sticky left-0 z-[5] border-r border-b border-edge bg-raised px-2 py-1 text-right font-normal text-ink-faint select-none">
                  {r + 1}
                </th>
                {Array.from({ length: columns }, (_, c) => {
                  const cell = row[c] ?? ''
                  return (
                    <td key={c} title={cell.length > 40 ? cell : undefined} className={cn('max-w-[340px] truncate border-r border-b border-edge/60 px-3 py-1 whitespace-pre', r === 0 && 'font-semibold text-ink')}>
                      {cell}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length > rowsShown && (
          <div className="p-4">
            <Btn onClick={() => setRowsShown(rowsShown + PAGE_ROWS)}>
              Show {Math.min(PAGE_ROWS, sheet.rows.length - rowsShown).toLocaleString()} more rows
            </Btn>
          </div>
        )}
      </div>
    </div>
  )
}
