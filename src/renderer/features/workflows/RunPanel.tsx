import { useEffect, useMemo, useState } from 'react'
import { Ban, Play } from 'lucide-react'
import { foldRun } from '@shared/workflow-run'
import { formatDuration, formatTime } from '@/lib/format'
import { PanelCard } from '@/components/PanelCard'
import { Badge, Button, Spinner } from '@/components/ui'
import { useRuns } from '@/stores/runs'
import { useWorkflows } from '@/stores/workflows'
import { STATUS_TEXT, STATUS_TONE, StepRows, WHO, WaitingCards, stepsOf } from './RunParts'

/** The panel beside the canvas while a run is shown: what it will do, how far it has got, and what it produced. */
export function RunPanel({ runId, onClose, onRunAgain }: { runId: string; onClose: () => void; onRunAgain: () => void }) {
  const run = useRuns((s) => s.runs[runId])
  const load = useRuns((s) => s.load)
  const cancel = useRuns((s) => s.cancel)
  const focusNode = useRuns((s) => s.focusNode)
  const definition = useWorkflows((s) => s.draft?.definition)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // Time passes while it runs, so "how long" needs a clock.
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!run || run.events.length === 0) void load(runId)
  }, [runId, run, load])
  const live = run?.summary.status === 'running' || run?.summary.status === 'waiting'
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  useEffect(() => {
    if (focusNode) setOpen((o) => ({ ...o, [focusNode]: true }))
  }, [focusNode])

  const view = useMemo(() => foldRun(run?.events ?? []), [run?.events])
  const steps = useMemo(() => stepsOf(definition, view), [definition, view])

  if (!run) {
    return (
      <PanelCard title="Run" onClose={onClose} className="h-full w-[400px] shrink-0" bodyClassName="p-4">
        <p role="status" className="flex items-center gap-2 text-[13px] text-ink-muted">
          <Spinner className="h-3.5 w-3.5" /> Opening the run…
        </p>
      </PanelCard>
    )
  }
  const { summary } = run
  const end = summary.finishedAt ?? now

  return (
    <PanelCard
      title="Run"
      onClose={onClose}
      className="h-full w-[400px] shrink-0"
      bodyClassName="space-y-3 p-4"
      actions={
        live ? (
          <Button variant="secondary" size="sm" onClick={() => void cancel(runId)}>
            <Ban className="h-3.5 w-3.5" /> Stop
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[summary.status]}>{STATUS_TEXT[summary.status]}</Badge>
        <span className="text-[12.5px] text-ink-muted">
          Version {summary.version} · started by {WHO[summary.startedBy]} at {formatTime(summary.startedAt)} · {formatDuration(Math.max(0, end - summary.startedAt))}
        </span>
      </div>
      {Object.keys(summary.inputs).length > 0 && (
        <p className="text-[12.5px] text-ink-muted">
          {Object.entries(summary.inputs)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(' · ')}
        </p>
      )}

      <WaitingCards runId={runId} view={view} />
      <StepRows steps={steps} view={view} open={open} onToggle={(id) => setOpen({ ...open, [id]: !open[id] })} focusNode={focusNode} />

      {view.finished === 'completed' && (
        <section aria-label="Result" className="rounded-xl border border-success/30 bg-success/5 p-3.5">
          <div className="text-[13px] font-medium text-ink">Result</div>
          <pre className="selectable mt-1.5 max-h-56 overflow-auto font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-ink-muted">{view.output || '(nothing)'}</pre>
        </section>
      )}
      {view.finished === 'failed' && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3.5 text-[13px] text-danger">
          {view.error}
        </p>
      )}
      {!live && (
        <Button variant="secondary" size="sm" onClick={onRunAgain}>
          <Play className="h-3.5 w-3.5" /> Run again
        </Button>
      )}
    </PanelCard>
  )
}
