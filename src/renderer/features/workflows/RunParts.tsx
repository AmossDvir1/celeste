import { useEffect, useState } from 'react'
import { Check, ChevronRight, CircleAlert, FileText, Globe, Minus, Plug, ShieldQuestion, Sparkles, Terminal } from 'lucide-react'
import type { PlannedAction, RunSummary, WorkflowDefinition } from '@shared/workflow'
import type { NodeView, RunView } from '@shared/workflow-run'
import { orderedNodes } from '@shared/workflow-edit'
import { core } from '@/api'
import { cn } from '@/lib/cn'
import { Button, Spinner } from '@/components/ui'
import { AskUserCard } from '@/features/chat/AskUserCard'
import { useRuns } from '@/stores/runs'

/** The parts of a run that the panel beside the canvas and the card in a conversation both show. */

const KIND_ICON: Record<PlannedAction['kind'], typeof Terminal> = { shell: Terminal, http: Globe, file: FileText, mcp: Plug, agent: Sparkles }
const KIND_LABEL: Record<PlannedAction['kind'], string> = { shell: 'Command', http: 'Web request', file: 'File', mcp: 'Tool', agent: 'Assistant' }

export const STATUS_TEXT: Record<RunSummary['status'], string> = { running: 'Running', waiting: 'Waiting for you', completed: 'Finished', failed: 'Failed', cancelled: 'Stopped' }
export const STATUS_TONE: Record<RunSummary['status'], 'info' | 'warning' | 'success' | 'accent' | 'neutral'> = { running: 'info', waiting: 'warning', completed: 'success', failed: 'accent', cancelled: 'neutral' }
export const WHO = { you: 'you', menu: 'the / menu', assistant: 'the assistant' } as const
const WORD: Record<NodeView['state'], string> = { pending: 'Not reached', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped' }

function StateIcon({ n }: { n: NodeView | undefined }) {
  if (!n || n.state === 'pending') return <span className="h-4 w-4 rounded-full border border-edge-strong" aria-hidden />
  if (n.state === 'running') return <Spinner className="h-4 w-4 text-accent-text" />
  if (n.state === 'done') return <Check className="h-4 w-4 text-success" strokeWidth={3} aria-hidden />
  if (n.state === 'skipped') return <Minus className="h-4 w-4 text-ink-muted" aria-hidden />
  return <CircleAlert className="h-4 w-4 text-danger" aria-hidden />
}

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

/** Whatever the run is waiting for the person to answer: the card before it starts, a request from the assistant, or its question. */
export function WaitingCards({ runId, view }: { runId: string; view: RunView }) {
  const approve = useRuns((s) => s.approve)
  const answer = useRuns((s) => s.answer)
  const w = view.waiting
  if (!w) return view.declined ? <p className="text-[13px] text-ink-muted">You did not allow this run, so nothing was done.</p> : null
  if (w.kind === 'approval') return <ApprovalCard runId={runId} requestId={w.requestId} actions={w.actions} />
  if (w.kind === 'agent-approval') {
    return (
      <div role="group" aria-label="The assistant asks" className="animate-fade-up rounded-xl border border-accent-edge bg-accent-soft/50 p-4">
        <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
          <ShieldQuestion className="h-[18px] w-[18px] text-accent-text" /> {w.title}?
        </div>
        {w.detail && <div className="selectable mt-2.5 rounded-lg bg-field px-3 py-2.5 font-mono text-[12.5px] break-words whitespace-pre-wrap text-ink">{w.detail}</div>}
        <div className="mt-3 flex gap-2">
          <Button variant="primary" size="sm" autoFocus onClick={() => void approve(runId, w.requestId, true)}>
            Allow
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void approve(runId, w.requestId, false)}>
            Deny
          </Button>
        </div>
      </div>
    )
  }
  return <AskUserCard item={{ kind: 'ask', id: w.requestId, requestId: w.requestId, questions: w.questions, status: 'pending' }} onAnswer={(answers) => void answer(runId, w.requestId, answers)} />
}

/** The steps in the order they run, named from a workflow's definition; a step from an older version shows by its id. */
export function stepsOf(definition: WorkflowDefinition | undefined, view: RunView): { id: string; name: string }[] {
  const ordered = definition ? orderedNodes(definition) : []
  const names = new Map(ordered.map((n) => [n.id, n.name]))
  return [...ordered.map((n) => n.id), ...Object.keys(view.nodes).filter((id) => !names.has(id))].map((id) => ({ id, name: names.get(id) ?? id }))
}

/** The definition of a workflow, for naming the steps of a run. Nothing when the workflow has since been deleted. */
export function useDefinition(workflowId: string): WorkflowDefinition | undefined {
  const [definition, setDefinition] = useState<WorkflowDefinition>()
  useEffect(() => {
    let alive = true
    void core.call('workflows.get', workflowId).then((w) => alive && setDefinition(w?.definition), () => undefined)
    return () => {
      alive = false
    }
  }, [workflowId])
  return definition
}

export function StepRows({ steps, view, open, onToggle, focusNode }: { steps: { id: string; name: string }[]; view: RunView; open: Record<string, boolean>; onToggle: (id: string) => void; focusNode?: string | null }) {
  return (
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
              onClick={() => onToggle(id)}
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
  )
}
