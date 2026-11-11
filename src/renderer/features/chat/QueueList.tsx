import { Check, Paperclip, Pencil, Play, Trash2, X, Zap } from 'lucide-react'
import type { QueueAction, QueuedMessage, QueueState } from '@shared/queue'
import { IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'

/** What a waiting message shows: its first words, or what it carries when it has no words. */
function label(m: QueuedMessage): string {
  const words = m.text.replace(/\s+/g, ' ').trim()
  if (words) return words
  const n = m.attachments.length + (m.context?.length ?? 0)
  return n === 1 ? '1 file' : `${n} files`
}

/**
 * The messages typed while the assistant works, above the message box: each can be changed, removed, or sent now (which stops the
 * turn that is running). A queue that is paused (the turn was stopped or failed, or Celeste was closed) says so, and waits for a yes.
 */
export interface QueueEdit {
  id: string
  text: string
}

export function QueueList({
  queue,
  working,
  onAction,
  editing,
  onEditing,
  onEditDone
}: {
  queue: QueueState
  working: boolean
  onAction: (a: QueueAction) => void
  /** The message being changed. Held by the parent so the message box can open it with the Up arrow. */
  editing: QueueEdit | null
  onEditing: (edit: QueueEdit | null) => void
  /** Called when a change is saved or cancelled, so focus can go back to the message box. */
  onEditDone?: () => void
}) {
  if (queue.items.length === 0) return null
  const setEditing = onEditing

  const finish = () => {
    setEditing(null)
    onEditDone?.()
  }
  const commit = () => {
    if (editing) {
      const original = queue.items.find((m) => m.id === editing.id)
      const emptied = !editing.text.trim() && !original?.attachments.length && !original?.context?.length
      if (original && !emptied && editing.text !== original.text) onAction({ type: 'edit', queueId: editing.id, text: editing.text })
    }
    finish()
  }

  return (
    <div className="mb-2 rounded-xl border border-edge bg-raised/50 px-2 py-1.5" role="list" aria-label="Messages waiting">
      {queue.paused && (
        <div className="mb-1 flex flex-wrap items-center gap-2 px-1.5 py-1 text-xs text-ink-soft">
          <span>{working ? 'Paused.' : 'Paused, so nothing is sent by itself.'}</span>
          <button type="button" onClick={() => onAction({ type: 'resume' })} className="inline-flex items-center gap-1 font-medium text-accent-text hover:underline">
            <Play className="h-3 w-3" /> Send {queue.items.length === 1 ? 'it' : 'them'}
          </button>
          <button type="button" onClick={() => onAction({ type: 'clear' })} className="text-ink-muted hover:text-ink hover:underline">
            Clear
          </button>
        </div>
      )}
      {queue.items.map((m, i) => {
        const mine = editing?.id === m.id
        return (
          <div key={m.id} role="listitem" className={cn('group flex items-center gap-1.5 rounded-lg px-1.5 py-1', !mine && 'hover:bg-hover')}>
            <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-ink-faint">{i + 1}</span>
            {mine ? (
              <input
                autoFocus
                value={editing.text}
                aria-label="Edit the waiting message"
                onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit()
                  if (e.key === 'Escape') finish()
                }}
                className="selectable min-w-0 flex-1 rounded-md border border-edge-strong bg-transparent px-2 py-1 text-[13px] text-ink outline-none"
              />
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-ink" title={m.text}>
                <span className="truncate">{label(m)}</span>
                {m.text.trim() && m.attachments.length + (m.context?.length ?? 0) > 0 && <Paperclip className="h-3 w-3 shrink-0 text-ink-faint" />}
              </span>
            )}
            {mine ? (
              <>
                <IconButton label="Save" size="sm" onClick={commit}>
                  <Check className="h-4 w-4" />
                </IconButton>
                <IconButton label="Cancel" size="sm" onClick={finish}>
                  <X className="h-4 w-4" />
                </IconButton>
              </>
            ) : (
              <>
                <IconButton label={working ? 'Stop and send this now' : 'Send now'} size="sm" onClick={() => onAction({ type: 'now', queueId: m.id })}>
                  <Zap className="h-4 w-4" />
                </IconButton>
                <IconButton label="Edit" size="sm" onClick={() => setEditing({ id: m.id, text: m.text })}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton label="Remove" size="sm" onClick={() => onAction({ type: 'remove', queueId: m.id })}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
