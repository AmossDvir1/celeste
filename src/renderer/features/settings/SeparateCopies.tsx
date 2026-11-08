import { useCallback, useEffect, useState } from 'react'
import { GitBranch, RefreshCw, Trash2 } from 'lucide-react'
import type { WorktreeInfo } from '@shared/api'
import { core } from '@/api'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button, IconButton, Spinner } from '@/components/ui'
import { useUi } from '@/stores/ui'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What would be lost if this copy were removed, in words. */
function lost(w: WorktreeInfo): string {
  const parts = [w.changed > 0 && plural(w.changed, 'file changed and not committed', 'files changed and not committed'), w.ahead > 0 && plural(w.ahead, 'commit on its branch that is nowhere else', 'commits on its branch that are nowhere else')].filter(Boolean)
  return parts.length ? parts.join(' and ') : 'nothing that is not saved elsewhere'
}

/**
 * The separate copies of projects that Celeste has made for Develop sessions, which stay on disk until someone removes them.
 * Removing one deletes its folder and its branch, so what would be lost is said first.
 */
export function SeparateCopies() {
  const pushToast = useUi((s) => s.pushToast)
  const [copies, setCopies] = useState<WorktreeInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<WorktreeInfo | null>(null)

  const load = useCallback(() => {
    setError(null)
    core.call('project.worktrees').then(setCopies, (err: unknown) => setError(err instanceof Error ? err.message : 'Could not look for separate copies.'))
  }, [])
  useEffect(load, [load])

  const remove = async (w: WorktreeInfo) => {
    setAsking(null)
    try {
      await core.call('project.removeWorktree', w.path)
      pushToast({ text: `Removed the copy on ${w.branch}.` })
    } catch (err) {
      pushToast({ text: err instanceof Error ? err.message : 'Could not remove that copy.' })
    }
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] text-ink">Separate copies of projects</div>
          <div className="text-[13px] text-ink-muted">Develop sessions that work in a copy leave it here, on its own branch in your project, until you remove it.</div>
        </div>
        <IconButton label="Look again" size="sm" onClick={load}>
          <RefreshCw className="h-[15px] w-[15px]" />
        </IconButton>
      </div>

      {copies === null && !error && (
        <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ink-muted">
          <Spinner className="h-3.5 w-3.5" /> Looking…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      )}
      {copies?.length === 0 && <p className="mt-3 text-[13px] text-ink-faint">None. They appear when you start a Develop session with “Separate copy” switched on.</p>}
      {copies && copies.length > 0 && (
        <ul aria-label="Separate copies" className="mt-3 divide-y divide-edge/70 rounded-xl border border-edge">
          {copies.map((w) => (
            <li key={w.path} className="flex items-center gap-3 px-4 py-3">
              <GitBranch className="h-4 w-4 shrink-0 text-ink-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px] text-ink" title={w.path}>
                  {w.branch}
                </div>
                <div className="truncate text-[12.5px] text-ink-muted">
                  {w.session ? `Session: ${w.session.title}` : 'No session uses it any more'}
                  {' · '}
                  {w.changed + w.ahead > 0 ? `Not saved elsewhere: ${lost(w)}` : 'Everything in it is saved elsewhere'}
                </div>
              </div>
              <Button variant="danger" size="sm" aria-label={`Remove the copy on ${w.branch}`} onClick={() => setAsking(w)}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={asking !== null}
        title="Remove this separate copy?"
        confirmLabel="Remove the copy"
        onCancel={() => setAsking(null)}
        onConfirm={() => asking && void remove(asking)}
      >
        {asking && (
          <>
            This deletes the folder and the branch <span className="font-mono text-ink">{asking.branch}</span>. You would lose {lost(asking)}.
            {asking.session && ' The session that works in it will have no folder any more.'} Your own project folder is not touched.
          </>
        )}
      </ConfirmDialog>
    </div>
  )
}
