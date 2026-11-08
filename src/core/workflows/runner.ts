import { mkdirSync, readFileSync, appendFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { ApprovalMode, AskAnswers, Effort, Question, VendorId } from '@shared/agent'
import type { CorePush } from '@shared/api'
import type { DeviceRecord } from '@shared/devices'
import {
  checkInputs,
  renderTemplate,
  runOrder,
  validateWorkflow,
  type AgentNode,
  type PlannedAction,
  type RunEvent,
  type RunSummary,
  type StartedBy,
  type StartNode,
  type TemplateContext,
  type ToolNode,
  type ToolSpec,
  type WorkflowDefinition,
  type WorkflowNode
} from '@shared/workflow'
import type { ResolvedMcpServer } from '../mcp'
import type { Store } from '../store'
import { runProcess, textOf, type Exec } from '../devices/exec'

/*
 * Runs a workflow: its steps one after another, each seeing what the earlier ones produced. Nothing starts before the person has
 * seen everything the run will do (the approval card) and allowed it. Every event is saved as it happens, so a run can be shown live
 * and read afterwards, and a run that was in progress when Celeste closed is marked as such the next time.
 */

const DEFAULT_TIMEOUT_SEC = 300
const OUTPUT_LIMIT = 200_000
const READ_LIMIT = 1_000_000

/** What an agent step needs from the outside: a model that answers, and a way to ask the person. */
export interface AgentStepRequest {
  prompt: string
  vendor?: VendorId
  model?: string
  effort?: Effort
  approval: ApprovalMode
  cwd: string
  signal: AbortSignal
  /** The assistant wants to use a tool. Resolves with the person's answer. */
  askApproval(title: string, detail?: string): Promise<boolean>
  /** The assistant asks the person a question. */
  askQuestions(questions: Question[]): Promise<AskAnswers>
}
export interface AgentStepRunner {
  run(request: AgentStepRequest): Promise<string>
}

export interface DeviceCommands {
  get(id: string): DeviceRecord | undefined
  run(device: DeviceRecord, command: string, options: { timeoutMs: number; signal: AbortSignal }): Promise<{ output: string; exitCode: number | null; timedOut: boolean; cancelled: boolean }>
}

export interface McpCaller {
  /** The enabled server the person calls by this name. */
  find(name: string): Promise<ResolvedMcpServer | undefined>
  call(server: ResolvedMcpServer, tool: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<{ text: string; isError: boolean }>
}

export interface RunnerDeps {
  store: Store
  push: (p: CorePush) => void
  agent: AgentStepRunner
  mcp: McpCaller
  devices?: DeviceCommands
  exec?: Exec
  fetch?: typeof fetch
  now?: () => number
  newId?: () => string
  /** How long to wait before trying a step again. Tests make it instant. */
  pause?: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
}

export interface StartRequest {
  workflowId: string
  inputs: Record<string, unknown>
  startedBy: StartedBy
  /** Where the run works: the chat's folder, or one the person chose. */
  folder: string
  sessionId?: string
  /** A saved version other than the newest. */
  version?: number
  /** Show the card that asks first even when there is nothing to list on it, as for a run the assistant started. */
  forceApproval?: boolean
}

class Stopped extends Error {}

interface Active {
  forceApproval: boolean
  run: RunSummary
  abort: AbortController
  /** Cards the run is waiting on, so that cancelling can answer them. */
  waiting: Map<string, (answer: unknown) => void>
  finished: Promise<void>
}

const clip = (text: string) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[cut: only the first ${OUTPUT_LIMIT} characters are kept]` : text)
const sentence = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class WorkflowRunner {
  private readonly active = new Map<string, Active>()

  constructor(private readonly deps: RunnerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private record(runId: string, event: RunEvent): void {
    const stored = this.deps.store.appendRunEvent(runId, this.now(), event)
    this.deps.push({ type: 'runEvent', runId, stored })
  }

  private setStatus(a: Active, status: RunSummary['status'], extra: Partial<Pick<RunSummary, 'output' | 'error'>> = {}): void {
    const finished = status !== 'running' && status !== 'waiting'
    a.run = { ...a.run, status, ...extra, ...(finished ? { finishedAt: this.now() } : {}) }
    this.deps.store.patchRun(a.run.id, { status, ...extra, ...(finished ? { finishedAt: a.run.finishedAt } : {}) })
    this.deps.push({ type: 'run', run: a.run })
  }

  /** Runs that were going when Celeste closed did not finish. Called once at start-up. */
  markAbandoned(): void {
    for (const run of this.deps.store.listRuns(undefined, 500)) {
      if (run.status !== 'running' && run.status !== 'waiting') continue
      this.deps.store.patchRun(run.id, { status: 'failed', error: 'Celeste was closed while this was running.', finishedAt: this.now() })
      this.deps.store.appendRunEvent(run.id, this.now(), { type: 'run.failed', error: 'Celeste was closed while this was running.' })
    }
  }

  /**
   * Checks the workflow and the answers, then starts the run and returns at once; it goes on by itself and reports through
   * `run` and `runEvent` pushes. Throws a sentence when it cannot start.
   */
  async start(req: StartRequest): Promise<RunSummary> {
    const { store } = this.deps
    const wf = store.getWorkflow(req.workflowId)
    if (!wf) throw new Error('That workflow no longer exists.')
    const version = req.version ?? wf.version
    const def = version === wf.version ? wf.definition : store.workflowVersion(wf.id, version)
    if (!def) throw new Error(`Version ${version} of “${wf.name}” is not saved.`)
    const problems = validateWorkflow(def)
    if (problems.length) throw new Error(`“${wf.name}” cannot run: ${problems[0]}`)
    const order = (runOrder(def) as { order: WorkflowNode[] }).order
    const startNode = order[0] as StartNode
    const inputs = checkInputs(startNode.inputs, req.inputs ?? {})
    await this.checkReady(order)

    const id = (this.deps.newId ?? (() => `run-${crypto.randomUUID()}`))()
    const run: RunSummary = {
      id,
      workflowId: wf.id,
      workflowName: wf.name,
      version,
      status: 'running',
      startedBy: req.startedBy,
      inputs,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      folder: req.folder,
      startedAt: this.now()
    }
    store.insertRun(run)
    const active: Active = { run, forceApproval: req.forceApproval === true, abort: new AbortController(), waiting: new Map(), finished: Promise.resolve() }
    this.active.set(id, active)
    this.deps.push({ type: 'run', run })
    this.record(id, { type: 'run.started', inputs })
    active.finished = this.execute(active, def, order, inputs).finally(() => this.active.delete(id))
    return run
  }

  /** What would make a run fail before it began, found now so nothing is half done: missing tools, devices that are read only. */
  private async checkReady(order: WorkflowNode[]): Promise<void> {
    for (const node of order) {
      if (node.type !== 'tool') continue
      const t = node.tool
      if (t.kind === 'mcp' && !(await this.deps.mcp.find(t.server))) {
        throw new Error(`“${node.name}” uses the tool server “${t.server}”, which is not in your tools (or is switched off).`)
      }
      if (t.kind === 'shell' && t.deviceId) {
        const d = this.deps.devices?.get(t.deviceId)
        if (!d) throw new Error(`“${node.name}” runs on a device that no longer exists.`)
        if (d.accessLevel === 'read') throw new Error(`“${node.name}” runs on ${d.name}, which is read only. Change its access in Settings, Devices.`)
      }
    }
  }

  /** Resolves with the run once it has ended, or undefined if it is still going after `ms`. */
  async whenFinished(runId: string, ms: number): Promise<RunSummary | undefined> {
    const a = this.active.get(runId)
    if (a) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), ms)))
      const done = await Promise.race([a.finished.then(() => 'done' as const), late])
      clearTimeout(timer)
      if (done === 'late') return undefined
    }
    const run = this.deps.store.getRun(runId)
    return run && run.status !== 'running' && run.status !== 'waiting' ? run : undefined
  }

  async cancel(runId: string): Promise<void> {
    const a = this.active.get(runId)
    if (!a) return
    a.abort.abort()
    for (const answer of a.waiting.values()) answer(undefined)
    await a.finished
  }

  respondApproval(runId: string, requestId: string, allow: boolean): void {
    const a = this.active.get(runId)
    const answer = a?.waiting.get(requestId)
    if (!a || !answer) throw new Error('That question has already been answered.')
    a.waiting.delete(requestId)
    answer(allow)
  }

  respondAsk(runId: string, requestId: string, answers: AskAnswers): void {
    const a = this.active.get(runId)
    const answer = a?.waiting.get(requestId)
    if (!a || !answer) throw new Error('That question has already been answered.')
    a.waiting.delete(requestId)
    answer(answers)
  }

  /** Waits for the person: the run shows as waiting meanwhile. Resolves undefined if the run is cancelled. */
  private waitFor<T>(a: Active, requestId: string): Promise<T | undefined> {
    this.setStatus(a, 'waiting')
    return new Promise<T | undefined>((resolveAnswer) => {
      a.waiting.set(requestId, (answer) => {
        if (a.run.status === 'waiting') this.setStatus(a, 'running')
        resolveAnswer(answer as T | undefined)
      })
    })
  }

  // --- the run --------------------------------------------------------------------------------------

  private async execute(a: Active, def: WorkflowDefinition, order: WorkflowNode[], inputs: RunSummary['inputs']): Promise<void> {
    const ctx: TemplateContext = { inputs, nodes: {}, run: { folder: a.run.folder } }
    try {
      const actions = this.plan(order, ctx)
      if (actions.length || a.forceApproval) {
        const requestId = `approve-${crypto.randomUUID()}`
        this.record(a.run.id, { type: 'approval.requested', requestId, actions })
        const allow = await this.waitFor<boolean>(a, requestId)
        this.record(a.run.id, { type: 'approval.resolved', requestId, allow: allow === true })
        if (allow !== true) throw new Stopped()
      }

      let last = ''
      for (const node of order) {
        if (a.abort.signal.aborted) throw new Stopped()
        if (node.type === 'start') {
          this.record(a.run.id, { type: 'node.started', nodeId: node.id, attempt: 1 })
          this.record(a.run.id, { type: 'node.completed', nodeId: node.id, output: '' })
          ctx.nodes[node.id] = { output: '' }
          continue
        }
        if (node.type === 'end') {
          const output = node.output?.trim() ? renderTemplate(node.output, ctx) : last
          this.record(a.run.id, { type: 'node.started', nodeId: node.id, attempt: 1 })
          this.record(a.run.id, { type: 'node.completed', nodeId: node.id, output })
          this.record(a.run.id, { type: 'run.completed', output })
          this.setStatus(a, 'completed', { output })
          return
        }
        const output = await this.runStep(a, node, ctx)
        ctx.nodes[node.id] = { output }
        last = output
      }
      throw new Error('The workflow has no End step.')
    } catch (err) {
      if (err instanceof Stopped || a.abort.signal.aborted) {
        this.record(a.run.id, { type: 'run.cancelled' })
        this.setStatus(a, 'cancelled')
      } else {
        const error = sentence(err)
        this.record(a.run.id, { type: 'run.failed', error })
        this.setStatus(a, 'failed', { error })
      }
    }
    void def
  }

  /** One step, with its time limit and its way of handling errors. Returns what it produced; throws to stop the run. */
  private async runStep(a: Active, node: ToolNode | AgentNode, ctx: TemplateContext): Promise<string> {
    const attempts = node.onError === 'retry' ? 1 + (node.retries ?? 1) : 1
    let lastError = ''
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (a.abort.signal.aborted) throw new Stopped()
      this.record(a.run.id, { type: 'node.started', nodeId: node.id, attempt })
      const limit = new AbortController()
      const timeoutMs = (node.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000
      const timer = setTimeout(() => limit.abort(new Error(`It took longer than ${node.timeoutSec ?? DEFAULT_TIMEOUT_SEC} seconds.`)), timeoutMs)
      const signal = AbortSignal.any([a.abort.signal, limit.signal])
      try {
        const output = clip(node.type === 'tool' ? await this.runTool(node.tool, ctx, a, signal, timeoutMs) : await this.runAgent(node, ctx, a, signal))
        if (signal.aborted) throw signal.reason instanceof Error && !a.abort.signal.aborted ? signal.reason : new Stopped()
        this.record(a.run.id, { type: 'node.completed', nodeId: node.id, output })
        return output
      } catch (err) {
        if (a.abort.signal.aborted) throw new Stopped()
        lastError = limit.signal.aborted && limit.signal.reason instanceof Error ? limit.signal.reason.message : sentence(err)
        if (attempt < attempts) {
          this.record(a.run.id, { type: 'node.retrying', nodeId: node.id, attempt: attempt + 1, error: lastError })
          await (this.deps.pause ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(Math.min(5000, 1000 * attempt))
        }
      } finally {
        clearTimeout(timer)
      }
    }
    if (node.onError === 'continue') {
      this.record(a.run.id, { type: 'node.skipped', nodeId: node.id, error: lastError })
      return ''
    }
    this.record(a.run.id, { type: 'node.failed', nodeId: node.id, error: lastError })
    throw new Error(`“${node.name}” failed: ${lastError}`)
  }

  // --- what each kind of step does ----------------------------------------------------------------------

  /** Everything the run will do, with the inputs filled in and results of earlier steps still as `{{ }}`. */
  plan(order: WorkflowNode[], ctx: TemplateContext): PlannedAction[] {
    const fill = (text: string) => renderTemplate(text, ctx, { partial: true })
    const out: PlannedAction[] = []
    for (const node of order) {
      if (node.type === 'tool') {
        const t = node.tool
        const base = { nodeId: node.id, nodeName: node.name }
        if (t.kind === 'shell') {
          const device = t.deviceId ? this.deps.devices?.get(t.deviceId) : undefined
          out.push({ ...base, kind: 'shell', text: fill(t.command), ...(device ? { where: device.name } : {}) })
        } else if (t.kind === 'http') out.push({ ...base, kind: 'http', text: `${t.method} ${fill(t.url)}` })
        else if (t.kind === 'file' && t.op !== 'read') out.push({ ...base, kind: 'file', text: `${t.op === 'write' ? 'Write' : 'Add to'} ${fill(t.path)}` })
        else if (t.kind === 'mcp') out.push({ ...base, kind: 'mcp', text: `${t.server}: ${t.tool}` })
      } else if (node.type === 'agent') {
        out.push({ nodeId: node.id, nodeName: node.name, kind: 'agent', text: `Ask the assistant (tools: ${node.approval ?? 'ask'}): ${fill(node.prompt).slice(0, 300)}` })
      }
    }
    return out
  }

  private inFolder(folder: string, path: string): string {
    const base = resolve(folder)
    const full = resolve(base, path)
    if (full !== base && !full.startsWith(base + sep)) throw new Error(`“${path}” is outside the folder this run works in.`)
    return full
  }

  private async runTool(t: ToolSpec, ctx: TemplateContext, a: Active, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const fill = (text: string) => renderTemplate(text, ctx)
    switch (t.kind) {
      case 'shell': {
        const command = fill(t.command)
        if (t.deviceId) {
          const device = this.deps.devices?.get(t.deviceId)
          if (!device || !this.deps.devices) throw new Error('That device no longer exists.')
          if (device.accessLevel === 'read') throw new Error(`${device.name} is read only.`)
          const r = await this.deps.devices.run(device, command, { timeoutMs, signal })
          if (r.cancelled) throw new Stopped()
          if (r.timedOut) throw new Error(`It was still running after ${Math.round(timeoutMs / 1000)} seconds.`)
          if (r.exitCode !== 0) throw new Error(`Exit code ${r.exitCode}. ${r.output.trim().slice(-500)}`.trim())
          return r.output.trimEnd()
        }
        const cwd = t.cwd?.trim() ? this.inFolder(a.run.folder, fill(t.cwd)) : a.run.folder
        const win = (this.deps.platform ?? process.platform) === 'win32'
        const [file, args] = win ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['/bin/sh', ['-c', command]]
        const r = await (this.deps.exec ?? runProcess)(file as string, args as string[], { cwd, timeoutMs, signal })
        if (r.cancelled) throw new Stopped()
        if (r.missing) throw new Error('The shell could not be started.')
        if (r.timedOut) throw new Error(`It was still running after ${Math.round(timeoutMs / 1000)} seconds.`)
        const out = textOf(r.stdout).trimEnd()
        if (r.code !== 0) throw new Error(`Exit code ${r.code}. ${(textOf(r.stderr).trim() || out).slice(-500)}`.trim())
        return out
      }
      case 'http': {
        const url = new URL(fill(t.url))
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be used.')
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(t.headers ?? {})) headers[k] = fill(v)
        const res = await (this.deps.fetch ?? fetch)(url, { method: t.method, headers, ...(t.body && t.method !== 'GET' ? { body: fill(t.body) } : {}), signal })
        const text = (await res.text()).slice(0, READ_LIMIT)
        if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}. ${text.slice(0, 300)}`.trim())
        return text
      }
      case 'file': {
        const path = this.inFolder(a.run.folder, fill(t.path))
        if (t.op === 'read') {
          if (statSync(path).size > READ_LIMIT) throw new Error('That file is larger than 1 MB.')
          return readFileSync(path, 'utf8')
        }
        const content = fill(t.content ?? '')
        mkdirSync(dirname(path), { recursive: true })
        if (t.op === 'write') writeFileSync(path, content)
        else appendFileSync(path, content)
        return `${t.op === 'write' ? 'Wrote' : 'Added'} ${Buffer.byteLength(content)} bytes to ${t.path}.`
      }
      case 'mcp': {
        const server = await this.deps.mcp.find(t.server)
        if (!server) throw new Error(`The tool server “${t.server}” is not in your tools (or is switched off).`)
        const args: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(t.args)) args[k] = typeof v === 'string' ? fill(v) : v
        const r = await this.deps.mcp.call(server, t.tool, args, timeoutMs, signal)
        if (r.isError) throw new Error(r.text || 'The tool reported an error.')
        return r.text
      }
    }
  }

  private async runAgent(node: AgentNode, ctx: TemplateContext, a: Active, signal: AbortSignal): Promise<string> {
    const prompt = renderTemplate(node.prompt, ctx) + (node.outputFormat === 'json' ? '\n\nAnswer with one JSON value and nothing else.' : '')
    const text = await this.deps.agent.run({
      prompt,
      vendor: node.vendor,
      model: node.model,
      effort: node.effort,
      approval: node.approval ?? 'ask',
      cwd: a.run.folder,
      signal,
      askApproval: async (title, detail) => {
        const requestId = `agent-${crypto.randomUUID()}`
        this.record(a.run.id, { type: 'agent.approval', nodeId: node.id, requestId, title, ...(detail ? { detail } : {}) })
        const allow = (await this.waitFor<boolean>(a, requestId)) === true
        this.record(a.run.id, { type: 'agent.approval.resolved', nodeId: node.id, requestId, allow })
        return allow
      },
      askQuestions: async (questions) => {
        const requestId = `ask-${crypto.randomUUID()}`
        this.record(a.run.id, { type: 'agent.ask', nodeId: node.id, requestId, questions })
        const answers = await this.waitFor<AskAnswers>(a, requestId)
        if (!answers) throw new Stopped()
        this.record(a.run.id, { type: 'agent.ask.answered', nodeId: node.id, requestId })
        return answers
      }
    })
    if (node.outputFormat === 'json') {
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      try {
        JSON.parse(cleaned)
      } catch {
        throw new Error('The assistant did not answer with JSON.')
      }
      return cleaned
    }
    return text.trim()
  }
}
