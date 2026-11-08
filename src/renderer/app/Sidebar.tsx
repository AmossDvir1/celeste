import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import {
  ChevronDown,
  Code,
  Folder,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Settings,
  Trash2
} from 'lucide-react'
import type { SessionMode } from '@shared/agent'
import { SIDEBAR_WIDTH } from '@shared/defaults'
import { cn } from '@/lib/cn'
import { basename, formatDay, formatTime, sameDay } from '@/lib/format'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Menu } from '@/components/menu'
import { Button, IconButton, SearchInput, SectionLabel } from '@/components/ui'
import { useSessions, needsYou } from '@/stores/sessions'
import type { Session } from '@/stores/types'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'

const DAY = 86_400_000

function groupByDay(list: Session[]): { label: string; items: Session[] }[] {
  const now = Date.now()
  const groups: Record<string, Session[]> = { Today: [], Yesterday: [], Earlier: [] }
  for (const s of list) {
    if (sameDay(s.updatedAt, now)) groups.Today.push(s)
    else if (sameDay(s.updatedAt, now - DAY)) groups.Yesterday.push(s)
    else groups.Earlier.push(s)
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([label, items]) => ({ label, items }))
}

function SessionRow({ session, active }: { session: Session; active: boolean }) {
  const open = useSessions((s) => s.open)
  const setMode = useUi((s) => s.setMode)
  const remove = useSessions((s) => s.remove)
  const rename = useSessions((s) => s.rename)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const Icon = session.mode === 'develop' ? Code : MessageSquare
  const waiting = needsYou(session)
  const stamp = sameDay(session.updatedAt, Date.now()) ? formatTime(session.updatedAt) : formatDay(session.updatedAt)

  return (
    <div className="group relative">
      {editing ? (
        <form
          className="px-1 py-0.5"
          onSubmit={(e) => {
            e.preventDefault()
            rename(session.id, draft)
            setEditing(false)
          }}
        >
          <input
            autoFocus
            value={draft}
            aria-label="Session name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            className="h-9 w-full rounded-lg border border-accent-edge bg-field px-2.5 text-[13px] text-ink outline-none"
          />
        </form>
      ) : (
        <button
          type="button"
          aria-current={active ? 'true' : undefined}
          onClick={() => {
            setMode(session.mode)
            open(session.id)
          }}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
            // The menu button sits over the end of the row when it shows, so the title stops short of it instead of running under it.
            'group-focus-within:pr-10 group-hover:pr-10 group-has-[[data-state=open]]:pr-10',
            active ? 'bg-select' : 'hover:bg-hover'
          )}
        >
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
              active ? 'border-accent-edge bg-accent-soft text-accent-text' : 'border-edge text-ink-muted'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className={cn('block truncate text-[13px]', active ? 'text-ink' : 'text-ink')}>{session.title}</span>
            <span className="block text-[11px] text-ink-faint">{waiting ? <span className="text-accent-text">Needs you</span> : stamp}</span>
          </span>
          {waiting && <span className="h-2 w-2 shrink-0 rounded-full bg-accent group-hover:hidden" aria-hidden />}
        </button>
      )}

      {!editing && (
        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${session.title}`}
              className="absolute top-1/2 right-1.5 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-muted hover:bg-hover hover:text-ink group-focus-within:flex group-hover:flex data-[state=open]:flex"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </Menu.Trigger>
          <Menu.Content align="start" className="w-[170px]">
            <Menu.Item
              onSelect={() => {
                setDraft(session.title)
                setEditing(true)
              }}
            >
              <Pencil className="h-4 w-4 text-ink-muted" /> Rename
            </Menu.Item>
            <Menu.Item onSelect={() => setConfirming(true)} className="text-danger">
              <Trash2 className="h-4 w-4" /> Delete
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Delete “${session.title}”?`}
        confirmLabel="Delete"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          remove(session.id)
        }}
      >
        This removes the {session.mode === 'develop' ? 'session' : 'chat'} from this computer.
        {session.status !== 'idle' && ' It is still working, and deleting it stops it.'} Your files are not touched, and you can undo it for a few seconds afterwards.
      </ConfirmDialog>
    </div>
  )
}

function ShowMore({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-ink-muted hover:bg-hover hover:text-ink"
    >
      <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      {open ? 'Show less' : 'Show more'}
    </button>
  )
}

function ChatList({ mode, query, limit }: { mode: SessionMode; query: string; limit: number }) {
  const sessions = useSessions((s) => s.sessions)
  const activeId = useSessions((s) => s.active[mode])
  const [expanded, setExpanded] = useState(false)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return Object.values(sessions)
      .filter((s) => s.mode === mode && (!q || s.title.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, mode, query])

  if (list.length === 0) {
    return <div className="px-3 py-6 text-center text-[13px] text-ink-faint">{query ? 'No matches' : 'Nothing here yet'}</div>
  }

  const visible = expanded || query ? list : list.slice(0, limit)

  if (mode === 'develop') {
    // Develop groups sessions by project folder.
    const byProject = new Map<string, Session[]>()
    for (const s of visible) {
      const key = s.cwd ?? 'No project'
      byProject.set(key, [...(byProject.get(key) ?? []), s])
    }
    return (
      <>
        {[...byProject.entries()].map(([cwd, items]) => (
          <section key={cwd} className="mb-2">
            <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-[13px] font-medium text-ink-muted" title={cwd}>
              <Folder className="h-4 w-4 shrink-0" />
              <span className="truncate">{basename(cwd)}</span>
            </div>
            {items.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === activeId} />
            ))}
          </section>
        ))}
        {list.length > limit && !query && <ShowMore open={expanded} onToggle={() => setExpanded((v) => !v)} />}
      </>
    )
  }

  return (
    <>
      {groupByDay(visible).map((g) => (
        <section key={g.label} className="mb-2">
          <SectionLabel className="pt-2 pb-1">{g.label}</SectionLabel>
          {g.items.map((s) => (
            <SessionRow key={s.id} session={s} active={s.id === activeId} />
          ))}
        </section>
      ))}
      {list.length > limit && !query && <ShowMore open={expanded} onToggle={() => setExpanded((v) => !v)} />}
    </>
  )
}

const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)))

/** The edge of the session list: drag it, use the arrow keys, or double-click to go back to the usual width. */
function ResizeHandle({ width, onLive, onCommit }: { width: number; onLive: (w: number) => void; onCommit: (w: number) => void }) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    document.body.style.userSelect = ''
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    onCommit(d.last)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === 'ArrowLeft' ? width - 16 : e.key === 'ArrowRight' ? width + 16 : e.key === 'Home' ? SIDEBAR_WIDTH.min : e.key === 'End' ? SIDEBAR_WIDTH.max : e.key === 'Enter' ? SIDEBAR_WIDTH.default : undefined
    if (next === undefined) return
    e.preventDefault()
    onCommit(clampWidth(next))
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click for the usual width."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        document.body.style.userSelect = 'none'
        drag.current = { x: e.clientX, width, last: width }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        d.last = clampWidth(d.width + e.clientX - d.x)
        onLive(d.last)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onCommit(SIDEBAR_WIDTH.default)}
      onKeyDown={onKeyDown}
      // The list and the page are 12 pixels apart: the handle is 20 wide, centred in that gap, so the line is in the middle of it.
      className="group/handle absolute inset-y-0 -right-4 z-20 flex w-5 cursor-col-resize justify-center focus-visible:outline-offset-0"
    >
      <span className="h-full w-px rounded-full bg-transparent transition-colors group-hover/handle:bg-accent-edge group-focus-visible/handle:bg-accent group-active/handle:bg-accent" />
    </div>
  )
}

export function Sidebar() {
  const mode = useUi((s) => s.mode)
  const openSettings = useUi((s) => s.openSettings)
  const settingsOpen = useUi((s) => s.settingsOpen)
  const set = useSettings((s) => s.set)
  const saved = useSettings((s) => s.sidebarWidth)
  // While it is being dragged the width follows the pointer at once; it is saved when the drag ends.
  const [live, setLive] = useState<number | null>(null)
  const width = live ?? saved
  const [query, setQuery] = useState('')
  const sessionMode: SessionMode = mode

  const startNew = () => {
    useSessions.getState().home(sessionMode)
    useUi.getState().resetDraft()
  }

  return (
    <aside aria-label="Sessions" style={{ width }} className="relative flex shrink-0 flex-col pb-1">
      <ResizeHandle
        width={width}
        onLive={setLive}
        onCommit={(w) => {
          set({ sidebarWidth: w })
          setLive(null)
        }}
      />
      <div className="flex gap-2 px-0.5">
        <Button variant="secondary" className="h-10 flex-1 justify-start gap-2.5 px-3.5" onClick={startNew}>
          <Plus className="h-[18px] w-[18px]" />
          {sessionMode === 'develop' ? 'New session' : 'New chat'}
        </Button>
        <IconButton label="Hide sidebar (Ctrl+B)" className="h-10 w-10 border border-edge-strong" onClick={() => set({ sidebarCollapsed: true })}>
          <PanelLeft className="h-[18px] w-[18px]" />
        </IconButton>
      </div>

      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={sessionMode === 'develop' ? 'Search sessions…' : 'Search chats…'}
        className="mt-2.5 h-10"
      />

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1">
        <ChatList mode={sessionMode} query={query} limit={6} />
      </div>

      <div className="mt-2 border-t border-edge pt-2">
        <button
          type="button"
          onClick={() => openSettings()}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          className={cn(
            'flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[14px] transition-colors hover:bg-hover hover:text-ink',
            settingsOpen ? 'bg-select text-ink' : 'text-ink-muted'
          )}
        >
          <Settings className="h-[19px] w-[19px]" />
          Settings
        </button>
      </div>
    </aside>
  )
}
