import { FileQuestion } from 'lucide-react'
import { sizeLabel } from '../lib/text'
import type { ViewerFile } from '../App'

/** A file that nothing here shows: what it is, how big, and why not. The ways to open it elsewhere are in the pane's toolbar. */
export default function CardView({ file, note }: { file: ViewerFile; note?: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-panel p-8">
      <div className="max-w-md rounded-2xl border border-edge bg-field p-8 text-center">
        <FileQuestion aria-hidden className="mx-auto h-10 w-10 text-ink-faint" />
        <h1 className="mt-4 text-lg font-semibold break-words text-ink">{file.name}</h1>
        <p className="mt-1 text-[13px] text-ink-muted">
          {file.label}
          {file.size ? ` · ${sizeLabel(file.size)}` : ''}
        </p>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-muted">{note ?? file.note ?? 'Celeste cannot show this kind of file. You can open it in your own program, or show it in its folder, with the buttons above.'}</p>
      </div>
    </div>
  )
}
