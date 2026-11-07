import { useMemo, useState } from 'react'
import { Code, MessageSquare, Search, Workflow } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Modal } from '@/components/Dialog'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { TEMPLATES, useWorkflows } from '@/stores/workflows'

interface Result {
  key: string
  label: string
  kind: 'Chat' | 'Develop' | 'Workflow' | 'Template'
  run: () => void
}

/** Ctrl+K: jump to any chat, Develop session or workflow. */
export function SearchDialog() {
  const open = useUi((s) => s.searchOpen)
  const setOpen = useUi((s) => s.setSearchOpen)
  const setMode = useUi((s) => s.setMode)
  const sessions = useSessions((s) => s.sessions)
  const openSession = useSessions((s) => s.open)
  const mine = useWorkflows((s) => s.mine)
  const openWorkflow = useWorkflows((s) => s.open)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)

  const results = useMemo<Result[]>(() => {
    const needle = q.trim().toLowerCase()
    const hit = (t: string) => !needle || t.toLowerCase().includes(needle)
    const out: Result[] = []
    Object.values(sessions)
      .filter((s) => hit(s.title))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .forEach((s) =>
        out.push({
          key: s.id,
          label: s.title,
          kind: s.mode === 'develop' ? 'Develop' : 'Chat',
          run: () => {
            setMode(s.mode)
            openSession(s.id)
          }
        })
      )
    mine.filter((w) => hit(w.name)).forEach((w) => out.push({ key: w.id, label: w.name, kind: 'Workflow', run: () => { setMode('workflows'); openWorkflow(w.id) } }))
    TEMPLATES.filter((w) => hit(w.name)).forEach((w) => out.push({ key: w.id, label: w.name, kind: 'Template', run: () => { setMode('workflows'); openWorkflow(w.id) } }))
    return out.slice(0, 12)
  }, [q, sessions, mine, setMode, openSession, openWorkflow])

  const choose = (r?: Result) => {
    if (!r) return
    r.run()
    setOpen(false)
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setQ('')
          setIdx(0)
        }
      }}
      title="Search"
      description="Find a chat, a Develop session or a workflow"
      hideTitle
      className="w-[min(600px,calc(100vw-48px))]"
    >
      <div className="flex items-center gap-3 border-b border-edge px-5">
        <Search className="h-[18px] w-[18px] shrink-0 text-ink-muted" />
        <input
          autoFocus
          value={q}
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-activedescendant={results[idx] ? `sr-${results[idx].key}` : undefined}
          aria-label="Search chats and workflows"
          placeholder="Search chats, sessions and workflows…"
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              choose(results[idx])
            }
          }}
          className="h-14 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      <ul id="search-results" role="listbox" aria-label="Results" className="max-h-[360px] overflow-y-auto p-2">
        {results.map((r, i) => {
          const Icon = r.kind === 'Chat' ? MessageSquare : r.kind === 'Develop' ? Code : Workflow
          return (
            <li
              key={r.key}
              id={`sr-${r.key}`}
              role="option"
              aria-selected={i === idx}
              onMouseMove={() => setIdx(i)}
              onClick={() => choose(r)}
              className={cn('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-[14px]', i === idx ? 'bg-select' : '')}
            >
              <Icon className="h-4 w-4 shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1 truncate text-ink">{r.label}</span>
              <span className="shrink-0 text-xs text-ink-faint">{r.kind}</span>
            </li>
          )
        })}
        {results.length === 0 && <li className="px-3 py-8 text-center text-[14px] text-ink-faint">Nothing matches “{q}”</li>}
      </ul>
    </Modal>
  )
}
