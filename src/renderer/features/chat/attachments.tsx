import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { HoverCard } from 'radix-ui'
import { FileText, Image as ImageGlyph, Paperclip, X } from 'lucide-react'
import type { AttachmentInfo, ContextRef } from '@shared/agent'
import { core } from '@/api'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { useDrafts } from '@/stores/drafts'
import { isContextDrag, readContextDrag } from './context'

const MAX_FILES = 10
const MAX_BYTES = 25 * 1024 * 1024
const NONE: AttachmentInfo[] = []

async function readDimensions(file: File): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      img.onerror = () => resolve(null)
      img.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface AttachmentsApi {
  items: AttachmentInfo[]
  add: (files: FileList | File[]) => Promise<void>
  remove: (id: string) => void
  /** Empties the composer after a send. The files stay: the sent message now owns them. */
  clear: () => void
  notice: string | null
  dismissNotice: () => void
}

/**
 * The files attached to the draft at `draftKey`. Each is saved as soon as it is added, so a draft with
 * files survives a restart, and the preview of a sent message still shows after the original moves.
 */
export function useAttachments(draftKey: string): AttachmentsApi {
  const items = useDrafts((s) => s.drafts[draftKey]?.attachments ?? NONE)
  const [notice, setNotice] = useState<string | null>(null)

  const add = useCallback(
    async (input: FileList | File[]) => {
      const files = Array.from(input)
      if (files.length === 0) return
      const have = useDrafts.getState().drafts[draftKey]?.attachments.length ?? 0
      const room = Math.max(0, MAX_FILES - have)
      const small = files.filter((f) => f.size <= MAX_BYTES)
      const accepted = small.slice(0, room)
      if (small.length < files.length) {
        setNotice(`Files over ${formatBytes(MAX_BYTES)} were skipped.`)
      } else if (small.length > room) {
        setNotice(`You can attach up to ${MAX_FILES} files at once.`)
      } else {
        setNotice(null)
      }
      try {
        const saved = await Promise.all(
          accepted.map(async (f): Promise<AttachmentInfo> => {
            const dims = f.type.startsWith('image/') ? await readDimensions(f) : null
            return core.call('attachments.save', {
              name: f.name || 'pasted-image.png',
              mime: f.type || 'application/octet-stream',
              data: await f.arrayBuffer(),
              ...(dims ?? {})
            })
          })
        )
        useDrafts.getState().setAttachments(draftKey, (cur) => [...cur, ...saved])
      } catch {
        setNotice('That file could not be attached.')
      }
    },
    [draftKey]
  )

  const remove = useCallback(
    (id: string) => {
      useDrafts.getState().setAttachments(draftKey, (cur) => cur.filter((a) => a.id !== id))
      void core.call('attachments.discard', id).catch(() => undefined)
    },
    [draftKey]
  )

  const clear = useCallback(() => {
    useDrafts.getState().setAttachments(draftKey, () => [])
    setNotice(null)
  }, [draftKey])

  return { items, add, remove, clear, notice, dismissNotice: () => setNotice(null) }
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/** Wraps a panel so files can be dropped anywhere on it. Shows a full-panel overlay while dragging. */
export function DropZone({
  onFiles,
  onProject,
  children,
  className
}: {
  onFiles: (files: FileList) => void
  /** Files and folders dragged from the Files panel. Absent where there is no project. */
  onProject?: (refs: ContextRef[]) => void
  children: ReactNode
  className?: string
}) {
  // What is being dragged over it: files from the computer, or things from the project's own Files panel.
  const [over, setOver] = useState<'files' | 'project' | null>(null)
  const depth = useRef(0)
  const kindOf = (e: DragEvent): 'files' | 'project' | null => (hasFiles(e) ? 'files' : onProject && isContextDrag(e.dataTransfer) ? 'project' : null)

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => {
        const kind = kindOf(e)
        if (!kind) return
        e.preventDefault()
        depth.current += 1
        setOver(kind)
      }}
      onDragOver={(e) => {
        if (!kindOf(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!kindOf(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(null)
      }}
      onDrop={(e) => {
        const kind = kindOf(e)
        if (!kind) return
        // Without this a drop on the message box would also type the dropped text into it.
        e.preventDefault()
        depth.current = 0
        setOver(null)
        if (kind === 'files') {
          if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
        } else {
          const refs = readContextDrag(e.dataTransfer)
          if (refs.length) onProject?.(refs)
        }
      }}
    >
      {children}
      {over && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-hero border-2 border-dashed border-accent-edge bg-canvas/80 backdrop-blur-sm"
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-text">
              <Paperclip className="h-6 w-6" />
            </span>
            <div className="text-lg font-medium text-ink">{over === 'project' ? 'Drop to add as context' : 'Drop files to attach'}</div>
            <div className="text-sm text-ink-muted">{over === 'project' ? 'The agent is given what is in them with your message' : 'Hover an image afterwards to preview it'}</div>
          </div>
        </div>
      )}
    </div>
  )
}

const isImage = (a: AttachmentInfo) => a.mime.startsWith('image/') && !!a.url

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : 'FILE'
}

function describe(a: AttachmentInfo): string {
  const dims = a.width && a.height ? `${a.width} × ${a.height} · ` : ''
  return `${dims}${formatBytes(a.size)}`
}

/** A file in the composer or a sent message. Hovering or focusing an image shows a larger preview. */
export function AttachmentChip({ a, onRemove }: { a: AttachmentInfo; onRemove?: () => void }) {
  const chip = (
    <div
      tabIndex={0}
      aria-label={`${a.name}, ${describe(a)}${isImage(a) ? '. Hover or focus to preview' : ''}`}
      className="group flex h-12 max-w-[240px] items-center gap-2 rounded-lg border border-edge bg-raised/80 p-1 pr-2 outline-offset-2"
    >
      {isImage(a) ? (
        <img src={a.url} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" draggable={false} />
      ) : (
        <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-md bg-accent-soft text-accent-text">
          <FileText className="h-4 w-4" />
          <span className="text-[8px] leading-none font-semibold">{extension(a.name)}</span>
        </span>
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13px] text-ink">{a.name}</span>
        <span className="truncate text-[11px] text-ink-faint">{describe(a)}</span>
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${a.name}`}
          onClick={onRemove}
          className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ink-faint hover:bg-hover hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )

  if (!isImage(a)) return chip

  return (
    <HoverCard.Root openDelay={120} closeDelay={60}>
      <HoverCard.Trigger asChild>{chip}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={16}
          className="pop-in z-[80] rounded-xl border border-edge-strong bg-raised-2 p-2 shadow-pop"
        >
          <img
            src={a.url}
            alt={`Preview of ${a.name}`}
            className="block max-h-[320px] max-w-[min(440px,80vw)] rounded-lg object-contain"
            draggable={false}
          />
          <div className="mt-2 flex items-center gap-1.5 px-1 text-xs text-ink-muted">
            <ImageGlyph className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-medium text-ink">{a.name}</span>
            <span className="shrink-0">· {describe(a)}</span>
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}

export function AttachmentStrip({
  items,
  onRemove,
  className
}: {
  items: AttachmentInfo[]
  onRemove?: (id: string) => void
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {items.map((a) => (
        <AttachmentChip key={a.id} a={a} onRemove={onRemove ? () => onRemove(a.id) : undefined} />
      ))}
    </div>
  )
}
