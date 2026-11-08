import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { FileListing, FilePreview } from '@shared/api'
import { core } from '@/api'
import { PanelCard } from '@/components/PanelCard'
import { Button, IconButton, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { basename } from '@/lib/format'
import { useChanges } from '@/stores/changes'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { ReviewDialog } from './ReviewDialog'

type Listing = { state: 'loading'; data?: FileListing } | { state: 'ok'; data: FileListing } | { state: 'error'; message: string }

/** At most this many lines of a file are drawn; a longer one says how many there are. */
const MAX_LINES = 4000
/** A folder whose contents are rebuilt by a tool, so it is shown but faded. */
const FADED = new Set(['node_modules'])

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`)

/**
 * The project folder of the open Develop session, as a tree that opens folder by folder, with a marker on what the agent
 * changed. A click on a file previews it. The files shown are the real ones on disk, read when you open a folder and again when
 * an answer ends.
 */
export function FilesPanel() {
  const setRight = useUi((s) => s.setRight)
  const session = useSessions((s) => (s.active.develop ? s.sessions[s.active.develop] : undefined))
  const sessionId = session?.id
  const status = session?.status
  // What differs now from before the first message (the net result, kept up to date by the conversation view).
  const net = useChanges((s) => (sessionId ? s.net[sessionId] : undefined))
  const changes = useMemo(() => new Map((net?.files ?? []).map((f) => [f.path, f.status] as const)), [net])

  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | 'loading' | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const tree = useRef<HTMLDivElement>(null)

  const load = useCallback(
    (path: string) => {
      if (!sessionId) return
      setListings((l) => ({ ...l, [path]: { state: 'loading', data: l[path]?.state === 'ok' ? (l[path] as { data: FileListing }).data : undefined } }))
      core.call('sessions.listFiles', sessionId, path).then(
        (data) => setListings((l) => ({ ...l, [path]: { state: 'ok', data } })),
        (err: unknown) => setListings((l) => ({ ...l, [path]: { state: 'error', message: err instanceof Error ? err.message : 'Could not read this folder.' } }))
      )
    },
    [sessionId]
  )

  const show = useCallback(
    (path: string) => {
      if (!sessionId) return
      setPreview('loading')
      core.call('sessions.readFile', sessionId, path).then(
        (p) => setPreview(p),
        () => setPreview({ kind: 'missing' })
      )
    },
    [sessionId]
  )

  const refresh = useCallback(() => {
    load('')
    for (const path of open) load(path)
    if (viewing) show(viewing)
  }, [load, open, show, viewing])

  // The top level when it opens.
  useEffect(() => {
    setListings({})
    setOpen(new Set())
    setViewing(null)
    load('')
  }, [sessionId, load])

  // What the agent did shows up when its answer ends.
  const was = useRef(status)
  useEffect(() => {
    if (was.current !== 'idle' && status === 'idle') refresh()
    was.current = status
  }, [status, refresh])

  if (!session) return null

  const toggle = (path: string) => {
    const next = new Set(open)
    if (next.delete(path)) {
      setOpen(next)
      return
    }
    next.add(path)
    setOpen(next)
    if (listings[path]?.state !== 'ok') load(path)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(tree.current?.querySelectorAll<HTMLElement>('[role=treeitem]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const current = items[at]
    if (e.key === 'ArrowDown') items[Math.min(items.length - 1, at + 1)]?.focus()
    else if (e.key === 'ArrowUp') items[Math.max(0, at - 1)]?.focus()
    else if (e.key === 'ArrowRight' && current?.getAttribute('aria-expanded') === 'false') current.click()
    else if (e.key === 'ArrowLeft' && current?.getAttribute('aria-expanded') === 'true') current.click()
    else return
    e.preventDefault()
  }

  const rows = (dir: string, depth: number): React.ReactNode[] => {
    const listing = listings[dir]
    if (!listing) return []
    if (listing.state === 'error')
      return [
        <div key={`${dir}:error`} role="alert" style={{ paddingLeft: 12 + depth * 16 }} className="py-1 text-[12.5px] text-danger">
          {listing.message}
        </div>
      ]
    const out: React.ReactNode[] = []
    for (const entry of listing.data?.entries ?? []) {
      const path = join(dir, entry.name)
      const isDir = entry.kind === 'dir'
      const expanded = isDir && open.has(path)
      const change = isDir ? undefined : changes.get(path)
      const inside = isDir && [...changes.keys()].some((p) => p.startsWith(`${path}/`))
      const Icon = isDir ? (expanded ? FolderOpen : Folder) : FileText
      out.push(
        <div
          key={path}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDir ? expanded : undefined}
          aria-selected={viewing === path}
          tabIndex={0}
          title={path}
          onClick={() => (isDir ? toggle(path) : (setViewing(path), show(path)))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.currentTarget.click()
            }
          }}
          style={{ paddingLeft: 8 + depth * 16 }}
          className={cn('flex h-8 cursor-pointer items-center gap-1.5 pr-3 text-[13px] outline-none hover:bg-hover focus-visible:bg-hover', FADED.has(entry.name) && 'opacity-50')}
        >
          {isDir ? <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform', expanded && 'rotate-90')} /> : <span className="w-3.5 shrink-0" />}
          <Icon className={cn('h-4 w-4 shrink-0', isDir ? 'text-accent-text' : 'text-ink-muted')} />
          <span className="min-w-0 flex-1 truncate text-ink">{entry.name}</span>
          {change && (
            <span aria-label={change === 'added' ? 'new' : 'changed'} className={cn('shrink-0 font-mono text-[11px]', change === 'added' ? 'text-success' : 'text-accent-text')}>
              {change === 'added' ? 'A' : 'M'}
            </span>
          )}
          {inside && !expanded && <span aria-label="contains changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </div>
      )
      if (expanded) {
        const child = listings[path]
        if (!child || (child.state === 'loading' && !child.data)) {
          out.push(
            <div key={`${path}:loading`} style={{ paddingLeft: 30 + depth * 16 }} className="flex h-7 items-center gap-2 text-[12.5px] text-ink-faint">
              <Spinner className="h-3 w-3" /> Opening…
            </div>
          )
        } else out.push(...rows(path, depth + 1))
      }
    }
    if (listing.data && listing.data.entries.length === 0) {
      out.push(
        <div key={`${dir}:empty`} style={{ paddingLeft: 30 + depth * 16 }} className="h-7 text-[12.5px] text-ink-faint">
          Empty
        </div>
      )
    }
    if (listing.data && listing.data.more > 0) {
      out.push(
        <div key={`${dir}:more`} style={{ paddingLeft: 30 + depth * 16 }} className="py-1 text-[12.5px] text-ink-faint">
          and {listing.data.more} more not listed
        </div>
      )
    }
    return out
  }

  const root = listings['']
  const change = viewing ? changes.get(viewing) : undefined

  return (
    <PanelCard
      title={
        <span className="flex items-center gap-2">
          Files
          {session.cwd && <span className="truncate text-[13px] font-normal text-ink-muted">{basename(session.cwd)}</span>}
        </span>
      }
      onClose={() => setRight(null)}
      actions={
        <IconButton label="Refresh files" onClick={refresh}>
          <RefreshCw className="h-[16px] w-[16px]" />
        </IconButton>
      }
      className="h-full"
      bodyClassName=""
    >
      {reviewing && viewing && <ReviewDialog sessionId={session.id} scope="all" file={viewing} onClose={() => setReviewing(false)} />}
      {viewing ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-edge/70 px-2 py-2">
            <IconButton label="Back to the files" size="sm" onClick={() => setViewing(null)}>
              <ArrowLeft className="h-4 w-4" />
            </IconButton>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={viewing}>
              {viewing}
            </span>
            {change && (
              <Button variant="soft" size="sm" onClick={() => setReviewing(true)}>
                Show changes
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Preview preview={preview} />
          </div>
        </div>
      ) : (
        <div ref={tree} role="tree" aria-label="Project files" onKeyDown={onKeyDown} className="py-1">
          {!root || (root.state === 'loading' && !root.data) ? (
            <p role="status" className="flex items-center gap-2 px-4 py-3 text-[13px] text-ink-muted">
              <Spinner className="h-3.5 w-3.5" /> Reading the folder…
            </p>
          ) : (
            rows('', 0)
          )}
        </div>
      )}
    </PanelCard>
  )
}

function Preview({ preview }: { preview: FilePreview | 'loading' | null }) {
  if (preview === 'loading' || preview === null) {
    return (
      <p role="status" className="flex items-center gap-2 px-4 py-3 text-[13px] text-ink-muted">
        <Spinner className="h-3.5 w-3.5" /> Reading the file…
      </p>
    )
  }
  if (preview.kind === 'missing') return <p className="px-4 py-3 text-[13px] text-ink-muted">This file is not there any more.</p>
  if (preview.kind === 'binary') return <p className="px-4 py-3 text-[13px] text-ink-muted">This file is not text ({size(preview.size)}), so there is nothing to show.</p>
  if (preview.kind === 'large') return <p className="px-4 py-3 text-[13px] text-ink-muted">This file is {size(preview.size)}, which is too large to show here.</p>
  if (preview.lines === 0) return <p className="px-4 py-3 text-[13px] text-ink-muted">An empty file.</p>
  const lines = preview.text.split('\n')
  if (preview.text.endsWith('\n')) lines.pop()
  const shown = lines.slice(0, MAX_LINES)
  return (
    <div aria-label="File contents" className="selectable min-w-max py-2 font-mono text-[12.5px] leading-[1.65]">
      {shown.map((line, i) => (
        <div key={i} className="grid grid-cols-[48px_1fr]">
          <span className="pr-3 text-right text-ink-faint/70 select-none">{i + 1}</span>
          <span className="pr-4 whitespace-pre text-ink-muted">{line.replace(/\r$/, '')}</span>
        </div>
      ))}
      {lines.length > shown.length && <p className="px-4 pt-2 text-[12.5px] text-ink-faint">Showing the first {MAX_LINES.toLocaleString('en')} of {lines.length.toLocaleString('en')} lines.</p>}
    </div>
  )
}
