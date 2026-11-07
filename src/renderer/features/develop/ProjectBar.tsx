import { ChevronDown, Folder, FolderPlus, GitBranch } from 'lucide-react'
import { Menu } from '@/components/menu'
import { Switch } from '@/components/ui'
import { basename } from '@/lib/format'
import { PROJECTS } from '@/mocks/tools'
import { useUi } from '@/stores/ui'

const BRANCHES = ['main', 'develop', 'fix/flaky-checkout', 'feature/export-csv']

const chip =
  'inline-flex h-[34px] items-center gap-2 rounded-control border border-edge-strong bg-pill px-3 text-[14px] text-ink-soft transition-colors hover:bg-raised-2 data-[state=open]:bg-raised-2'

/** Develop works in a folder you choose before the first message, optionally in its own git worktree. */
export function ProjectBar() {
  const draft = useUi((s) => s.draft)
  const setDraft = useUi((s) => s.setDraft)
  const pushToast = useUi((s) => s.pushToast)

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className={chip} aria-label={`Project: ${basename(draft.project)}`}>
            <Folder className="h-4 w-4 text-accent-text" />
            <span className="max-w-[220px] truncate">{basename(draft.project)}</span>
            <ChevronDown className="h-4 w-4 text-ink-muted" />
          </button>
        </Menu.Trigger>
        <Menu.Content className="w-[320px]">
          <Menu.Label>Recent projects</Menu.Label>
          <Menu.RadioGroup
            value={draft.project}
            onValueChange={(path) => setDraft({ project: path, branch: PROJECTS.find((p) => p.path === path)?.branch ?? 'main' })}
          >
            {PROJECTS.map((p) => (
              <Menu.RadioItem key={p.path} value={p.path} description={p.path}>
                {basename(p.path)}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <Menu.Separator />
          <Menu.Item onSelect={() => pushToast({ text: 'The folder picker arrives with the real app. For now, choose a recent project.' })}>
            <FolderPlus className="h-4 w-4 text-ink-muted" /> Choose another folder…
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>

      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className={chip} aria-label={`Branch: ${draft.branch}`}>
            <GitBranch className="h-4 w-4 text-ink-muted" />
            <span className="max-w-[180px] truncate">{draft.branch}</span>
            <ChevronDown className="h-4 w-4 text-ink-muted" />
          </button>
        </Menu.Trigger>
        <Menu.Content className="w-[240px]">
          <Menu.Label>Branch</Menu.Label>
          <Menu.RadioGroup value={draft.branch} onValueChange={(branch) => setDraft({ branch })}>
            {BRANCHES.map((b) => (
              <Menu.RadioItem key={b} value={b}>
                {b}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Root>

      <label className="ml-1 inline-flex cursor-pointer items-center gap-2.5 text-[14px] text-ink-muted">
        <Switch label="Use a git worktree" checked={draft.worktree} onCheckedChange={(worktree) => setDraft({ worktree })} />
        Work in a separate worktree
      </label>
    </div>
  )
}
