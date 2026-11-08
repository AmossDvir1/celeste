import { useEffect, useMemo, useState } from 'react'
import { Ban, Check, ChevronRight, CircleAlert, FileText, Globe, Minus, Plug, Play, ShieldQuestion, Sparkles, Terminal } from 'lucide-react'
import type { PlannedAction, RunSummary } from '@shared/workflow'
import { foldRun, type NodeView } from '@shared/workflow-run'
import { orderedNodes } from '@shared/workflow-edit'
import { cn } from '@/lib/cn'
import { formatDuration, formatTime } from '@/lib/format'
import { PanelCard } from '@/components/PanelCard'
import { Badge, Button, Spinner } from '@/components/ui'
import { AskUserCard } from '@/features/chat/Timeline'
import { useRuns } from '@/stores/runs'
import { useWorkflows } from '@/stores/workflows'

const KIND_ICON: Record<PlannedAction['kind'], typeof Terminal> = { shell: Terminal, http: Globe, file: FileText, mcp: Plug, agent: Sparkles }
const KIND_LABEL: Record<PlannedAction['kind'], string> = { shell: 'Command', http: 'Web request', file: 'File', mcp: 'Tool', agent: 'Assistant' }

const STATUS_TEXT: Record<RunSummary['status'], string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  completed: 'Finished',
  failed: 'Failed',
  cancelled: 'Stopped'
}
const STATUS_TONE: Record<RunSummary['status'], 'info' | 'warning' | 'success' | 'accent' | 'neutral'> = {
  running: 'info',
  waiting: 'warning',
  completed: 'success',
  failed: 'accent',
  cancelled: 'neutral'
}

const WHO = { you: 'you', menu: 'the / menu', assistant: 'the assistant' } as const

function StateIcon({ n }: { n: NodeView | undefined }) {
  if (!n || n.state === 'pending') return <span className="h-4 w-4 rounded-full border border-edge-strong" aria-hidden />
  if (n.state === 'running') return <Spinner className="h-4 w-4 text-accent-text" />
  if (n.state === 'done') return <Check className="h-4 w-4 text-success" strokeWidth={3} aria-hidden />
  if (n.state === 'skipped') return <Minus className="h-4 w-4 text-ink-muted" aria-hidden />
  return <CircleAlert className="h-4 w-4 text-danger" aria-hidden />
}

const WORD: Record<NodeView['state'], string> = { pending: 'Not reached', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped' }

/** The card shown before anything happens: everything the run will do, to allow or refuse as a whole. */
function ApprovalCard({ runId, requestId, actions }: { runId: string; requestId: string; actions: PlannedAction[] }) {
  const approve = useRuns((s) => s.approve)
  return (
    <div role="group" aria-label="Approval needed" className="animate-fade-up rounded-xl border border-accent-edge bg-accent-soft/50 p-4">
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <ShieldQuestion className="h-[18px] w-[18px] text-accent-text" /> Allow this run to do the following?
      </div>
      <ol className="mt-3 space-y-2">
        {actions.map((a, i) => {
          const Icon = KIND_ICON[a.kind]
          return (
            <li key={i} className="rounded-lg bg-field px-3 py-2.5">
              <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                <Icon className="h-3.5 w-3.5" /> {a.nodeName} · {KIND_LABEL[a.kind]}
                {a.where && <span> · on {a.where}</span>}
              </div>
              <div className="selectable mt-1 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-ink">{a.text}</div>
            </li>
          )
        })}
      </ol>
      <p className="mt-2.5 text-xs text-ink-muted">Where a command uses the result of an earlier step, it is shown as {'{{ }}'} and filled in when it runs.</p>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" onClick={() => void approve(runId, requestId, true)} autoFocus>
          Allow and run
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void approve(runId, requestId, false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** The panel beside the canvas while a run is shown: what it will do, how far it has got, and what it produced. */
export function RunPanel({ runId, onClose, onRunAgain }: { runId: string; onClose: () => void; onRunAgain: () => void }) {
  const run = useRuns((s) => s.runs[runId])
  const load = useRuns((s) => s.load)
  const cancel = useRuns((s) => s.cancel)
  const approve = useRuns((s) => s.approve)
  const answer = useRuns((s) => s.answer)
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
  // The steps in the order they run, named from the workflow as it is now; a step from an older version shows by its id.
  const steps = useMemo(() => {
    const names = new Map((definition ? orderedNodes(definition) : []).map((n) => [n.id, n.name]))
    const ids = [...(definition ? orderedNodes(definition).map((n) => n.id) : []), ...Object.keys(view.nodes).filter((id) => !names.has(id))]
    return ids.map((id) => ({ id, name: names.get(id) ?? id }))
  }, [definition, view.nodes])

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
      actions={live ? (
        <Button variant="secondary" size="sm" onClick={() => void cancel(runId)}>
          <Ban className="h-3.5 w-3.5" /> Stop
        </Button>
      ) : undefined}
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

      {view.waiting?.kind === 'approval' && <ApprovalCard runId={runId} requestId={view.waiting.requestId} actions={view.waiting.actions} />}
      {view.waiting?.kind === 'agent-approval' && (
        <div role="group" aria-label="The assistant asks" className="animate-fade-up rounded-xl border border-accent-edge bg-accent-soft/50 p-4">
          <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <ShieldQuestion className="h-[18px] w-[18px] text-accent-text" /> {view.waiting.title}?
          </div>
          {view.waiting.detail && <div className="selectable mt-2.5 rounded-lg bg-field px-3 py-2.5 font-mono text-[12.5px] break-words whitespace-pre-wrap text-ink">{view.waiting.detail}</div>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" autoFocus onClick={() => void approve(runId, (view.waiting as { requestId: string }).requestId, true)}>
              Allow
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void approve(runId, (view.waiting as { requestId: string }).requestId, false)}>
              Deny
            </Button>
          </div>
        </div>
      )}
      {view.waiting?.kind === 'ask' && (
        <AskUserCard
          item={{ kind: 'ask', id: view.waiting.requestId, requestId: view.waiting.requestId, questions: view.waiting.questions, status: 'pending' }}
          onAnswer={(answers) => void answer(runId, (view.waiting as { requestId: string }).requestId, answers)}
        />
      )}
      {view.declined && <p className="text-[13px] text-ink-muted">You did not allow this run, so nothing was done.</p>}

      <ol aria-label="Steps" className="divide-y divide-edge/70 overflow-hidden rounded-xl border border-edge">
        {steps.map(({ id, name }) => {
          const n = view.nodes[id]
          const body = n?.state === 'failed' || n?.state === 'skipped' ? n.error : n?.output
          const expandable = Boolean(body)
          const expanded = open[id] === true
          return (
            <li key={id} className={cn(focusNode === id && 'bg-hover')}>
              <button
                type="button"
                aria-expanded={expandable ? expanded : undefined}
                disabled={!expandable}
                onClick={() => setOpen({ ...open, [id]: !expanded })}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left disabled:cursor-default"
              >
                <StateIcon n={n} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-ink">{name}</span>
                  <span className="block text-[12px] text-ink-muted">
                    {WORD[n?.state ?? 'pending']}
                    {n && n.attempt > 1 ? `, try ${n.attempt}` : ''}
                    {n?.retrying ? `. Trying again: ${n.retrying}` : ''}
                  </span>
                </span>
                {expandable && <ChevronRight className={cn('h-4 w-4 text-ink-muted transition-transform', expanded && 'rotate-90')} />}
              </button>
              {expanded && body && (
                <pre className={cn('selectable mx-3.5 mb-3 max-h-64 overflow-auto rounded-lg bg-field p-3 font-mono text-[12px] leading-[1.6] break-words whitespace-pre-wrap', n?.state === 'failed' ? 'text-danger' : 'text-ink-muted')}>
                  {body.length > 6000 ? `${body.slice(0, 6000)}\n[cut: ${body.length - 6000} more characters]` : body}
                </pre>
              )}
            </li>
          )
        })}
      </ol>

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
