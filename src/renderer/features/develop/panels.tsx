import { useMemo, useState } from 'react'
import { FileDiff, SquareTerminal } from 'lucide-react'
import type { FileDiff as FileDiffData } from '@shared/agent'
import { PanelCard } from '@/components/PanelCard'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { Button } from '@/components/ui'
import { DiffList } from './DiffView'
import { ReviewDialog } from './ReviewDialog'

function useDevelopSession() {
  return useSessions((s) => {
    const id = s.active.develop
    return id ? s.sessions[id] : undefined
  })
}

function allDiffs(items: NonNullable<ReturnType<typeof useDevelopSession>>['items']): FileDiffData[] {
  const byPath = new Map<string, FileDiffData>()
  for (const it of items) if (it.kind === 'tool') it.diff?.forEach((d) => byPath.set(d.path, d))
  return [...byPath.values()]
}

export function ChangesPanel() {
  const setRight = useUi((s) => s.setRight)
  const session = useDevelopSession()
  const diffs = useMemo(() => (session ? allDiffs(session.items) : []), [session])
  const [reviewing, setReviewing] = useState(false)
  // The review reads the saved copies of the folder, so it needs at least one.
  const canReview = session?.items.some((i) => i.kind === 'user' && i.checkpoint) ?? false
  const added = diffs.reduce((n, d) => n + d.added, 0)
  const removed = diffs.reduce((n, d) => n + d.removed, 0)

  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          Changes
          {diffs.length > 0 && (
            <span className="font-mono text-[12px] font-normal">
              <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
            </span>
          )}
        </span>
      }
      onClose={() => setRight(null)}
      actions={
        canReview && (
          <Button variant="soft" size="sm" onClick={() => setReviewing(true)}>
            Review
          </Button>
        )
      }
      className="h-full"
      bodyClassName="p-3"
    >
      {reviewing && session && <ReviewDialog sessionId={session.id} scope="all" onClose={() => setReviewing(false)} />}
      {diffs.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <FileDiff className="h-8 w-8 text-ink-faint" />
          <div className="text-[14px] text-ink">No changes yet</div>
          <div className="text-[13px] text-ink-muted">Files the agent edits show up here with a diff you can review.</div>
        </div>
      ) : (
        <DiffList diffs={diffs} />
      )}
    </PanelCard>
  )
}

export function TerminalPanel() {
  const setRight = useUi((s) => s.setRight)
  const session = useDevelopSession()
  const ran = (session?.items ?? []).filter((i) => i.kind === 'tool' && i.tool === 'shell')

  return (
    <PanelCard title="Terminal" onClose={() => setRight(null)} className="h-full" bodyClassName="bg-field">
      {ran.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <SquareTerminal className="h-8 w-8 text-ink-faint" />
          <div className="text-[14px] text-ink">No commands yet</div>
          <div className="text-[13px] text-ink-muted">Commands the agent runs show up here with their output.</div>
        </div>
      ) : (
        <div className="selectable p-4 font-mono text-[12.5px] leading-[1.65] text-ink-muted">
          {ran.map((t) =>
            t.kind === 'tool' ? (
              <div key={t.id} className="mb-3">
                <div>
                  <span className="text-accent-text">&gt;</span> <span className="text-ink">{t.input ?? t.title}</span>
                </div>
                <pre className="whitespace-pre-wrap">{t.output}</pre>
              </div>
            ) : null
          )}
        </div>
      )}
    </PanelCard>
  )
}
