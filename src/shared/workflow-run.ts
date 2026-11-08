import type { Question } from './agent'
import type { PlannedAction, RunEvent, RunStatus, StoredRunEvent } from './workflow'

/** What a run looks like at a moment: each step's state, and what, if anything, the run is waiting for the person to answer. */
export type NodeState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface NodeView {
  state: NodeState
  /** Which try this is, when a step is tried again. */
  attempt: number
  output?: string
  error?: string
  /** Why the step is being tried again. */
  retrying?: string
}

export type Waiting =
  | { kind: 'approval'; requestId: string; actions: PlannedAction[] }
  | { kind: 'agent-approval'; requestId: string; nodeId: string; title: string; detail?: string }
  | { kind: 'ask'; requestId: string; nodeId: string; questions: Question[] }

export interface RunView {
  nodes: Record<string, NodeView>
  waiting?: Waiting
  /** How the run ended, once it has. */
  finished?: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>
  output?: string
  error?: string
  /** The person said no to the approval card, so nothing was done. */
  declined: boolean
}

/** Plays a run's events from the start. Pure, so the live view and the history of a finished run are the same picture. */
export function foldRun(events: StoredRunEvent[] | RunEvent[]): RunView {
  const view: RunView = { nodes: {}, declined: false }
  const node = (id: string): NodeView => (view.nodes[id] ??= { state: 'pending', attempt: 1 })
  for (const item of events) {
    const e: RunEvent = 'event' in item ? item.event : item
    switch (e.type) {
      case 'approval.requested':
        view.waiting = { kind: 'approval', requestId: e.requestId, actions: e.actions }
        break
      case 'approval.resolved':
        view.waiting = undefined
        if (!e.allow) view.declined = true
        break
      case 'node.started': {
        const n = node(e.nodeId)
        n.state = 'running'
        n.attempt = e.attempt
        n.retrying = undefined
        break
      }
      case 'node.retrying': {
        const n = node(e.nodeId)
        n.retrying = e.error
        n.attempt = e.attempt
        break
      }
      case 'node.completed': {
        const n = node(e.nodeId)
        n.state = 'done'
        n.output = e.output
        n.retrying = undefined
        break
      }
      case 'node.skipped': {
        const n = node(e.nodeId)
        n.state = 'skipped'
        n.error = e.error
        break
      }
      case 'node.failed': {
        const n = node(e.nodeId)
        n.state = 'failed'
        n.error = e.error
        break
      }
      case 'agent.approval':
        view.waiting = { kind: 'agent-approval', requestId: e.requestId, nodeId: e.nodeId, title: e.title, ...(e.detail ? { detail: e.detail } : {}) }
        break
      case 'agent.approval.resolved':
      case 'agent.ask.answered':
        view.waiting = undefined
        break
      case 'agent.ask':
        view.waiting = { kind: 'ask', requestId: e.requestId, nodeId: e.nodeId, questions: e.questions as Question[] }
        break
      case 'run.completed':
        view.finished = 'completed'
        view.output = e.output
        view.waiting = undefined
        break
      case 'run.failed':
        view.finished = 'failed'
        view.error = e.error
        view.waiting = undefined
        break
      case 'run.cancelled':
        view.finished = 'cancelled'
        view.waiting = undefined
        break
    }
  }
  return view
}

/** The state to show for a step the run has not reached yet. */
export const stateOf = (view: RunView | undefined, id: string): NodeState => view?.nodes[id]?.state ?? 'pending'
