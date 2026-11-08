import { useEffect, useMemo, useState } from 'react'
import { Check, FilePlus, FileText, FileX, X } from 'lucide-react'
import type { FileDiff } from '@shared/agent'
import type { CheckpointReview } from '@shared/api'
import { Modal } from '@/components/Dialog'
import { Button, IconButton, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { basename } from '@/lib/format'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { DiffLines } from './DiffView'

const ICON = { added: FilePlus, deleted: FileX, modified: FileText } as const
const TONE = { added: 'text-success', deleted: 'text-danger', modified: 'text-ink-muted' } as const
const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/**
 * A screen of its own for reviewing what the agent changed, taken from the saved copies of the folder (so it includes what
 * commands changed, not only what the agent said it edited). Pick the whole session or one message's turn, read each file,
 * mark it viewed, or put a file back as it was.
 */
export function ReviewDialog({
  sessionId,
  scope: first,
  file: firstFile,
  onClose
}: {
  sessionId: string
  /** 'all', or the checkpoint of the message to look at. */
  scope: 'all' | string
  /** The file to have selected when it opens. */
  file?: string
  onClose: () => void
}) {
  const session = useSessions((s) => s.sessions[sessionId])
  const review = useSessions((s) => s.review)
  const discardFiles = useSessions((s) => s.discardFiles)
  const toast = useUi((s) => s.pushToast)

  /** The messages that have a checkpoint, oldest first, each reaching from its own checkpoint to the next one (the last, to now). */
  const turns = useMemo(() => {
    const saved = (session?.items ?? []).flatMap((it) => (it.kind === 'user' && it.checkpoint ? [{ id: it.checkpoint.id, label: it.text || it.attachments[0]?.name || 'Attachment' }] : []))
    return saved.map((t, i) => ({ ...t, n: i + 1, to: saved[i + 1]?.id ?? null }))
  }, [session?.items])

  const [scope, setScope] = useState<'all' | string>(first)
  const range = useMemo(() => {
    if (turns.length === 0) return null
    if (scope === 'all') return { from: (turns[0] as { id: string }).id, to: null as string | null }
    const turn = turns.find((t) => t.id === scope)
    return turn ? { from: turn.id, to: turn.to } : { from: (turns[0] as { id: string }).id, to: null }
  }, [turns, scope])

  const [data, setData] = useState<CheckpointReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<string | null>(firstFile ?? null)
  const [viewed, setViewed] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const from = range?.from
  const to = range?.to
  useEffect(() => {
    if (from === undefined || to === undefined) return
    let current = true
    setData(null)
    setError(null)
    review(sessionId, from, to).then(
      (r) => current && setData(r),
      (err: unknown) => current && setError(err instanceof Error ? err.message : 'Could not look at the folder.')
    )
    return () => {
      current = false
    }
  }, [review, sessionId, from, to, reload])

  // Another part of the session, another set of things to have looked at.
  useEffect(() => {
    setViewed(new Set())
    setConfirming(false)
  }, [scope])

  const files = data?.files ?? []
  const file: FileDiff | undefined = files.find((f) => f.path === selected) ?? files[0]
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const idle = session?.status === 'idle'

  const move = (by: number) => {
    if (files.length === 0) return
    const at = Math.max(0, files.findIndex((f) => f.path === file?.path))
    const next = files[Math.min(files.length - 1, Math.max(0, at + by))]
    if (next) {
      setSelected(next.path)
      setConfirming(false)
    }
  }
  const toggleViewed = (path: string) =>
    setViewed((v) => {
      const next = new Set(v)
      if (!next.delete(path)) next.add(path)
      return next
    })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || target?.closest('select, input, textarea')) return
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        move(1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        move(-1)
      } else if ((e.key === 'v' || e.key === 'V') && file) {
        e.preventDefault()
        toggleViewed(file.path)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const discard = async () => {
    if (!file || !range) return
    setBusy(true)
    const ok = await discardFiles(sessionId, range.from, [file.path])
    setBusy(false)
    setConfirming(false)
    if (ok) {
      toast({ text: `Put ${basename(file.path)} back. You can undo it in the conversation.` })
      setReload((n) => n + 1)
    }
  }

  const turn = turns.find((t) => t.id === scope)
  const laterTurnsExist = scope !== 'all' && turn?.to != null

  return (
    <Modal open onOpenChange={(open) => !open && !busy && onClose()} title="Review changes" description="The files the agent changed, with their lines." hideTitle className="h-[min(780px,86vh)] w-[min(1180px,calc(100vw-48px))]">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-edge/70 py-3 pr-3 pl-5">
          <h2 className="text-[16px] font-semibold text-ink">Review changes</h2>
          {turns.length > 0 && (
            <select
              aria-label="Changes shown"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value)
                setSelected(null)
              }}
              className="h-8 max-w-[360px] min-w-0 rounded-lg border border-edge-strong bg-field px-2 text-[13px] text-ink"
            >
              <option value="all">Everything in this session</option>
              {turns.map((t) => (
                <option key={t.id} value={t.id}>
                  Message {t.n}: {trim(t.label, 48)}
                </option>
              ))}
            </select>
          )}
          <span className="flex-1" />
          {data && files.length > 0 && (
            <span className="text-[13px] text-ink-muted">
              {files.length}
              {data.more ? `+${data.more}` : ''} {files.length === 1 && !data.more ? 'file' : 'files'} <span className="font-mono">
                <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
              </span>
              <span className="mx-2 text-ink-faint">·</span>
              Viewed {files.filter((f) => viewed.has(f.path)).length} of {files.length}
            </span>
          )}
          <IconButton label="Close review" onClick={onClose}>
            <X className="h-[18px] w-[18px]" />
          </IconButton>
        </header>

        {!range && <p className="m-6 text-[14px] text-ink-muted">Nothing has been saved yet. The folder is saved each time you send a message in Develop.</p>}
        {range && !data && !error && (
          <p role="status" className="m-6 flex items-center gap-2 text-[13px] text-ink-muted">
            <Spinner className="h-3.5 w-3.5" /> Looking at the folder…
          </p>
        )}
        {error && (
          <p role="alert" className="m-6 text-[13px] text-danger">
            {error}
          </p>
        )}
        {data && files.length === 0 && <p className="m-6 text-[14px] text-ink-muted">Nothing changed in this part of the session.</p>}

        {data && files.length > 0 && (
          <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
            <nav aria-label="Changed files" className="min-h-0 overflow-y-auto border-r border-edge/70 py-2">
              <ul>
                {files.map((f) => {
                  const Icon = ICON[f.status]
                  const dir = f.path.slice(0, f.path.length - basename(f.path).length)
                  const active = f.path === file?.path
                  const seen = viewed.has(f.path)
                  return (
                    <li key={f.path} className={cn('flex items-center gap-1 pr-2', active && 'bg-hover')}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => {
                          setSelected(f.path)
                          setConfirming(false)
                        }}
                        className={cn('flex min-w-0 flex-1 items-center gap-2 py-2 pl-4 text-left', seen && 'opacity-60')}
                      >
                        <Icon className={cn('h-4 w-4 shrink-0', TONE[f.status])} />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                          <span className="text-ink-faint">{dir}</span>
                          <span className="text-ink">{basename(f.path)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11.5px]">
                          <span className="text-success">+{f.added}</span> <span className="text-danger">−{f.removed}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={seen}
                        aria-label={`Mark ${f.path} as viewed`}
                        onClick={() => toggleViewed(f.path)}
                        className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded border', seen ? 'border-accent bg-accent text-accent-ink' : 'border-edge-strong text-transparent hover:text-ink-faint')}
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={3} />
                      </button>
                    </li>
                  )
                })}
              </ul>
              {data.more > 0 && <p className="px-4 py-2 text-xs text-ink-faint">and {data.more} more not listed here</p>}
            </nav>

            {file && (
              <section aria-label={`Changes to ${file.path}`} className="flex min-h-0 min-w-0 flex-col">
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge/70 px-4 py-2.5">
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{file.path}</span>
                  {file.status === 'added' && <span className="rounded bg-success/15 px-1.5 text-[11px] text-success">new</span>}
                  {file.status === 'deleted' && <span className="rounded bg-danger/15 px-1.5 text-[11px] text-danger">deleted</span>}
                  <Button variant="secondary" size="sm" onClick={() => toggleViewed(file.path)}>
                    <Check className="h-3.5 w-3.5" /> {viewed.has(file.path) ? 'Viewed' : 'Mark viewed'}
                  </Button>
                  {!confirming ? (
                    <Button variant="danger" size="sm" disabled={!idle || busy} title={idle ? undefined : 'Wait for the answer to finish, or stop it'} onClick={() => setConfirming(true)}>
                      Discard changes
                    </Button>
                  ) : (
                    <span className="flex items-center gap-2" role="group" aria-label="Discard this file’s changes?">
                      <span className="text-[13px] text-ink-muted">Put it back as it was before {scope === 'all' ? 'the session' : 'this message'}?</span>
                      <Button variant="danger" size="sm" disabled={busy} onClick={() => void discard()}>
                        {busy ? 'Putting back…' : 'Yes, put it back'}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                        No
                      </Button>
                    </span>
                  )}
                </div>
                {confirming && laterTurnsExist && <p className="shrink-0 px-4 py-1.5 text-xs text-ink-faint">Later messages changed files too: this puts the file back as it was before this message, whatever happened to it since.</p>}
                <div className="min-h-0 flex-1 overflow-auto">
                  <DiffLines diff={file} />
                </div>
              </section>
            )}
          </div>
        )}

        <footer className="shrink-0 border-t border-edge/70 px-5 py-2 text-xs text-ink-faint">
          ↑ ↓ or J K move between files · V marks a file viewed · Esc closes. Files your .gitignore ignores, and files over 25 MB, are not covered.
        </footer>
      </div>
    </Modal>
  )
}
