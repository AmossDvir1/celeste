import { useMemo, useState } from 'react'
import { ChevronRight, File, FileDiff, Folder, FolderOpen } from 'lucide-react'
import type { FileDiff as FileDiffData } from '@shared/agent'
import { cn } from '@/lib/cn'
import { basename } from '@/lib/format'
import { PanelCard } from '@/components/PanelCard'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { DiffList } from './DiffView'

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
      className="h-full"
      bodyClassName="p-3"
    >
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

interface TreeNode {
  name: string
  children?: TreeNode[]
}

const TREE: TreeNode[] = [
  {
    name: 'src',
    children: [
      { name: 'auth', children: [{ name: 'LoginForm.tsx' }, { name: 'validateLogin.ts' }, { name: 'session.ts' }] },
      { name: 'cart', children: [{ name: 'Cart.tsx' }, { name: '__tests__', children: [{ name: 'cart.spec.ts' }] }] },
      {
        name: 'checkout',
        children: [{ name: 'pricing.ts' }, { name: 'checkout.ts' }, { name: '__tests__', children: [{ name: 'checkout.spec.ts' }] }]
      },
      { name: 'features', children: [{ name: 'orders', children: [{ name: 'OrderTable.tsx' }] }] },
      { name: 'main.tsx' }
    ]
  },
  { name: 'package.json' },
  { name: 'tsconfig.json' },
  { name: 'README.md' }
]

function TreeRow({ node, path, depth, changed }: { node: TreeNode; path: string; depth: number; changed: Set<string> }) {
  const [open, setOpen] = useState(depth < 1 || [...changed].some((c) => c.startsWith(path + '/')))
  const full = path ? `${path}/${node.name}` : node.name
  const isDir = !!node.children
  const modified = !isDir && [...changed].some((c) => c.endsWith(full) || c === full)

  return (
    <li>
      <button
        type="button"
        aria-expanded={isDir ? open : undefined}
        onClick={() => isDir && setOpen(!open)}
        className="flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-ink hover:bg-hover"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {isDir ? (
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {isDir ? (
          open ? <FolderOpen className="h-4 w-4 shrink-0 text-accent-text" /> : <Folder className="h-4 w-4 shrink-0 text-ink-muted" />
        ) : (
          <File className="h-4 w-4 shrink-0 text-ink-muted" />
        )}
        <span className={cn('min-w-0 flex-1 truncate', modified && 'text-warning')}>{node.name}</span>
        {modified && <span className="font-mono text-[11px] text-warning">M</span>}
      </button>
      {isDir && open && (
        <ul>
          {node.children!.map((c) => (
            <TreeRow key={c.name} node={c} path={full} depth={depth + 1} changed={changed} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function FilesPanel() {
  const setRight = useUi((s) => s.setRight)
  const session = useDevelopSession()
  const changed = useMemo(() => new Set(session ? allDiffs(session.items).map((d) => d.path) : []), [session])
  return (
    <PanelCard title={session?.cwd ? basename(session.cwd) : 'Files'} onClose={() => setRight(null)} className="h-full" bodyClassName="p-2">
      <ul>
        {TREE.map((n) => (
          <TreeRow key={n.name} node={n} path="" depth={0} changed={changed} />
        ))}
      </ul>
    </PanelCard>
  )
}

export function TerminalPanel() {
  const setRight = useUi((s) => s.setRight)
  const session = useDevelopSession()
  const [typed, setTyped] = useState<{ cmd: string; out: string }[]>([])
  const [line, setLine] = useState('')
  const cwd = session?.cwd ?? 'D:\\Work\\wfo-tools'
  const ran = (session?.items ?? []).filter((i) => i.kind === 'tool' && i.tool === 'shell')

  return (
    <PanelCard title="Terminal" onClose={() => setRight(null)} className="h-full" bodyClassName="bg-field">
      <div className="selectable p-4 font-mono text-[12.5px] leading-[1.65] text-ink-muted">
        {ran.map((t) =>
          t.kind === 'tool' ? (
            <div key={t.id} className="mb-3">
              <div>
                <span className="text-accent-text">PS {cwd}&gt;</span> <span className="text-ink">{t.input ?? t.title}</span>
              </div>
              <pre className="whitespace-pre-wrap">{t.output}</pre>
            </div>
          ) : null
        )}
        {typed.map((t, i) => (
          <div key={i} className="mb-3">
            <div>
              <span className="text-accent-text">PS {cwd}&gt;</span> <span className="text-ink">{t.cmd}</span>
            </div>
            <pre className="whitespace-pre-wrap">{t.out}</pre>
          </div>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!line.trim()) return
            setTyped([...typed, { cmd: line, out: 'This terminal is a preview. Commands run for real in a later phase.' }])
            setLine('')
          }}
          className="flex items-center gap-2"
        >
          <span className="shrink-0 text-accent-text">PS {cwd}&gt;</span>
          <input
            value={line}
            onChange={(e) => setLine(e.target.value)}
            aria-label="Terminal input"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-ink outline-none"
          />
        </form>
      </div>
    </PanelCard>
  )
}
