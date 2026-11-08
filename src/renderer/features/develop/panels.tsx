import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, FileDiff, RefreshCw, SquareTerminal, Undo2 } from 'lucide-react'
import type { FileDiff as FileDiffData } from '@shared/agent'
import { PanelCard } from '@/components/PanelCard'
import { Button, IconButton, Spinner } from '@/components/ui'
import { useChanges } from '@/stores/changes'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { DiffFile, DiffList } from './DiffView'
import { RevertDialog } from './RevertDialog'
import { ReviewDialog } from './ReviewDialog'

function useDevelopSession() {
  return useSessions((s) => {
    const id = s.active.develop
    return id ? s.sessions[id] : undefined
  })
}

/** What the agent said it edited, for a session that has no saved copies of the folder to look at instead. */
function reportedDiffs(items: NonNullable<ReturnType<typeof useDevelopSession>>['items']): FileDiffData[] {
  const byPath = new Map<string, FileDiffData>()
  for (const it of items) if (it.kind === 'tool') it.diff?.forEach((d) => byPath.set(d.path, d))
  return [...byPath.values()]
}

/** Put one file back: asks first, then does it. */
function DiscardButton({ path, onDiscard, disabled }: { path: string; onDiscard: () => Promise<void>; disabled: boolean }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!asking) {
    return (
      <Button variant="ghost" size="sm" disabled={disabled} aria-label={`Discard changes to ${path}`} title={disabled ? 'Wait for the answer to finish, or stop it' : 'Put this file back as it was'} onClick={() => setAsking(true)}>
        <Undo2 className="h-3.5 w-3.5" /> Discard
      </Button>
    )
  }
  return (
    <span role="group" aria-label={`Discard changes to ${path}?`} className="flex items-center gap-1">
      <Button
        variant="danger"
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void onDiscard().finally(() => {
            setBusy(false)
            setAsking(false)
          })
        }}
      >
        {busy ? 'Putting back…' : 'Put back'}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking(false)}>
        No
      </Button>
    </span>
  )
}

/**
 * Everything the session has changed in the project folder, as it is now: read from the saved copies of the folder, so it
 * includes what commands did, and a change that was undone (by the agent, or by a revert) is gone from it. Each file can be put
 * back, and everything can be reverted. A session that started before folders were saved shows what the agent reported instead.
 */
export function ChangesPanel() {
  const setRight = useUi((s) => s.setRight)
  const session = useDevelopSession()
  const id = session?.id
  const net = useChanges((s) => (id ? s.net[id] : undefined))
  const refreshNet = useChanges((s) => s.refresh)
  const review = useSessions((s) => s.review)
  const discardFiles = useSessions((s) => s.discardFiles)

  // Where the session began: how the folder was before its first message.
  const first = useMemo(() => {
    for (const it of session?.items ?? []) if (it.kind === 'user' && it.checkpoint) return it.checkpoint.id
    return undefined
  }, [session?.items])

  const [files, setFiles] = useState<FileDiffData[] | null>(null)
  const [more, setMore] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [reverting, setReverting] = useState(false)

  // The folder is looked at when the panel opens (once), and again whenever the net result is looked at again: when an answer
  // ends, after a revert or a discard, and when Refresh is pressed.
  useEffect(() => {
    if (!id || !first) return
    if (net === undefined) {
      void refreshNet(id)
      return
    }
    let current = true
    setError(null)
    review(id, first, null).then(
      (r) => {
        if (!current) return
        setFiles(r.files)
        setMore(r.more)
      },
      (err: unknown) => current && setError(err instanceof Error ? err.message : 'Could not look at the folder.')
    )
    return () => {
      current = false
    }
  }, [id, first, net, review, refreshNet])

  const legacy = useMemo(() => (first || !session ? [] : reportedDiffs(session.items)), [first, session])
  const shown = first ? files : legacy
  const added = shown?.reduce((n, d) => n + d.added, 0) ?? 0
  const removed = shown?.reduce((n, d) => n + d.removed, 0) ?? 0
  const idle = session?.status === 'idle'
  const loading = Boolean(first) && files === null && !error

  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          Changes
          {shown && shown.length > 0 && (
            <span className="font-mono text-[12px] font-normal">
              <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
            </span>
          )}
        </span>
      }
      onClose={() => setRight(null)}
      actions={
        id && first ? (
          <>
            <IconButton label="Refresh changes" size="sm" onClick={() => void refreshNet(id)}>
              <RefreshCw className="h-[15px] w-[15px]" />
            </IconButton>
            <Button variant="soft" size="sm" onClick={() => setReviewing(true)}>
              Review
            </Button>
            {shown && shown.length > 0 && (
              <Button variant="ghost" size="sm" disabled={!idle} title={idle ? 'Put the whole folder back as it was before this session' : 'Wait for the answer to finish, or stop it'} onClick={() => setReverting(true)}>
                Revert all
              </Button>
            )}
          </>
        ) : undefined
      }
      className="h-full"
      bodyClassName="p-3"
    >
      {reviewing && id && <ReviewDialog sessionId={id} scope="all" onClose={() => setReviewing(false)} />}
      {reverting && id && first && <RevertDialog sessionId={id} checkpointId={first} whole onClose={() => setReverting(false)} />}

      {!first && shown && shown.length > 0 && (
        <p className="mb-2 rounded-lg border border-edge bg-field px-3 py-2 text-xs text-ink-muted">
          This session began before Celeste saved the project folder, so this is what the agent reported editing, and it cannot be reverted. Messages you send from now on are saved and can be.
        </p>
      )}
      {session?.status !== 'idle' && first && <p className="mb-2 text-xs text-ink-faint">The list is read again when the answer ends.</p>}

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="flex items-center gap-2 px-1 py-2 text-[13px] text-ink-muted">
          <Spinner className="h-3.5 w-3.5" /> Looking at the folder…
        </p>
      )}
      {!loading && !error && (!shown || shown.length === 0) && (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <FileDiff className="h-8 w-8 text-ink-faint" />
          <div className="text-[14px] text-ink">No changes</div>
          <div className="text-[13px] text-ink-muted">{first ? 'The project folder is the same as before this session began.' : 'Files the agent edits show up here with a diff you can review.'}</div>
        </div>
      )}
      {shown &&
        shown.length > 0 &&
        (first ? (
          <div className="space-y-2">
            {shown.map((d) => (
              <DiffFile
                key={d.path}
                diff={d}
                actions={
                  <DiscardButton
                    path={d.path}
                    disabled={!idle}
                    onDiscard={async () => {
                      if (id) await discardFiles(id, first, [d.path])
                    }}
                  />
                }
              />
            ))}
            {more > 0 && <p className="px-1 text-xs text-ink-faint">and {more} more files. Open Review to see them.</p>}
          </div>
        ) : (
          <DiffList diffs={shown} />
        ))}
    </PanelCard>
  )
}

export function TerminalPanel() {
  const setRight = useUi((s) => s.setRight)
  const session = useDevelopSession()
  const ran = (session?.items ?? []).filter((i) => i.kind === 'tool' && i.tool === 'shell')
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  // The text of everything so far: a new command, or more output from one that is running, both move the end.
  const length = ran.reduce((n, t) => n + (t.kind === 'tool' ? (t.input?.length ?? t.title.length) + t.output.length : 0), ran.length)

  // It opens at the newest output and stays there while new output arrives, unless the reader scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [length, following, session?.id])

  const onScroll = () => {
    const el = scroller.current
    if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  return (
    <PanelCard title="Terminal" onClose={() => setRight(null)} className="h-full" bodyClassName="relative overflow-hidden bg-field">
      {ran.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <SquareTerminal className="h-8 w-8 text-ink-faint" />
          <div className="text-[14px] text-ink">No commands yet</div>
          <div className="text-[13px] text-ink-muted">Commands the agent runs show up here with their output.</div>
        </div>
      ) : (
        <>
          <div ref={scroller} onScroll={onScroll} aria-label="Terminal output" className="selectable h-full overflow-auto p-4 font-mono text-[12.5px] leading-[1.65] text-ink-muted">
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
          {!following && (
            <button
              type="button"
              onClick={() => setFollowing(true)}
              className="absolute right-4 bottom-4 flex h-8 items-center gap-1.5 rounded-full border border-edge-strong bg-panel px-3 text-[12.5px] text-ink shadow-pop hover:bg-raised"
            >
              <ArrowDown className="h-3.5 w-3.5" /> Jump to latest
            </button>
          )}
        </>
      )}
    </PanelCard>
  )
}
