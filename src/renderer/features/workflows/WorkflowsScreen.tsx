import { FileDown, Plus, Workflow as WorkflowIcon } from 'lucide-react'
import type { WorkflowSummary } from '@shared/workflow'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui'
import { formatDay, formatTime, sameDay } from '@/lib/format'
import { useWorkflows } from '@/stores/workflows'
import { WorkflowEditor } from './WorkflowEditor'

const STATUS: Record<string, string> = { running: 'Running now', waiting: 'Waiting for you', completed: 'Last run finished', failed: 'Last run failed', cancelled: 'Last run was stopped' }

/** When something happened, for a list: the time today, the day otherwise. */
const when = (at: number) => (sameDay(at, Date.now()) ? formatTime(at) : formatDay(at))

function Row({ w }: { w: WorkflowSummary }) {
  const open = useWorkflows((s) => s.open)
  return (
    <li>
      <button
        type="button"
        onClick={() => void open(w.id)}
        className="flex w-full items-center gap-4 rounded-xl border border-edge bg-field/50 px-4 py-3.5 text-left transition-colors hover:border-accent-edge hover:bg-hover"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <WorkflowIcon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink">{w.name}</span>
          <span className="block truncate text-[13px] text-ink-muted">{w.description || 'No description.'}</span>
        </span>
        <span className="shrink-0 text-right text-[12.5px] text-ink-muted">
          <span className="block">Version {w.version}</span>
          <span className="block text-ink-faint">{w.lastRun ? `${STATUS[w.lastRun.status] ?? 'Ran'}, ${when(w.lastRun.at)}` : `Changed ${when(w.updatedAt)}`}</span>
        </span>
      </button>
    </li>
  )
}

/** All the workflows, or the way in when there are none. */
function Home() {
  const list = useWorkflows((s) => s.list)
  const loaded = useWorkflows((s) => s.loaded)
  const create = useWorkflows((s) => s.newWorkflow)
  const importFile = useWorkflows((s) => s.importFile)
  return (
    <div className="mx-auto flex h-full max-w-[860px] flex-col px-8 py-10">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[26px] font-semibold text-ink">Workflows</h1>
          <p className="mt-1 max-w-[560px] text-[14px] text-ink-muted">A workflow is a list of steps that run one after another: commands, web requests, files, your tools, and questions to an assistant. You see everything it will do before it starts.</p>
        </div>
        {list.length > 0 && (
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" onClick={importFile}>
              <FileDown className="h-4 w-4" /> Import
            </Button>
            <Button variant="primary" onClick={create}>
              <Plus className="h-4 w-4" /> New workflow
            </Button>
          </div>
        )}
      </div>

      {loaded && list.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
            <WorkflowIcon className="h-8 w-8" />
          </span>
          <h2 className="mt-5 text-[18px] font-medium text-ink">No workflows yet</h2>
          <p className="mt-1.5 max-w-[420px] text-[14px] text-ink-muted">Make one for something you do again and again, and run it in one click.</p>
          <div className="mt-6 flex gap-2">
            <Button variant="primary" onClick={create}>
              <Plus className="h-4 w-4" /> New workflow
            </Button>
            <Button variant="secondary" onClick={importFile}>
              <FileDown className="h-4 w-4" /> Import a file
            </Button>
          </div>
        </div>
      ) : (
        <ul aria-label="Your workflows" className="mt-8 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
          {list.map((w) => (
            <Row key={w.id} w={w} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function WorkflowsScreen() {
  const draft = useWorkflows((s) => s.draft)
  const leaving = useWorkflows((s) => s.leaving)
  const confirmLeave = useWorkflows((s) => s.confirmLeave)
  const cancelLeave = useWorkflows((s) => s.cancelLeave)
  return (
    <div className="h-full">
      {draft ? <WorkflowEditor /> : <Home />}
      <ConfirmDialog open={leaving !== null} title="Leave without saving?" confirmLabel="Leave without saving" onCancel={cancelLeave} onConfirm={confirmLeave}>
        This workflow has changes that are not saved. If you leave now they are lost.
      </ConfirmDialog>
    </div>
  )
}
