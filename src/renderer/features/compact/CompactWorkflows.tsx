import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, Play, Workflow as WorkflowIcon } from 'lucide-react'
import type { InputDef, RunSummary } from '@shared/workflow'
import { Button } from '@/components/ui'
import { core } from '@/api'
import { formatDay, formatTime, sameDay } from '@/lib/format'
import { useRuns } from '@/stores/runs'
import { useUi } from '@/stores/ui'
import { useWorkflows } from '@/stores/workflows'
import { RunDialog } from '@/features/workflows/RunDialog'
import { RunPanel } from '@/features/workflows/RunPanel'

/** The Workflows tab for the small side window: what is running, a Run button for each workflow, and the latest runs. Making and editing are in the full view. */

const STATUS: Record<RunSummary['status'], string> = { running: 'Running', waiting: 'Waiting for you', completed: 'Finished', failed: 'Failed', cancelled: 'Stopped' }
const when = (at: number) => (sameDay(at, Date.now()) ? formatTime(at) : formatDay(at))

export function CompactWorkflows() {
  const list = useWorkflows((s) => s.list)
  const loaded = useWorkflows((s) => s.loaded)
  const runs = useRuns((s) => s.runs)
  const watching = useRuns((s) => s.watching)
  const watch = useRuns((s) => s.watch)
  const load = useRuns((s) => s.load)
  const setCompact = useUi((s) => s.setCompact)
  const [recent, setRecent] = useState<RunSummary[]>([])
  const [asking, setAsking] = useState<{ workflowId: string; name: string; inputs: InputDef[] } | null>(null)

  // The latest runs, looked at again whenever one changes.
  const changes = Object.values(runs).map((r) => `${r.summary.id}:${r.summary.status}`).join(',')
  useEffect(() => {
    let alive = true
    void core.call('runs.list').then((all) => alive && setRecent(all.slice(0, 8)), () => undefined)
    return () => {
      alive = false
    }
  }, [changes])

  // Running now: what Core says is going, whatever this window has loaded.
  const live = useMemo(() => {
    const byId = new Map<string, RunSummary>()
    for (const r of recent) byId.set(r.id, r)
    for (const r of Object.values(runs)) byId.set(r.summary.id, r.summary)
    return [...byId.values()].filter((r) => r.status === 'running' || r.status === 'waiting').sort((a, b) => b.startedAt - a.startedAt)
  }, [recent, runs])
  const finished = recent.filter((r) => r.status !== 'running' && r.status !== 'waiting').slice(0, 5)

  /** Asks for the workflow's inputs, if it has any, and for where it works: the same dialog as in the full window. */
  const ask = async (workflowId: string, name: string) => {
    try {
      const w = await core.call('workflows.get', workflowId)
      const start = w?.definition.nodes.find((n) => n.type === 'start')
      setAsking({ workflowId, name, inputs: start && start.type === 'start' ? start.inputs : [] })
    } catch {
      useUi.getState().pushToast({ text: 'Could not open that workflow.' })
    }
  }

  const openRun = (id: string) => {
    void load(id).then(() => watch(id))
  }

  if (watching) {
    const summary = runs[watching]?.summary
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-edge/70 px-2">
          <button type="button" onClick={() => watch(null)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-ink-muted hover:text-ink">
            <ChevronLeft className="h-4 w-4" /> Workflows
          </button>
          {summary && <span className="min-w-0 truncate text-[13.5px] font-medium text-ink">{summary.workflowName}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RunPanel runId={watching} onClose={() => watch(null)} onRunAgain={() => summary && void ask(summary.workflowId, summary.workflowName)} />
        </div>
        {asking && <RunDialog workflowId={asking.workflowId} name={asking.name} inputs={asking.inputs} onClose={() => setAsking(null)} />}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-3 py-3">
      <h1 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
        <WorkflowIcon className="h-[18px] w-[18px] text-accent-text" /> Workflows
      </h1>

      {live.length > 0 && (
        <section aria-label="Running now" className="mt-4">
          <h2 className="pb-1 text-[11px] font-medium tracking-wide text-ink-faint uppercase">Running now</h2>
          <ul className="space-y-1.5">
            {live.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => openRun(r.id)} className="flex w-full items-center gap-2 rounded-xl border border-accent-edge bg-accent-soft/40 px-3 py-2.5 text-left hover:bg-accent-soft/60">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{r.workflowName}</span>
                  <span className="shrink-0 text-xs text-accent-text">{STATUS[r.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Your workflows" className="mt-4">
        <h2 className="pb-1 text-[11px] font-medium tracking-wide text-ink-faint uppercase">Your workflows</h2>
        {loaded && list.length === 0 ? (
          <p className="text-[13px] text-ink-muted">None yet. Make one in the full view.</p>
        ) : (
          <ul className="space-y-1.5">
            {list.map((w) => (
              <li key={w.id} className="flex items-center gap-2 rounded-xl border border-edge bg-field/50 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{w.name}</span>
                  <span className="block truncate text-xs text-ink-faint">{w.lastRun ? `${STATUS[w.lastRun.status]}, ${when(w.lastRun.at)}` : 'Not run yet'}</span>
                </span>
                <Button variant="secondary" aria-label={`Run ${w.name}`} onClick={() => void ask(w.id, w.name)}>
                  <Play className="h-3.5 w-3.5" /> Run
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {finished.length > 0 && (
        <section aria-label="Recent runs" className="mt-4">
          <h2 className="pb-1 text-[11px] font-medium tracking-wide text-ink-faint uppercase">Recent runs</h2>
          <ul>
            {finished.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => openRun(r.id)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-hover">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{r.workflowName}</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {STATUS[r.status]}, {when(r.finishedAt ?? r.startedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-5 text-xs text-ink-faint">
        Editing, building with AI and importing are in the{' '}
        <button type="button" onClick={() => setCompact(false)} className="text-accent-text hover:underline">
          full view
        </button>
        .
      </p>
      {asking && <RunDialog workflowId={asking.workflowId} name={asking.name} inputs={asking.inputs} onClose={() => setAsking(null)} />}
    </div>
  )
}
