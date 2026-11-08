import { statSync } from 'node:fs'
import type { AskAnswers } from '@shared/agent'
import type { WorkflowApi } from '@shared/api'
import { validateWorkflow, type RunSummary, type WorkflowDefinition, type WorkflowFull, type WorkflowSummary } from '@shared/workflow'
import type { Store, WorkflowRow } from '../store'
import type { WorkflowRunner } from './runner'

const MAX_NAME = 100
const MAX_DESCRIPTION = 1000

const text = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${what}`)
  return v
}

/**
 * The workflows the person has made: saving them (every change to the steps is a new version), their runs and the answers a run is
 * waiting for. Running itself is the runner's.
 */
export class WorkflowService {
  constructor(
    private readonly store: Store,
    private readonly runner: WorkflowRunner,
    private readonly now: () => number = () => Date.now(),
    /** The list of workflows changed, so the window should look again. */
    private readonly changed: () => void = () => undefined
  ) {}

  private summary(w: WorkflowRow): WorkflowSummary {
    const last = this.store.listRuns(w.id, 1)[0]
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      version: w.version,
      allowAssistant: w.allowAssistant,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      ...(last ? { lastRun: { id: last.id, status: last.status, at: last.finishedAt ?? last.startedAt } } : {})
    }
  }

  private full(w: WorkflowRow): WorkflowFull {
    return { ...this.summary(w), definition: w.definition }
  }

  private require(id: unknown): WorkflowRow {
    const w = typeof id === 'string' ? this.store.getWorkflow(id) : undefined
    if (!w) throw new Error('That workflow no longer exists.')
    return w
  }

  /** Two workflows with the same name could not be told apart after a slash, so a name is used once (capitals do not count). */
  private checkName(name: string, except?: string): void {
    if (!name.trim()) throw new Error('A workflow needs a name.')
    const taken = this.store.listWorkflows().find((w) => w.id !== except && w.name.trim().toLowerCase() === name.trim().toLowerCase())
    if (taken) throw new Error(`You already have a workflow called “${taken.name}”. Choose another name.`)
  }

  readonly api: WorkflowApi = {
    'workflows.list': () => this.store.listWorkflows().map((w) => this.summary(w)),

    'workflows.get': (id) => {
      const w = typeof id === 'string' ? this.store.getWorkflow(id) : undefined
      return w ? this.full(w) : null
    },

    'workflows.save': (input) => {
      const name = text(input.name, 'name', MAX_NAME).trim()
      const description = text(input.description ?? '', 'description', MAX_DESCRIPTION)
      const problems = validateWorkflow(input.definition)
      if (problems.length) throw new Error(problems[0])
      const definition = input.definition as WorkflowDefinition
      const existing = input.id ? this.require(input.id) : undefined
      this.checkName(name, existing?.id)
      const at = this.now()
      // A change to the steps is a new version; a new name or description alone is not. The position of a step on the canvas does not count either.
      const same = existing && JSON.stringify(stripPositions(existing.definition)) === JSON.stringify(stripPositions(definition))
      const row: WorkflowRow = {
        id: existing?.id ?? `wf-${crypto.randomUUID()}`,
        name,
        description,
        version: existing ? (same ? existing.version : existing.version + 1) : 1,
        allowAssistant: existing?.allowAssistant ?? false,
        definition,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at
      }
      this.store.saveWorkflow(row)
      this.changed()
      return this.full(row)
    },

    'workflows.setAssistant': (id, allow) => {
      const w = this.require(id)
      const row = { ...w, allowAssistant: allow === true, updatedAt: this.now() }
      this.store.saveWorkflow(row)
      this.changed()
      return this.summary(row)
    },

    'workflows.remove': async (id) => {
      const w = this.require(id)
      for (const run of this.store.listRuns(w.id, 500)) if (run.status === 'running' || run.status === 'waiting') await this.runner.cancel(run.id)
      this.store.deleteWorkflow(w.id)
      this.changed()
    },

    'workflows.versions': (id) => this.store.workflowVersions(this.require(id).id),

    'workflows.version': (id, version) => this.store.workflowVersion(this.require(id).id, Number(version)) ?? null,

    'workflows.run': (id, inputs, where) => {
      const folder = text(where?.folder, 'folder', 500)
      let ok = false
      try {
        ok = statSync(folder).isDirectory()
      } catch {
        /* reported below */
      }
      if (!ok) throw new Error('Choose a folder for the run to work in.')
      return this.runner.start({ workflowId: this.require(id).id, inputs: inputs ?? {}, startedBy: 'you', folder, ...(typeof where.sessionId === 'string' ? { sessionId: where.sessionId } : {}) })
    },

    'runs.list': (workflowId) => this.store.listRuns(typeof workflowId === 'string' ? workflowId : undefined, 100),

    'runs.get': (id) => {
      const summary = typeof id === 'string' ? this.store.getRun(id) : undefined
      return summary ? { summary, events: this.store.runEvents(summary.id) } : null
    },

    'runs.cancel': (id) => this.runner.cancel(text(id, 'run', 100)),

    'runs.respondApproval': (runId, requestId, allow) => this.runner.respondApproval(text(runId, 'run', 100), text(requestId, 'request', 100), allow === true),

    'runs.respondAsk': (runId, requestId, answers) => this.runner.respondAsk(text(runId, 'run', 100), text(requestId, 'request', 100), answers as AskAnswers)
  }
}

function stripPositions(def: WorkflowDefinition): unknown {
  return { nodes: def.nodes.map(({ position: _p, ...rest }) => rest), edges: def.edges }
}

export type { RunSummary }
