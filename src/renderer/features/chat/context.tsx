import { Folder, FileText, X } from 'lucide-react'
import type { ContextRef } from '@shared/agent'
import { cn } from '@/lib/cn'
import { basename } from '@/lib/format'

/** What a drag from the Files panel carries: a list of files and folders of the open project. */
export const CONTEXT_MIME = 'application/x-celeste-context'

/** Reads what a drag carried, or nothing if it is not ours or is not shaped right. */
export function readContextDrag(data: DataTransfer | null): ContextRef[] {
  try {
    const raw = data?.getData(CONTEXT_MIME)
    if (!raw) return []
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.flatMap((x): ContextRef[] => {
      const item = x as Partial<ContextRef>
      return typeof item?.path === 'string' && item.path !== '' && (item.kind === 'file' || item.kind === 'dir') ? [{ path: item.path, kind: item.kind }] : []
    })
  } catch {
    return []
  }
}

export const isContextDrag = (data: DataTransfer | null) => Array.from(data?.types ?? []).includes(CONTEXT_MIME)

/** Files and folders of the project added to a message: in the composer (with a remove button) or under a sent message. */
export function ContextStrip({ items, onRemove, className }: { items: ContextRef[]; onRemove?: (path: string) => void; className?: string }) {
  if (items.length === 0) return null
  return (
    <ul aria-label="Files added as context" className={cn('flex flex-wrap gap-1.5', className)}>
      {items.map((c) => {
        const Icon = c.kind === 'dir' ? Folder : FileText
        const dir = c.path.slice(0, c.path.length - basename(c.path).length)
        return (
          <li key={c.path} title={c.path} className="flex h-8 max-w-[300px] items-center gap-1.5 rounded-lg border border-edge bg-raised/80 pr-1.5 pl-2 text-[12.5px]">
            <Icon className={cn('h-3.5 w-3.5 shrink-0', c.kind === 'dir' ? 'text-accent-text' : 'text-ink-muted')} />
            <span className="min-w-0 truncate font-mono">
              <span className="text-ink-faint">{dir}</span>
              <span className="text-ink">{basename(c.path)}</span>
              {c.kind === 'dir' && <span className="text-ink-faint">/</span>}
            </span>
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${c.path} from the message`}
                onClick={() => onRemove(c.path)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-faint hover:bg-hover hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
