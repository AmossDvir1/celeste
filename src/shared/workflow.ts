import type { ApprovalMode, Effort, VendorId } from './agent'

/*
 * A workflow is a saved list of steps that Celeste runs in order. It is JSON, checked against these rules whenever it is saved,
 * imported or made by the assistant, and again before it runs. Steps are nodes on a canvas, joined by edges. In this version the
 * edges must form one line from Start to End (branches come later), so "in order" is exact.
 */

export const MAX_NODES = 60
export const MAX_TEXT = 20_000
export const MAX_INPUTS = 20

export type InputType = 'text' | 'number' | 'boolean' | 'choice'

/** A question asked when the workflow is started, for example `older_than_days`. */
export interface InputDef {
  /** How steps refer to it: `{{inputs.older_than_days}}`. */
  name: string
  label?: string
  type: InputType
  default?: string | number | boolean
  required?: boolean
  /** For `choice`. */
  options?: string[]
}

export type ToolSpec =
  /** A command in the shell of this computer, or of a device. No model is involved. */
  | { kind: 'shell'; command: string; cwd?: string; deviceId?: string }
  | { kind: 'http'; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers?: Record<string, string>; body?: string }
  /** A file in the folder the run works in. */
  | { kind: 'file'; op: 'read' | 'write' | 'append'; path: string; content?: string }
  /** A tool of an MCP server the person added, by the server's name. Text values may use `{{ }}`. */
  | { kind: 'mcp'; server: string; tool: string; args: Record<string, string | number | boolean> }

export type OnError = 'stop' | 'retry' | 'continue'

export interface NodeBase {
  /** Short and stable: letters, digits and underscores. `{{nodes.find_kbs.output}}` uses it. */
  id: string
  name: string
  position?: { x: number; y: number }
}

export interface StartNode extends NodeBase {
  type: 'start'
  inputs: InputDef[]
}

export interface StepOptions {
  onError?: OnError
  /** For `retry`: how many more tries, 1 to 5. */
  retries?: number
  timeoutSec?: number
}

export interface ToolNode extends NodeBase, StepOptions {
  type: 'tool'
  tool: ToolSpec
}

export interface AgentNode extends NodeBase, StepOptions {
  type: 'agent'
  /** What the assistant is asked. May use `{{ }}`. */
  prompt: string
  vendor?: VendorId
  model?: string
  effort?: Effort
  /** How the assistant's own tools are approved while it works. */
  approval?: ApprovalMode
  /** `json`: the answer must be one JSON value, which later steps can read field by field. */
  outputFormat?: 'text' | 'json'
}

export interface EndNode extends NodeBase {
  type: 'end'
  /** What the run returns. May use `{{ }}`. Empty: the output of the step before. */
  output?: string
}

export type WorkflowNode = StartNode | ToolNode | AgentNode | EndNode
export interface WorkflowEdge {
  from: string
  to: string
}
export interface WorkflowDefinition {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** An id for a step, from its name: "Find old KBs" becomes `find_old_kbs`. */
export function nodeIdFrom(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken)
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[0-9_]+/, '').replace(/_+$/, '') || 'step').slice(0, 30)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`
}

/** The short form of a workflow's name used after a slash: "Test the app" becomes `test-the-app`. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

const ID = /^[a-z][a-z0-9_]{0,39}$/
const INPUT_NAME = /^[a-z][a-z0-9_]{0,39}$/i
const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g

/** Every `{{ reference }}` in a text, as written inside the braces. */
export function referencesIn(text: string): string[] {
  return [...text.matchAll(TEMPLATE)].map((m) => m[1] as string)
}

/** The texts of a step in which `{{ }}` is understood. */
export function templatesOf(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'agent':
      return [node.prompt]
    case 'end':
      return [node.output ?? '']
    case 'tool': {
      const t = node.tool
      if (t.kind === 'shell') return [t.command, t.cwd ?? '']
      if (t.kind === 'http') return [t.url, t.body ?? '', ...Object.values(t.headers ?? {})]
      if (t.kind === 'file') return [t.path, t.content ?? '']
      return Object.values(t.args).filter((v): v is string => typeof v === 'string')
    }
    default:
      return []
  }
}

/** The steps in the order they run, or why that order cannot be worked out. */
export function runOrder(def: WorkflowDefinition): { order: WorkflowNode[] } | { error: string } {
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const next = new Map<string, string>()
  const hasIncoming = new Set<string>()
  for (const e of def.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) return { error: 'A connection leads to a step that does not exist.' }
    if (next.has(e.from)) return { error: `“${byId.get(e.from)?.name}” has more than one step after it. Steps run in one line for now.` }
    if (hasIncoming.has(e.to)) return { error: `“${byId.get(e.to)?.name}” has more than one step before it. Steps run in one line for now.` }
    next.set(e.from, e.to)
    hasIncoming.add(e.to)
  }
  const start = def.nodes.find((n) => n.type === 'start')
  if (!start) return { error: 'There is no Start step.' }
  const order: WorkflowNode[] = []
  const seen = new Set<string>()
  for (let at: string | undefined = start.id; at; at = next.get(at)) {
    if (seen.has(at)) return { error: 'The steps go round in a circle.' }
    seen.add(at)
    order.push(byId.get(at) as WorkflowNode)
  }
  const left = def.nodes.filter((n) => !seen.has(n.id))
  if (left.length) return { error: `${left.map((n) => `“${n.name}”`).join(', ')} ${left.length === 1 ? 'is' : 'are'} not connected to the line from Start.` }
  return { order }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'

/**
 * Everything wrong with a workflow, in words for the person, or an empty list when it can run. Used on save, on import, for what the
 * assistant drafts, and again before a run, so a hand-edited file cannot get past it.
 */
export function validateWorkflow(input: unknown): string[] {
  const problems: string[] = []
  if (!isObject(input) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) return ['This is not a workflow: it needs a list of steps and a list of connections.']
  const nodes = input.nodes as unknown[]
  const edges = input.edges as unknown[]
  if (nodes.length > MAX_NODES) return [`A workflow can have at most ${MAX_NODES} steps.`]
  if (edges.length > MAX_NODES * 2) return ['There are too many connections.']

  const ids = new Set<string>()
  const clean: WorkflowNode[] = []
  for (const raw of nodes) {
    if (!isObject(raw) || !str(raw.id) || !str(raw.type)) {
      problems.push('A step has no id or type.')
      continue
    }
    const label = str(raw.name) && raw.name ? `“${raw.name}”` : `“${raw.id}”`
    if (!ID.test(raw.id)) problems.push(`${label}: the id “${raw.id}” must be lowercase letters, digits and underscores, starting with a letter.`)
    if (ids.has(raw.id)) problems.push(`Two steps have the id “${raw.id}”.`)
    ids.add(raw.id)
    if (!str(raw.name) || !raw.name.trim()) problems.push(`The step “${raw.id}” has no name.`)
    else if (raw.name.length > 100) problems.push(`${label}: the name is too long.`)
    if (raw.onError !== undefined && !['stop', 'retry', 'continue'].includes(raw.onError as string)) problems.push(`${label}: “${String(raw.onError)}” is not a way to handle errors.`)
    if (raw.retries !== undefined && !(Number.isInteger(raw.retries) && (raw.retries as number) >= 1 && (raw.retries as number) <= 5)) problems.push(`${label}: retries must be a whole number from 1 to 5.`)
    if (raw.timeoutSec !== undefined && !(typeof raw.timeoutSec === 'number' && raw.timeoutSec >= 1 && raw.timeoutSec <= 24 * 3600)) problems.push(`${label}: the time limit must be between 1 second and 24 hours.`)

    switch (raw.type) {
      case 'start': {
        const inputs = raw.inputs
        if (!Array.isArray(inputs)) {
          problems.push(`${label}: the Start step needs a list of inputs (it may be empty).`)
          break
        }
        if (inputs.length > MAX_INPUTS) problems.push(`There can be at most ${MAX_INPUTS} inputs.`)
        const names = new Set<string>()
        for (const i of inputs as unknown[]) {
          if (!isObject(i) || !str(i.name) || !INPUT_NAME.test(i.name)) {
            problems.push('An input needs a name of letters, digits and underscores.')
            continue
          }
          if (names.has(i.name)) problems.push(`Two inputs are called “${i.name}”.`)
          names.add(i.name)
          if (!['text', 'number', 'boolean', 'choice'].includes(i.type as string)) problems.push(`The input “${i.name}” has no valid type.`)
          if (i.type === 'choice' && !(Array.isArray(i.options) && i.options.length > 0 && i.options.every(str))) problems.push(`The choice “${i.name}” needs a list of options.`)
          if (i.default !== undefined && !['string', 'number', 'boolean'].includes(typeof i.default)) problems.push(`The default of “${i.name}” must be text, a number or yes/no.`)
        }
        break
      }
      case 'tool': {
        const t = raw.tool
        if (!isObject(t) || !str(t.kind)) {
          problems.push(`${label}: it does not say what to do.`)
          break
        }
        if (t.kind === 'shell') {
          if (!str(t.command) || !t.command.trim()) problems.push(`${label}: the command is empty.`)
        } else if (t.kind === 'http') {
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(t.method as string)) problems.push(`${label}: the HTTP method is not valid.`)
          if (!str(t.url) || !t.url.trim()) problems.push(`${label}: the web address is empty.`)
        } else if (t.kind === 'file') {
          if (!['read', 'write', 'append'].includes(t.op as string)) problems.push(`${label}: the file action must be read, write or append.`)
          if (!str(t.path) || !t.path.trim()) problems.push(`${label}: the file path is empty.`)
        } else if (t.kind === 'mcp') {
          if (!str(t.server) || !str(t.tool) || !t.server || !t.tool) problems.push(`${label}: it needs the tool’s server and name.`)
          if (!isObject(t.args)) problems.push(`${label}: the tool’s inputs are missing.`)
        } else problems.push(`${label}: “${t.kind}” is not a kind of tool step.`)
        break
      }
      case 'agent':
        if (!str(raw.prompt) || !raw.prompt.trim()) problems.push(`${label}: the prompt is empty.`)
        if (raw.outputFormat !== undefined && !['text', 'json'].includes(raw.outputFormat as string)) problems.push(`${label}: the answer format must be text or json.`)
        break
      case 'end':
        break
      default:
        problems.push(`${label}: “${raw.type}” is not a kind of step.`)
    }
    for (const field of ['prompt', 'output', 'command']) if (str(raw[field]) && (raw[field] as string).length > MAX_TEXT) problems.push(`${label}: the ${field} is too long.`)
    if (raw.type === 'start' || raw.type === 'tool' || raw.type === 'agent' || raw.type === 'end') clean.push(raw as unknown as WorkflowNode)
  }

  if (clean.filter((n) => n.type === 'start').length !== 1) problems.push('A workflow needs exactly one Start step.')
  if (clean.filter((n) => n.type === 'end').length !== 1) problems.push('A workflow needs exactly one End step.')

  for (const e of edges) {
    if (!isObject(e) || !str(e.from) || !str(e.to)) problems.push('A connection is missing where it starts or ends.')
  }
  if (problems.length) return problems

  const def: WorkflowDefinition = { nodes: clean, edges: edges as WorkflowEdge[] }
  const ordered = runOrder(def)
  if ('error' in ordered) return [ordered.error]
  if (ordered.order[ordered.order.length - 1]?.type !== 'end') problems.push('The line of steps must finish at the End step.')
  if (ordered.order.slice(1, -1).some((n) => n.type === 'start' || n.type === 'end')) problems.push('Start must come first and End last.')

  // `{{ }}` may use the inputs, the output of a step that runs earlier, and where the run works.
  const start = ordered.order[0] as StartNode
  const inputNames = new Set(start.type === 'start' ? start.inputs.map((i) => i.name) : [])
  const before = new Set<string>()
  for (const node of ordered.order) {
    for (const text of templatesOf(node)) {
      for (const ref of referencesIn(text)) {
        const [root, name] = ref.split('.')
        if (root === 'inputs') {
          if (!name || !inputNames.has(name)) problems.push(`“${node.name}” uses {{${ref}}}, but there is no input called “${name ?? ''}”.`)
        } else if (root === 'nodes') {
          if (!name || !before.has(name)) problems.push(`“${node.name}” uses {{${ref}}}, but that step does not run before it.`)
        } else if (root !== 'run') problems.push(`“${node.name}” uses {{${ref}}}, which is not something a step can use.`)
      }
    }
    before.add(node.id)
  }
  return problems
}

// --- templates ------------------------------------------------------------------------------------------

export interface TemplateContext {
  inputs: Record<string, string | number | boolean>
  nodes: Record<string, { output: unknown }>
  run: { folder: string }
}

const show = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/**
 * Fills in `{{ }}` from the run so far. Throws a sentence when a reference has nothing behind it. With `partial`, references to
 * steps that have not run are left as written, which is how the card shown before a run can already show the inputs.
 */
export function renderTemplate(text: string, ctx: TemplateContext, options: { partial?: boolean } = {}): string {
  return text.replace(TEMPLATE, (whole, raw: string) => {
    const path = raw.split('.')
    const [root, name, ...rest] = path
    if (options.partial && root === 'nodes') return whole
    if (root === 'run' && name === 'folder' && rest.length === 0) return ctx.run.folder
    if (root === 'inputs' && name && rest.length === 0) {
      if (!(name in ctx.inputs)) throw new Error(`There is no input called “${name}”.`)
      return show(ctx.inputs[name])
    }
    if (root === 'nodes' && name) {
      const done = ctx.nodes[name]
      if (!done) throw new Error(`The step “${name}” has not produced anything yet.`)
      if (rest[0] !== 'output') throw new Error(`Say {{nodes.${name}.output}} to use what “${name}” produced.`)
      let value: unknown = done.output
      for (const key of rest.slice(1)) {
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value)
          } catch {
            throw new Error(`“${name}” did not produce JSON, so it has no field “${key}”.`)
          }
        }
        if (!isObject(value) && !Array.isArray(value)) throw new Error(`“${name}” has no field “${key}”.`)
        value = (value as Record<string, unknown>)[key]
        if (value === undefined) throw new Error(`“${name}” has no field “${key}”.`)
      }
      return show(value)
    }
    throw new Error(`{{${raw}}} is not something a step can use.`)
  })
}

// --- inputs ---------------------------------------------------------------------------------------------

/** The person's answers, checked against what Start asks for and made into the right types. Throws a sentence. */
export function checkInputs(defs: InputDef[], given: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const d of defs) {
    const label = d.label || d.name
    let v = given[d.name]
    if (v === undefined || v === '') v = d.default
    if (v === undefined || v === '') {
      if (d.required) throw new Error(`“${label}” is needed.`)
      if (d.type === 'boolean') out[d.name] = false
      else out[d.name] = ''
      continue
    }
    if (d.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) throw new Error(`“${label}” must be a number.`)
      out[d.name] = n
    } else if (d.type === 'boolean') {
      out[d.name] = v === true || v === 'true' || v === 'yes' || v === 'on'
    } else if (d.type === 'choice') {
      if (!d.options?.includes(String(v))) throw new Error(`“${label}” must be one of: ${(d.options ?? []).join(', ')}.`)
      out[d.name] = String(v)
    } else {
      out[d.name] = String(v)
    }
  }
  return out
}

// --- what is stored and sent ---------------------------------------------------------------------------

export interface WorkflowSummary {
  id: string
  name: string
  description: string
  /** The number of the newest saved version. */
  version: number
  /** The assistant may start this one, after Celeste asks. Off unless the person switched it on. */
  allowAssistant: boolean
  createdAt: number
  updatedAt: number
  /** The last run, if any. */
  lastRun?: { id: string; status: RunStatus; at: number }
}

export interface WorkflowFull extends WorkflowSummary {
  definition: WorkflowDefinition
}

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type StartedBy = 'you' | 'menu' | 'assistant'

export interface RunSummary {
  id: string
  workflowId: string
  workflowName: string
  version: number
  status: RunStatus
  startedBy: StartedBy
  inputs: Record<string, string | number | boolean>
  /** The chat the run belongs to, when it was started from one. */
  sessionId?: string
  folder: string
  startedAt: number
  finishedAt?: number
  output?: string
  error?: string
}

/** One command, request, file change or tool call that a run will make, shown before it starts. */
export interface PlannedAction {
  nodeId: string
  nodeName: string
  kind: 'shell' | 'http' | 'file' | 'mcp' | 'agent'
  /** For example the command, or `POST https://…`. Steps that use an earlier result still show `{{ }}`. */
  text: string
  /** Where a shell command runs: a device's name, or absent for this computer. */
  where?: string
}

export type RunEvent =
  | { type: 'run.started'; inputs: Record<string, string | number | boolean> }
  /** Everything the run will do, before it does any of it. The run waits for an answer. */
  | { type: 'approval.requested'; requestId: string; actions: PlannedAction[] }
  | { type: 'approval.resolved'; requestId: string; allow: boolean }
  | { type: 'node.started'; nodeId: string; attempt: number }
  | { type: 'node.output'; nodeId: string; text: string }
  | { type: 'node.retrying'; nodeId: string; attempt: number; error: string }
  | { type: 'node.completed'; nodeId: string; output: string }
  /** A step failed and the run goes on (the step's error handling is Continue). */
  | { type: 'node.skipped'; nodeId: string; error: string }
  | { type: 'node.failed'; nodeId: string; error: string }
  /** An agent step is waiting for the person: a tool it wants to use, or a question. */
  | { type: 'agent.approval'; nodeId: string; requestId: string; title: string; detail?: string }
  | { type: 'agent.approval.resolved'; nodeId: string; requestId: string; allow: boolean }
  | { type: 'agent.ask'; nodeId: string; requestId: string; questions: unknown }
  | { type: 'agent.ask.answered'; nodeId: string; requestId: string }
  | { type: 'run.completed'; output: string }
  | { type: 'run.failed'; error: string }
  | { type: 'run.cancelled' }

export interface StoredRunEvent {
  seq: number
  at: number
  event: RunEvent
}
