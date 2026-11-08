import { useEffect, useMemo } from 'react'
import { ChevronDown, Folder, FolderPlus, GitBranch, Plus } from 'lucide-react'
import { chooseFolder, core } from '@/api'
import { Menu } from '@/components/menu'
import { basename } from '@/lib/format'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'

const chip =
  'inline-flex h-[34px] items-center gap-2 rounded-control border border-edge-strong bg-pill px-3 text-[14px] text-ink-soft transition-colors hover:bg-raised-2 data-[state=open]:bg-raised-2'

/** The folders earlier Develop sessions worked in, most recent first. */
function useRecentProjects(): string[] {
  const sessions = useSessions((s) => s.sessions)
  return useMemo(() => {
    const seen = new Set<string>()
    return Object.values(sessions)
      .filter((s) => s.mode === 'develop' && s.cwd)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .flatMap((s) => (seen.has(s.cwd as string) ? [] : (seen.add(s.cwd as string), [s.cwd as string])))
      .slice(0, 6)
  }, [sessions])
}

/** Develop works in a folder you choose before the first message. Its git branch is shown, read only. */
export function ProjectBar() {
  const draft = useUi((s) => s.draft)
  const setDraft = useUi((s) => s.setDraft)
  const pushToast = useUi((s) => s.pushToast)
  const recent = useRecentProjects()

  /** Looks at the folder (is it there, which branch) and makes it the project. */
  const choose = async (path: string) => {
    try {
      const info = await core.call('project.inspect', path)
      if (!info.exists) {
        pushToast({ text: 'That folder is not there any more.' })
        return
      }
      setDraft({ project: path, branch: info.branch ?? '' })
    } catch {
      pushToast({ text: 'Could not open that folder.' })
    }
  }

  const pick = async () => {
    const path = await chooseFolder()
    if (path) await choose(path)
  }

  // The branch can change outside Celeste between sessions, so it is read again when the screen opens.
  useEffect(() => {
    const path = useUi.getState().draft.project
    if (path) void choose(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label = draft.project ? basename(draft.project) : 'Choose a project folder'
  // The folder chosen now is listed too, first, even before any session has used it, so the menu is never just one command.
  const projects = draft.project ? [draft.project, ...recent.filter((p) => p !== draft.project)] : recent

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {projects.length === 0 ? (
        // Nothing chosen and nothing to pick from, so a menu with one item would only be a step in the way: the button opens the folder window.
        <button type="button" className={chip} aria-label="Choose a project folder" onClick={() => void pick()}>
          <Folder className="h-4 w-4 text-accent-text" />
          <span className="max-w-[260px] truncate">{label}</span>
          <Plus className="h-4 w-4 text-ink-muted" />
        </button>
      ) : (
        <Menu.Root>
          <Menu.Trigger asChild>
            <button type="button" className={chip} aria-label={draft.project ? `Project: ${basename(draft.project)}` : 'Choose a project folder'}>
              <Folder className="h-4 w-4 text-accent-text" />
              <span className="max-w-[260px] truncate">{draft.project ? basename(draft.project) : 'Choose a project folder'}</span>
              <ChevronDown className="h-4 w-4 text-ink-muted" />
            </button>
          </Menu.Trigger>
          <Menu.Content className="w-[320px]">
            {projects.length > 0 && (
              <>
                <Menu.Label>Projects</Menu.Label>
                <Menu.RadioGroup value={draft.project} onValueChange={(path) => void choose(path)}>
                  {projects.map((path) => (
                    <Menu.RadioItem key={path} value={path} description={path}>
                      {basename(path)}
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
                <Menu.Separator />
              </>
            )}
            <Menu.Item onSelect={() => void pick()}>
              <FolderPlus className="h-4 w-4 text-ink-muted" /> Choose another folder…
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      )}

      {draft.project && draft.branch && (
        <span className="inline-flex h-[34px] items-center gap-2 text-[14px] text-ink-muted" aria-label={`Branch: ${draft.branch}`}>
          <GitBranch className="h-4 w-4" />
          <span className="max-w-[200px] truncate">{draft.branch}</span>
        </span>
      )}
    </div>
  )
}
