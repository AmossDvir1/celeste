import { useEffect, useState } from 'react'
import { Folder, FileText } from 'lucide-react'
import { Bar, Message, Note } from '../ui'
import { sizeLabel } from '../lib/text'
import type { ViewProps } from '../App'

interface Entry {
  name: string
  dir: boolean
  size: number
  date: string
}

const MAX = 5000

/** What is inside an archive (.zip), listed. It is not unpacked. */
export default function ZipView({ file, data }: ViewProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { default: JSZip } = await import('jszip')
        const zip = await JSZip.loadAsync(data)
        const list = Object.values(zip.files).map((f) => ({
          name: f.name,
          dir: f.dir,
          size: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
          date: f.date ? f.date.toLocaleDateString([], { dateStyle: 'medium' }) : ''
        }))
        if (live) setEntries(list.sort((a, b) => a.name.localeCompare(b.name)))
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'The archive could not be read.')
      }
    })()
    return () => {
      live = false
    }
  }, [data])

  if (error) throw new Error(error)
  if (!entries) return <Message>Reading {file.name}…</Message>
  const files = entries.filter((e) => !e.dir)
  return (
    <div className="min-h-screen bg-panel text-ink">
      <Bar>
        <span>
          {files.length.toLocaleString()} {files.length === 1 ? 'file' : 'files'} · {sizeLabel(files.reduce((n, e) => n + e.size, 0))} when unpacked
        </span>
      </Bar>
      {entries.length > MAX && <Note>Only the first {MAX.toLocaleString()} entries are listed.</Note>}
      <ul className="font-mono text-[12.5px]">
        {entries.slice(0, MAX).map((e) => (
          <li key={e.name} className="flex items-center gap-3 border-b border-edge/50 px-4 py-1.5">
            {e.dir ? <Folder aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" /> : <FileText aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />}
            <span className="min-w-0 flex-1 truncate" title={e.name}>
              {e.name}
            </span>
            <span className="w-20 shrink-0 text-right text-ink-muted">{e.dir ? '' : sizeLabel(e.size)}</span>
            <span className="w-28 shrink-0 text-right text-ink-faint">{e.date}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
