import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AskAnswers } from '@shared/agent'
import type { WorkflowApi } from '@shared/api'
import { fromFile, toFile } from '@shared/workflow-file'
import type { Drafted } from './draft'
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
    private readonly changed: () => void = () => undefined,
    /** Where Celeste keeps its data. A run that is given no folder works in a private one of its own under it. */
    private readonly dataDir?: string,
    /** The names of the tool servers the person has, so an imported workflow can say which of its tools are missing. */
    private readonly toolNames?: () => Promise<string[]>,
    /** The folder a conversation works in, for a run started from it. */
    private readonly folderOfSession?: (sessionId: string) => string,
    /** Asks an assistant to draft a workflow. */
    private readonly drafter?: (source: { kind: 'text'; text: string } | { kind: 'conversation'; sessionId: string }) => Promise<Drafted>
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

    'workflows.export': (id) => {
      const w = this.require(id)
      return toFile(w.name, w.description, w.definition)
    },

    'workflows.import': async (text) => {
      if (typeof text !== 'string') throw new Error('That is not a workflow file.')
      const read = fromFile(text, { mcpServers: this.toolNames ? await this.toolNames() : undefined })
      return read
    },

    'workflows.draft': async (source) => {
      if (!this.drafter) throw new Error('No assistant is connected. Connect one in Settings, AI vendors.')
      if (source?.kind === 'text') {
        const wanted = text(source.text, 'description', 8000).trim()
        if (wanted.length < 8) throw new Error('Say a little more about what the workflow should do.')
        return this.drafter({ kind: 'text', text: wanted })
      }
      if (source?.kind === 'conversation') return this.drafter({ kind: 'conversation', sessionId: text(source.sessionId, 'conversation', 100) })
      throw new Error('Say what to make the workflow from.')
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
      const workflow = this.require(id)
      const sessionId = typeof where?.sessionId === 'string' ? where.sessionId : undefined
      // Started from a conversation, it works where that conversation does, unless another folder was chosen.
      const given = text(where?.folder, 'folder', 500) || (sessionId && this.folderOfSession ? this.folderOfSession(sessionId) : '')
      // No folder: a private one for this workflow, so a workflow that only needs somewhere to put files has it.
      const folder = given || (this.dataDir ? join(this.dataDir, 'workflows', workflow.id) : '')
      if (!given && folder) mkdirSync(folder, { recursive: true })
      let ok = false
      try {
        ok = statSync(folder).isDirectory()
      } catch {
        /* reported below */
      }
      if (!ok) throw new Error('Choose a folder for the run to work in.')
      return this.runner.start({ workflowId: workflow.id, inputs: inputs ?? {}, startedBy: where.startedBy === 'menu' ? 'menu' : 'you', folder, ...(sessionId ? { sessionId } : {}) })
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
