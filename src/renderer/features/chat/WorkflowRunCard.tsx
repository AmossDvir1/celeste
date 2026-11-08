import { useEffect, useMemo, useState } from 'react'
import { Ban, ChevronDown, Workflow } from 'lucide-react'
import { foldRun } from '@shared/workflow-run'
import { cn } from '@/lib/cn'
import { Badge, Button } from '@/components/ui'
import { STATUS_TEXT, STATUS_TONE, StepRows, WaitingCards, stepsOf, useDefinition } from '@/features/workflows/RunParts'
import { useRuns } from '@/stores/runs'

/**
 * A workflow started from this conversation. While it runs it shows its steps, and whatever it is waiting for (the card before it
 * starts, the assistant's own requests, its questions) appears here, in place. When it has ended it folds down to one line and its
 * result, which the assistant is told with the next message.
 */
export function WorkflowRunCard({ runId, name, workflowId }: { runId: string; name: string; workflowId: string }) {
  const run = useRuns((s) => s.runs[runId])
  const load = useRuns((s) => s.load)
  const cancel = useRuns((s) => s.cancel)
  const definition = useDefinition(workflowId)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [folded, setFolded] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    if (!run || run.events.length === 0) void load(runId)
  }, [runId, run, load])

  const view = useMemo(() => foldRun(run?.events ?? []), [run?.events])
  const steps = useMemo(() => stepsOf(definition, view), [definition, view])
  const status = run?.summary.status
  const live = status === 'running' || status === 'waiting'
  // Open while it is going, folded once it has ended, unless the person has chosen.
  const isFolded = folded ?? !live

  return (
    <section aria-label={`Workflow: ${name}`} className="animate-fade-up max-w-[760px] rounded-xl border border-edge bg-field/50 p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <Workflow className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{name}</div>
          <div className="text-[12px] text-ink-muted">Workflow</div>
        </div>
        {status && <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>}
        {live && (
          <Button variant="secondary" size="sm" onClick={() => void cancel(runId)}>
            <Ban className="h-3.5 w-3.5" /> Stop
          </Button>
        )}
        <button
          type="button"
          aria-expanded={!isFolded}
          aria-label={isFolded ? 'Show the steps' : 'Hide the steps'}
          onClick={() => setFolded(!isFolded)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-hover hover:text-ink"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', !isFolded && 'rotate-180')} />
        </button>
      </div>

      {run && (
        <div className="mt-3 space-y-3">
          <WaitingCards runId={runId} view={view} />
          {!isFolded && <StepRows steps={steps} view={view} open={open} onToggle={(id) => setOpen({ ...open, [id]: !open[id] })} />}
          {view.finished === 'completed' && (
            <div aria-label="Result" role="group" className="rounded-lg bg-success/5 px-3 py-2.5">
              <pre className="selectable max-h-48 overflow-auto font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-ink-muted">{view.output || '(nothing)'}</pre>
            </div>
          )}
          {view.finished === 'failed' && (
            <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2.5 text-[13px] text-danger">
              {view.error}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
