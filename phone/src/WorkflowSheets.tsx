import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, FileText, Globe, Play, Plug, Terminal, Workflow, type LucideIcon } from 'lucide-react'
import type { PhoneWorkflow } from '@shared/phone'
import type { InputDef, PlannedAction, RunSummary, StoredRunEvent } from '@shared/workflow'
import { useApp } from './store'
import { Shimmer, buzz } from './ui'

/*
 * Workflows from the phone: start one (answering what its Start step asks), and answer the card every run shows before it
 * does anything, listing all of it. A run started here works in the workflow's own folder on the computer.
 */

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: (close: () => void) => React.ReactNode }) {
  const [leaving, setLeaving] = useState(false)
  const close = () => {
    setLeaving(true)
    setTimeout(onClose, 200)
  }
  return createPortal(
    <div className={`card-layer${leaving ? ' out' : ''}`}>
      <div className="scrim" onClick={close} />
      <div className="sheet tall" role="dialog" aria-label={label}>
        <div className="handle" />
        {children(close)}
      </div>
    </div>,
    document.querySelector('.app') ?? document.body
  )
}

const initial = (d: InputDef): string | boolean => (d.type === 'boolean' ? d.default === true : d.default === undefined ? '' : String(d.default))

/** Start a workflow: its questions, then Start. The run's own card follows. */
export function StartSheet({ workflow, onClose, onStarted }: { workflow: PhoneWorkflow; onClose: () => void; onStarted: (run: RunSummary) => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(workflow.inputs.map((d) => [d.name, initial(d)])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = async (close: () => void) => {
    const link = useApp.getState().link
    if (!link || busy) return
    buzz(8)
    setBusy(true)
    setError('')
    try {
      const run = await link.call<RunSummary>('phone.runWorkflow', workflow.id, values)
      close()
      onStarted(run)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'It did not start.')
      setBusy(false)
    }
  }
  return (
    <Sheet label={`Start ${workflow.name}`} onClose={onClose}>
      {(close) => (
        <>
          <div className="overline" style={{ fontSize: 10 }}>
            Workflow
          </div>
          <h1 className="h-l" style={{ fontSize: 20, margin: '2px 0 4px' }}>
            {workflow.name}
          </h1>
          {workflow.description && <p className="small muted" style={{ margin: '0 0 10px' }}>{workflow.description}</p>}
          <div className="mlist">
            {workflow.inputs.map((d) => {
              const label = d.label || d.name
              const v = values[d.name]
              const set = (x: string | boolean) => setValues((all) => ({ ...all, [d.name]: x }))
              if (d.type === 'boolean')
                return (
                  <button key={d.name} className="mrow" onClick={() => set(!v)}>
                    <span className="grow">{label}</span>
                    <span className={`switch${v ? ' on' : ''}`} />
                  </button>
                )
              return (
                <label key={d.name} className="wf-field">
                  <span className="small muted">
                    {label}
                    {d.required ? ' *' : ''}
                  </span>
                  {d.type === 'choice' ? (
                    <select className="field" value={String(v)} onChange={(e) => set(e.target.value)}>
                      <option value="">Choose…</option>
                      {(d.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className="field" inputMode={d.type === 'number' ? 'decimal' : 'text'} value={String(v)} onChange={(e) => set(e.target.value)} />
                  )}
                </label>
              )
            })}
            {workflow.inputs.length === 0 && <p className="small muted">It asks for nothing to start.</p>}
          </div>
          {error && <p className="error-text" style={{ margin: '10px 2px 0' }}>{error}</p>}
          <p className="small faint" style={{ margin: '12px 2px 0' }}>
            It runs on the computer, and shows you everything it will do before it does any of it.
          </p>
          <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy} onClick={() => void start(close)}>
            <Play size={16} /> {busy ? 'Starting…' : 'Start'}
          </button>
        </>
      )}
    </Sheet>
  )
}

const KIND_ICON: Record<PlannedAction['kind'], LucideIcon> = { shell: Terminal, http: Globe, file: FileText, mcp: Plug, agent: Bot }

type Waiting =
  | { kind: 'plan'; requestId: string; actions: PlannedAction[] }
  | { kind: 'tool'; requestId: string; title: string; detail?: string }
  | { kind: 'question' }

/** What the run waits for the person to answer, read from its log. */
export function waitingFor(events: StoredRunEvent[]): Waiting | null {
  const answered = new Set<string>()
  for (const { event: e } of events) {
    if (e.type === 'approval.resolved' || e.type === 'agent.approval.resolved' || e.type === 'agent.ask.answered') answered.add(e.requestId)
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = (events[i] as StoredRunEvent).event
    if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled') return null
    if (e.type === 'approval.requested' && !answered.has(e.requestId)) return { kind: 'plan', requestId: e.requestId, actions: e.actions }
    if (e.type === 'agent.approval' && !answered.has(e.requestId)) return { kind: 'tool', requestId: e.requestId, title: e.title, ...(e.detail ? { detail: e.detail } : {}) }
    if (e.type === 'agent.ask' && !answered.has(e.requestId)) return { kind: 'question' }
  }
  return null
}

/** A run, and what it waits for: the list of everything it will do with Approve and Deny, a tool to allow, or a pointer to the computer. */
export function RunSheet({ runId, onClose }: { runId: string; onClose: () => void }) {
  const run = useApp((s) => s.runs.find((r) => r.id === runId))
  const [waiting, setWaiting] = useState<Waiting | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const read = async () => {
      const got = await useApp.getState().link?.call<{ summary: RunSummary; events: StoredRunEvent[] } | null>('runs.get', runId).catch(() => null)
      if (live) setWaiting(got ? waitingFor(got.events) : null)
    }
    void read()
    // A run just started asks within a moment; one that is going on may ask later. Read again while the sheet is open.
    const t = setInterval(() => void read(), 1500)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [runId, run?.status])
  const answer = async (requestId: string, allow: boolean, close: () => void) => {
    buzz(allow ? 12 : 6)
    try {
      await useApp.getState().link?.call('runs.respondApproval', runId, requestId, allow)
      close()
    } catch (err) {
      useApp.getState().say(err instanceof Error ? err.message : 'The answer did not reach the computer.')
    }
  }
  return (
    <Sheet label={run?.workflowName ?? 'Workflow run'} onClose={onClose}>
      {(close) => (
        <>
          <div className="overline" style={{ fontSize: 10 }}>
            Workflow run
          </div>
          <h1 className="h-l" style={{ fontSize: 20, margin: '2px 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Workflow size={20} /> {run?.workflowName ?? 'Workflow'}
          </h1>
          {waiting === undefined ? (
            <div className="empty" style={{ padding: 24 }}>
              <Shimmer>Asking the computer</Shimmer>
            </div>
          ) : waiting?.kind === 'plan' ? (
            <>
              <p className="small muted" style={{ margin: '0 2px 8px' }}>
                It will do all of this, and nothing else. Steps that use an earlier step’s result show it as {'{{ }}'}.
              </p>
              <div className="mlist">
                {waiting.actions.map((a, i) => {
                  const Icon = KIND_ICON[a.kind] ?? Terminal
                  return (
                    <div key={i} className="mrow plan">
                      <Icon size={16} />
                      <span className="grow">
                        <span className="nm">{a.nodeName}</span>
                        <span className="pk mono">
                          {a.where ? `on ${a.where}: ` : ''}
                          {a.text}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="btnrow" style={{ marginTop: 14 }}>
                <button className="btn tonal" onClick={() => void answer(waiting.requestId, false, close)}>
                  Don’t run
                </button>
                <button className="btn primary shine" onClick={() => void answer(waiting.requestId, true, close)}>
                  Run it
                </button>
              </div>
            </>
          ) : waiting?.kind === 'tool' ? (
            <>
              <div className="reason">{waiting.title}</div>
              {waiting.detail && <pre className="tool-out" style={{ marginTop: 8 }}>{waiting.detail}</pre>}
              <div className="btnrow" style={{ marginTop: 14 }}>
                <button className="btn tonal" onClick={() => void answer(waiting.requestId, false, close)}>
                  Deny
                </button>
                <button className="btn primary" onClick={() => void answer(waiting.requestId, true, close)}>
                  Approve
                </button>
              </div>
            </>
          ) : waiting?.kind === 'question' ? (
            <p className="small muted">A step has a question for you. Answer it on the computer, in the run.</p>
          ) : (
            <p className="small muted">{run?.status === 'running' ? 'It is running. Nothing waits for you.' : run?.error || run?.output?.slice(0, 600) || 'Nothing waits for you.'}</p>
          )}
          <button className="btn tonal block" style={{ marginTop: 12 }} onClick={close}>
            Close
          </button>
        </>
      )}
    </Sheet>
  )
}
