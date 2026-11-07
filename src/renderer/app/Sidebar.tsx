import { useMemo, useState } from 'react'
import {
  Activity,
  ChevronDown,
  Code,
  FileText,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Package,
  PanelLeft,
  Pencil,
  Plus,
  Settings,
  SquareTerminal,
  Trash2,
  Workflow
} from 'lucide-react'
import type { SessionMode } from '@shared/agent'
import { cn } from '@/lib/cn'
import { basename, formatDay, formatTime, sameDay } from '@/lib/format'
import { Menu } from '@/components/menu'
import { Button, IconButton, SearchInput, SectionLabel } from '@/components/ui'
import { useSessions, needsYou } from '@/stores/sessions'
import type { Session } from '@/stores/types'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { TEMPLATES, useWorkflows, type WorkflowSummary } from '@/stores/workflows'

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
  const remove = useSessions((s) => s.remove)
  const rename = useSessions((s) => s.rename)
  const setMode = useUi((s) => s.setMode)
  const [editing, setEditing] = useState(false)
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
            <Menu.Item onSelect={() => remove(session.id)} className="text-danger">
              <Trash2 className="h-4 w-4" /> Delete
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      )}
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

const WF_ICON = { workflow: Workflow, package: Package, activity: Activity, file: FileText, terminal: SquareTerminal }

function WorkflowRow({ wf, active }: { wf: WorkflowSummary; active: boolean }) {
  const open = useWorkflows((s) => s.open)
  const Icon = WF_ICON[wf.icon]
  return (
    <button
      type="button"
      aria-current={active ? 'true' : undefined}
      onClick={() => open(wf.id)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
        active ? 'bg-select text-ink' : 'text-ink hover:bg-hover'
      )}
    >
      <Icon className={cn('h-[18px] w-[18px] shrink-0', active ? 'text-accent-text' : 'text-ink-muted')} />
      <span className="truncate">{wf.name}</span>
    </button>
  )
}

function WorkflowsBlock() {
  const activeId = useWorkflows((s) => s.activeId)
  const all = useWorkflows((s) => s.mine)
  const createFrom = useWorkflows((s) => s.createFrom)
  const [query, setQuery] = useState('')
  const [showAllTemplates, setShowAllTemplates] = useState(false)
  const q = query.trim().toLowerCase()
  const mine = all.filter((w) => !q || w.name.toLowerCase().includes(q))
  const templates = TEMPLATES.filter((w) => !q || w.name.toLowerCase().includes(q))

  return (
    <div className="mt-3 border-t border-edge pt-3">
      <SectionLabel className="pb-2 text-[15px] font-semibold text-ink">Workflows</SectionLabel>
      <Button variant="secondary" className="mb-2 w-full justify-start" onClick={() => createFrom(null)}>
        <Plus className="h-4 w-4" /> New workflow
      </Button>
      <SearchInput value={query} onChange={setQuery} placeholder="Search workflows…" className="mb-2" />
      <SectionLabel className="pt-1 pb-1">My workflows</SectionLabel>
      {mine.map((w) => (
        <WorkflowRow key={w.id} wf={w} active={w.id === activeId} />
      ))}
      <SectionLabel className="pt-3 pb-1">Templates</SectionLabel>
      {(showAllTemplates || q ? templates : templates.slice(0, 5)).map((w) => (
        <WorkflowRow key={w.id} wf={w} active={w.id === activeId} />
      ))}
      {templates.length > 5 && !q && <ShowMore open={showAllTemplates} onToggle={() => setShowAllTemplates((v) => !v)} />}
    </div>
  )
}

export function Sidebar() {
  const mode = useUi((s) => s.mode)
  const setMode = useUi((s) => s.setMode)
  const openSettings = useUi((s) => s.openSettings)
  const settingsOpen = useUi((s) => s.settingsOpen)
  const set = useSettings((s) => s.set)
  const [query, setQuery] = useState('')
  const sessionMode: SessionMode = mode === 'develop' ? 'develop' : 'chat'

  const startNew = () => {
    if (mode === 'workflows') setMode('chat')
    useSessions.getState().home(sessionMode)
    useUi.getState().resetDraft()
  }

  return (
    <aside aria-label="Sessions" className="flex w-[232px] shrink-0 flex-col pb-1">
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
        <ChatList mode={sessionMode} query={query} limit={mode === 'workflows' ? 3 : 6} />
        {mode === 'workflows' && <WorkflowsBlock />}
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
