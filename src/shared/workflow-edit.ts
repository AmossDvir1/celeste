import { nodeIdFrom, runOrder, type AgentNode, type ToolNode, type WorkflowDefinition, type WorkflowNode } from './workflow'

/*
 * Changes to a workflow's steps, as the editor makes them. Steps run in one line, so the editor never asks for connections: a step is
 * inserted, moved or removed, and the connections and positions follow. Every function returns a new definition and leaves the old one as
 * it was.
 */

export const STEP_WIDTH = 270

/** The steps in the order they run, or the nodes as they are listed when that order cannot be worked out. */
export function orderedNodes(def: WorkflowDefinition): WorkflowNode[] {
  const r = runOrder(def)
  return 'order' in r ? r.order : def.nodes
}

/** Connects the steps in the given order and puts them in a row. */
export function lay(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    nodes: nodes.map((n, i) => ({ ...n, position: { x: i * STEP_WIDTH, y: 0 } })),
    edges: nodes.slice(1).map((n, i) => ({ from: (nodes[i] as WorkflowNode).id, to: n.id }))
  }
}

export type NewStep = { type: 'tool'; kind: 'shell' | 'http' | 'file' | 'mcp' } | { type: 'agent' }

/** A tool step of the given kind with nothing filled in yet. */
export function blankTool(kind: 'shell' | 'http' | 'file' | 'mcp'): ToolNode['tool'] {
  return kind === 'shell'
    ? { kind: 'shell', command: '' }
    : kind === 'http'
      ? { kind: 'http', method: 'GET', url: '' }
      : kind === 'file'
        ? { kind: 'file', op: 'read', path: '' }
        : { kind: 'mcp', server: '', tool: '', args: {} }
}

export function makeStep(step: NewStep, taken: Iterable<string>): ToolNode | AgentNode {
  if (step.type === 'agent') return { id: nodeIdFrom('Ask the assistant', taken), type: 'agent', name: 'Ask the assistant', prompt: '' }
  const tool = blankTool(step.kind)
  const name = { shell: 'Run a command', http: 'Call a web address', file: 'Read a file', mcp: 'Use a tool' }[step.kind]
  return { id: nodeIdFrom(name, taken), type: 'tool', name, tool }
}

/** Puts a step after the one with `afterId`, or just before End. */
export function insertStep(def: WorkflowDefinition, node: WorkflowNode, afterId?: string): WorkflowDefinition {
  const order = orderedNodes(def)
  const at = afterId ? order.findIndex((n) => n.id === afterId) : order.length - 2
  const index = Math.min(Math.max(at, 0) + 1, order.length - 1)
  return lay([...order.slice(0, index), node, ...order.slice(index)])
}

/** Takes a step out; the ones either side are joined. Start and End stay. */
export function removeStep(def: WorkflowDefinition, id: string): WorkflowDefinition {
  const order = orderedNodes(def)
  const node = order.find((n) => n.id === id)
  if (!node || node.type === 'start' || node.type === 'end') return def
  return lay(order.filter((n) => n.id !== id))
}

/** Moves a step one place earlier (-1) or later (1), never past Start or End. */
export function moveStep(def: WorkflowDefinition, id: string, by: -1 | 1): WorkflowDefinition {
  const order = [...orderedNodes(def)]
  const from = order.findIndex((n) => n.id === id)
  const to = from + by
  const node = order[from]
  if (!node || node.type === 'start' || node.type === 'end' || to < 1 || to > order.length - 2) return def
  order.splice(from, 1)
  order.splice(to, 0, node)
  return lay(order)
}

/** Changes one step. Keeps its id: other steps refer to it. */
export function updateStep(def: WorkflowDefinition, id: string, change: (node: WorkflowNode) => WorkflowNode): WorkflowDefinition {
  return { ...def, nodes: def.nodes.map((n) => (n.id === id ? change(n) : n)) }
}

/** Applies a change to every text of a step in which {{ }} is understood. */
function mapTemplates(node: WorkflowNode, fn: (text: string) => string): WorkflowNode {
  switch (node.type) {
    case 'agent':
      return { ...node, prompt: fn(node.prompt) }
    case 'end':
      return node.output === undefined ? node : { ...node, output: fn(node.output) }
    case 'tool': {
      const t = node.tool
      if (t.kind === 'shell') return { ...node, tool: { ...t, command: fn(t.command), ...(t.cwd ? { cwd: fn(t.cwd) } : {}) } }
      if (t.kind === 'http') return { ...node, tool: { ...t, url: fn(t.url), ...(t.body ? { body: fn(t.body) } : {}), ...(t.headers ? { headers: Object.fromEntries(Object.entries(t.headers).map(([k, v]) => [k, fn(v)])) } : {}) } }
      if (t.kind === 'file') return { ...node, tool: { ...t, path: fn(t.path), ...(t.content !== undefined ? { content: fn(t.content) } : {}) } }
      return { ...node, tool: { ...t, args: Object.fromEntries(Object.entries(t.args).map(([k, v]) => [k, typeof v === 'string' ? fn(v) : v])) } }
    }
    default:
      return node
  }
}

/**
 * Gives a step a new name. Its id, which other steps use in {{nodes.id.output}}, follows the name (Start and End keep theirs), and the
 * references to it in the other steps are rewritten, so a rename never breaks anything.
 */
export function renameStep(def: WorkflowDefinition, id: string, name: string): WorkflowDefinition {
  const node = def.nodes.find((n) => n.id === id)
  if (!node) return def
  const fixed = node.type === 'start' || node.type === 'end'
  const next = fixed ? id : nodeIdFrom(name, def.nodes.filter((n) => n.id !== id).map((n) => n.id))
  if (next === id) return updateStep(def, id, (n) => ({ ...n, name }))
  const rewrite = (text: string) => text.replace(/\{\{(\s*)nodes\.([A-Za-z0-9_]+)/g, (whole, space: string, ref: string) => (ref === id ? '{{' + space + 'nodes.' + next : whole))
  return {
    nodes: def.nodes.map((n) => mapTemplates(n.id === id ? { ...n, id: next, name } : n, rewrite)),
    edges: def.edges.map((e) => ({ from: e.from === id ? next : e.from, to: e.to === id ? next : e.to }))
  }
}

/** The references a step could use, for the hint under a text box: the inputs, and the steps that run before it. */
export function referencesAvailable(def: WorkflowDefinition, id: string): string[] {
  const order = orderedNodes(def)
  const index = order.findIndex((n) => n.id === id)
  const start = order[0]
  const refs: string[] = []
  if (start?.type === 'start') for (const i of start.inputs) refs.push(`{{inputs.${i.name}}}`)
  for (const n of order.slice(1, Math.max(index, 1))) if (n.type === 'tool' || n.type === 'agent') refs.push(`{{nodes.${n.id}.output}}`)
  refs.push('{{run.folder}}')
  return refs
}
