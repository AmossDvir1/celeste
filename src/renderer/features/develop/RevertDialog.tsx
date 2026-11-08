import { useEffect, useState } from 'react'
import { FilePlus, FileText, FileX } from 'lucide-react'
import type { CheckpointChanges, CheckpointFile } from '@shared/api'
import { Modal } from '@/components/Dialog'
import { Button, Spinner } from '@/components/ui'
import { basename } from '@/lib/format'
import { useSessions } from '@/stores/sessions'

/** What a revert does to one file, in the words the person will use: the preview is already turned around to the result. */
const WHAT: Record<CheckpointFile['status'], { label: string; tone: string; icon: typeof FileText }> = {
  added: { label: 'Put back', tone: 'text-success', icon: FilePlus },
  deleted: { label: 'Removed', tone: 'text-danger', icon: FileX },
  modified: { label: 'Changed back', tone: 'text-ink-muted', icon: FileText }
}

/** Asks before putting a project folder back to an earlier point, and shows exactly which files that touches. */
export function RevertDialog({ sessionId, checkpointId, onClose }: { sessionId: string; checkpointId: string; onClose: () => void }) {
  const previewRevert = useSessions((s) => s.previewRevert)
  const revert = useSessions((s) => s.revert)
  const [changes, setChanges] = useState<CheckpointChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    previewRevert(sessionId, checkpointId).then(
      (c) => current && setChanges(c),
      (err: unknown) => current && setError(err instanceof Error ? err.message : 'Could not look at the folder.')
    )
    return () => {
      current = false
    }
  }, [previewRevert, sessionId, checkpointId])

  const total = changes ? changes.files.length + changes.more : 0
  const nothing = changes !== null && total === 0

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Revert to before this message?"
      description="The project folder goes back to how it was when you sent it. Everything the agent changed since is undone."
      className="w-[min(560px,calc(100vw-48px))]"
    >
      <div className="px-6 pt-4 pb-5">
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        {!changes && !error && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-ink-muted">
            <Spinner className="h-3.5 w-3.5" /> Looking at the folder…
          </p>
        )}
        {nothing && <p className="text-[13px] text-ink-muted">Nothing to undo: the folder is already as it was.</p>}
        {changes && total > 0 && (
          <>
            <p className="mb-2 text-[13px] text-ink-muted">
              {total} {total === 1 ? 'file' : 'files'} will change:
            </p>
            <ul aria-label="Files that will change" className="max-h-[260px] divide-y divide-edge overflow-auto rounded-xl border border-edge bg-field">
              {changes.files.map((f) => {
                const what = WHAT[f.status]
                const Icon = what.icon
                const dir = f.path.slice(0, f.path.length - basename(f.path).length)
                return (
                  <li key={f.path} className="flex items-center gap-2.5 px-3 py-2 text-[12.5px]">
                    <Icon className={`h-4 w-4 shrink-0 ${what.tone}`} />
                    <span className="min-w-0 flex-1 truncate font-mono">
                      <span className="text-ink-faint">{dir}</span>
                      <span className="text-ink">{basename(f.path)}</span>
                    </span>
                    <span className={`shrink-0 ${what.tone}`}>{what.label}</span>
                  </li>
                )
              })}
              {changes.more > 0 && <li className="px-3 py-2 text-[12.5px] text-ink-faint">and {changes.more} more</li>}
            </ul>
          </>
        )}
        <p className="mt-3 text-xs text-ink-faint">
          Files your .gitignore ignores, and files over 25 MB, are not saved and are not touched. You can undo a revert right after.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {nothing || error ? 'Close' : 'Cancel'}
          </Button>
          {changes && total > 0 && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void revert(sessionId, checkpointId).then((ok) => {
                  setBusy(false)
                  if (ok) onClose()
                })
              }}
            >
              {busy ? 'Reverting…' : `Revert ${total} ${total === 1 ? 'file' : 'files'}`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
