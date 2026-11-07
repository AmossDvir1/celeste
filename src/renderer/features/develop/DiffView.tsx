import { useState } from 'react'
import { ChevronRight, FilePlus, FileText, FileX } from 'lucide-react'
import type { FileDiff } from '@shared/agent'
import { cn } from '@/lib/cn'
import { basename } from '@/lib/format'

function FileIcon({ status }: { status: FileDiff['status'] }) {
  const cls = 'h-4 w-4 shrink-0'
  if (status === 'added') return <FilePlus className={cn(cls, 'text-success')} />
  if (status === 'deleted') return <FileX className={cn(cls, 'text-danger')} />
  return <FileText className={cn(cls, 'text-ink-muted')} />
}

export function DiffFile({ diff, defaultOpen = true }: { diff: FileDiff; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const dir = diff.path.slice(0, diff.path.length - basename(diff.path).length)
  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-field">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-10 w-full items-center gap-2.5 px-3 text-left hover:bg-hover"
      >
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
        <FileIcon status={diff.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
          <span className="text-ink-faint">{dir}</span>
          <span className="text-ink">{basename(diff.path)}</span>
        </span>
        {diff.status === 'added' && <span className="rounded bg-success/15 px-1.5 text-[11px] text-success">new</span>}
        <span className="shrink-0 font-mono text-[12px]">
          <span className="text-success">+{diff.added}</span> <span className="text-danger">−{diff.removed}</span>
        </span>
      </button>
      {open && (
        <div className="selectable overflow-x-auto border-t border-edge/70 font-mono text-[12.5px] leading-[1.65]">
          {diff.hunks.map((h) => (
            <div key={h.header}>
              <div className="bg-raised/60 px-3 py-1 text-ink-faint">{h.header}</div>
              {h.lines.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    'grid min-w-max grid-cols-[40px_40px_1fr]',
                    l.type === 'add' && 'bg-success/10',
                    l.type === 'del' && 'bg-danger/10'
                  )}
                >
                  <span className="pr-2 text-right text-ink-faint/70 select-none">{l.oldNo ?? ''}</span>
                  <span className="pr-2 text-right text-ink-faint/70 select-none">{l.newNo ?? ''}</span>
                  <span className={cn('pr-4 whitespace-pre', l.type === 'add' && 'text-success', l.type === 'del' && 'text-danger', l.type === 'ctx' && 'text-ink-muted')}>
                    <span className="inline-block w-4 text-center select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                    {l.text}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function DiffList({ diffs, defaultOpen = true }: { diffs: FileDiff[]; defaultOpen?: boolean }) {
  return (
    <div className="space-y-2">
      {diffs.map((d) => (
        <DiffFile key={d.path} diff={d} defaultOpen={defaultOpen} />
      ))}
    </div>
  )
}
