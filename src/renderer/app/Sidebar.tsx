import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Code,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  PanelLeft,
  Pencil,
  Plus,
  Settings,
  Trash2,
  Workflow
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
import { UsageStrip } from './UsageStrip'
import { useUi } from '@/stores/ui'
import { useWorkflows } from '@/stores/workflows'

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

/** A small dot that breathes while an assistant is working in a session. It stands still for people who ask for less motion. */
function WorkingDot() {
  return (
    <span className="relative flex h-2 w-2 shrink-0 group-hover:hidden" data-working aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
    </span>
  )
}

const GLIDE = { duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
const reduceMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Where each session row sat before a pin changed, so the list can glide rows to their new places. */
let rowSnapshot: Map<string, DOMRect> | null = null

function togglePin(id: string, pinned: boolean) {
  if (!useSessions.getState().sessions[id]) return
  const rows = new Map<string, DOMRect>()
  document.querySelectorAll<HTMLElement>('[data-session-row]').forEach((el) => {
    if (el.dataset.sessionRow) rows.set(el.dataset.sessionRow, el.getBoundingClientRect())
  })
  rowSnapshot = rows
  useSessions.getState().pin(id, pinned)
}

const SessionRow = memo(function SessionRow({ session, active, nested = false }: { session: Session; active: boolean; /** A helper, listed under the chat that started it: indented and smaller, and it can only be deleted. */ nested?: boolean }) {
  const open = useSessions((s) => s.open)
  const setMode = useUi((s) => s.setMode)
  const remove = useSessions((s) => s.remove)
  const rename = useSessions((s) => s.rename)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const pinned = session.pinnedAt != null
  const Icon = session.mode === 'develop' ? Code : MessageSquare
  const waiting = needsYou(session)
  const working = session.status === 'working'
  const stamp = sameDay(session.updatedAt, Date.now()) ? formatTime(session.updatedAt) : formatDay(session.updatedAt)

  return (
    <div data-session-row={session.id} data-helper-row={nested ? '' : undefined} className={cn('group relative', nested && 'ml-5')}>
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
              'flex shrink-0 items-center justify-center rounded-md border',
              nested ? 'h-6 w-6' : 'h-7 w-7',
              active ? 'border-accent-edge bg-accent-soft text-accent-text' : 'border-edge text-ink-muted'
            )}
          >
            {nested ? <Bot className="h-3 w-3" /> : <Icon className="h-3.5 w-3.5" />}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn('min-w-0 truncate text-ink', nested ? 'text-[12px]' : 'text-[13px]')}>{session.title}</span>
              {pinned && <Pin role="img" aria-label="Pinned" className="h-3 w-3 shrink-0 text-ink-faint" />}
            </span>
            <span className="block text-[11px] text-ink-faint">
              {waiting ? <span className="text-accent-text">Needs you</span> : working ? <span className="text-accent-text">Working…</span> : stamp}
            </span>
          </span>
          {waiting && <span className="h-2 w-2 shrink-0 rounded-full bg-accent group-hover:hidden" aria-hidden />}
          {working && <WorkingDot />}
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
            {/* A helper is pinned with its chat, and named by the assistant that started it. */}
            {!nested && (
              <>
                <Menu.Item onSelect={() => togglePin(session.id, !pinned)}>
                  {pinned ? <PinOff className="h-4 w-4 text-ink-muted" /> : <Pin className="h-4 w-4 text-ink-muted" />}
                  {pinned ? 'Unpin' : 'Pin'}
                </Menu.Item>
                <Menu.Item
                  onSelect={() => {
                    setDraft(session.title)
                    setEditing(true)
                  }}
                >
                  <Pencil className="h-4 w-4 text-ink-muted" /> Rename
                </Menu.Item>
              </>
            )}
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
})

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

/** Under a chat: its helpers (and its second moon), folded behind "N helpers" unless one is working or waiting. */
function HelperRows({ helpers, moonId, activeId, open, onToggle }: { helpers: Session[] | undefined; moonId: string | undefined; activeId: string | null | undefined; open: boolean; onToggle: (open: boolean) => void }) {
  if (!helpers?.length) return null
  const moon = helpers.some((h) => h.id === moonId)
  const others = helpers.length - (moon ? 1 : 0)
  const label = [moon ? 'Second moon' : '', others ? `${others} ${others === 1 ? 'helper' : 'helpers'}` : ''].filter(Boolean).join(', ')
  const busy = helpers.filter((h) => h.status !== 'idle').length
  return (
    <div className="mb-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="ml-5 flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-ink-faint hover:bg-hover hover:text-ink-muted"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {label}
        {busy > 0 && <span className="text-accent-text">· {busy} working</span>}
      </button>
      {open && helpers.map((h) => <SessionRow key={h.id} session={h} active={h.id === activeId} nested />)}
    </div>
  )
}

function ChatList({ mode, query, limit }: { mode: SessionMode; query: string; limit: number }) {
  const sessions = useSessions((s) => s.sessions)
  const activeId = useSessions((s) => s.active[mode])
  const [expanded, setExpanded] = useState(false)
  const pinnedLabel = useRef<HTMLDivElement>(null)
  const hadPinned = useRef<boolean | null>(null)

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    return Object.values(sessions)
      .filter((s) => s.mode === mode && (!q || s.title.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, mode, query])

  // A helper is listed under the chat that started it, not among the chats. One whose chat is not in the list (not found, or hidden by the
  // search) is listed on its own.
  const { list, helpersOf } = useMemo(() => {
    const here = new Set(matching.map((s) => s.id))
    const by = new Map<string, Session[]>()
    const top: Session[] = []
    for (const s of matching) {
      if (s.parentId && here.has(s.parentId)) by.set(s.parentId, [...(by.get(s.parentId) ?? []), s])
      else top.push(s)
    }
    for (const group of by.values()) group.sort((a, b) => a.createdAt - b.createdAt)
    return { list: top, helpersOf: by }
  }, [matching])
  // The helpers a chat has are folded behind a line, open by themselves while one works or waits (or is the one being read), and remembered
  // for each chat while the window is open.
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const activeParent = useSessions((s) => (activeId ? s.sessions[activeId]?.parentId : undefined))
  const row = (s: Session) => (
    <Fragment key={s.id}>
      <SessionRow session={s} active={s.id === activeId} />
      <HelperRows
        helpers={helpersOf.get(s.id)}
        moonId={s.moons?.childId}
        activeId={activeId}
        open={folds[s.id] ?? (activeParent === s.id || (helpersOf.get(s.id) ?? []).some((h) => h.status !== 'idle'))}
        onToggle={(open) => setFolds((f) => ({ ...f, [s.id]: open }))}
      />
    </Fragment>
  )

  // Pinned sessions float above the rest, newest pin first. They are never cut off by the show-more limit.
  const pinned = useMemo(
    () => list.filter((s) => s.pinnedAt != null).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    [list]
  )
  const rest = useMemo(() => list.filter((s) => s.pinnedAt == null), [list])

  useLayoutEffect(() => {
    const has = pinned.length > 0
    // The first render only records the starting state, so a list that opens with pins does not animate.
    const firstPin = hadPinned.current === false && has
    hadPinned.current = has
    const moving = rowSnapshot
    rowSnapshot = null
    if (reduceMotion()) return
    if (firstPin && pinnedLabel.current) {
      pinnedLabel.current.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], GLIDE)
    }
    if (!moving) return
    document.querySelectorAll<HTMLElement>('[data-session-row]').forEach((el) => {
      const from = el.dataset.sessionRow ? moving.get(el.dataset.sessionRow) : undefined
      if (!from) return
      const dy = from.top - el.getBoundingClientRect().top
      if (Math.abs(dy) < 1) return
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], GLIDE)
    })
  })

  if (list.length === 0) {
    return <div className="px-3 py-6 text-center text-[13px] text-ink-faint">{query ? 'No matches' : 'Nothing here yet'}</div>
  }

  const visible = expanded || query ? rest : rest.slice(0, limit)
  const showMore = rest.length > limit && !query && <ShowMore open={expanded} onToggle={() => setExpanded((v) => !v)} />

  const pinnedSection = pinned.length > 0 && (
    <section className="mb-2">
      <div ref={pinnedLabel}>
        <SectionLabel className="pt-2 pb-1">Pinned</SectionLabel>
      </div>
      {pinned.map(row)}
    </section>
  )

  if (mode === 'develop') {
    // Develop groups sessions by project folder.
    const byProject = new Map<string, Session[]>()
    for (const s of visible) {
      const key = s.cwd ?? 'No project'
      byProject.set(key, [...(byProject.get(key) ?? []), s])
    }
    return (
      <>
        {pinnedSection}
        {[...byProject.entries()].map(([cwd, items]) => (
          <section key={cwd} className="mb-2">
            <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-[13px] font-medium text-ink-muted" title={cwd}>
              <Folder className="h-4 w-4 shrink-0" />
              <span className="truncate">{basename(cwd)}</span>
            </div>
            {items.map(row)}
          </section>
        ))}
        {showMore}
      </>
    )
  }

  return (
    <>
      {pinnedSection}
      {groupByDay(visible).map((g) => (
        <section key={g.label} className="mb-2">
          <SectionLabel className="pt-2 pb-1">{g.label}</SectionLabel>
          {g.items.map(row)}
        </section>
      ))}
      {showMore}
    </>
  )
}

/** On the Workflows tab, under the chats: the person's workflows, with a way to make one. */
function WorkflowsSection() {
  const list = useWorkflows((s) => s.list)
  const openId = useWorkflows((s) => s.draft?.id)
  const open = useWorkflows((s) => s.open)
  const create = useWorkflows((s) => s.newWorkflow)
  const [query, setQuery] = useState('')
  const shown = list.filter((w) => !query.trim() || w.name.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <section aria-label="Workflows" className="mt-2 flex min-h-0 flex-1 flex-col border-t border-edge pt-2">
      <SectionLabel className="pb-1.5">Workflows</SectionLabel>
      <Button variant="secondary" className="h-10 justify-start gap-2.5 px-3.5" onClick={create}>
        <Plus className="h-[18px] w-[18px]" /> New workflow
      </Button>
      <SearchInput value={query} onChange={setQuery} placeholder="Search workflows…" className="mt-2 h-10" />
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1">
        <SectionLabel className="pt-2 pb-1">My workflows</SectionLabel>
        {shown.length === 0 && <div className="px-3 py-4 text-center text-[13px] text-ink-faint">{query ? 'No matches' : 'None yet'}</div>}
        {shown.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => void open(w.id)}
            aria-current={w.id === openId ? 'true' : undefined}
            className={cn('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors hover:bg-hover', w.id === openId ? 'bg-select text-ink' : 'text-ink-soft')}
          >
            <Workflow className="h-4 w-4 shrink-0 text-ink-muted" />
            <span className="truncate">{w.name}</span>
          </button>
        ))}
      </div>
    </section>
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
  // On the Workflows tab the list above is of chats, and the workflows are under it.
  const sessionMode: SessionMode = mode === 'develop' ? 'develop' : 'chat'
  const setMode = useUi((s) => s.setMode)

  const startNew = () => {
    if (mode === 'workflows') setMode('chat')
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
        <Button variant="secondary" className="h-10 min-w-0 flex-1 shrink justify-start gap-2.5 overflow-hidden px-3.5" onClick={startNew}>
          <Plus className="h-[18px] w-[18px] shrink-0" />
          <span className="truncate">{sessionMode === 'develop' ? 'New session' : 'New chat'}</span>
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

      <div className={cn('mt-1 min-h-0 overflow-y-auto pr-1', mode === 'workflows' ? 'max-h-[36%] shrink-0' : 'flex-1')}>
        <ChatList mode={sessionMode} query={query} limit={mode === 'workflows' ? 3 : 6} />
      </div>
      {mode === 'workflows' && <WorkflowsSection />}

      <UsageStrip />

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
