import { validateWorkflow, slugify, type AgentNode, type EndNode, type StartNode, type ToolNode, type WorkflowDefinition, type WorkflowNode } from './workflow'

/*
 * The file a workflow is shared as: `.celeste-workflow.json`. It holds the steps and nothing about this computer: no folder, no device,
 * no position on the canvas, and no value of a header that looks like a secret. Reading one back checks it as strictly as a workflow
 * made by hand, keeps only the fields Celeste knows, and says what will not work here.
 */

export const FILE_FORMAT = 'celeste-workflow'
export const FILE_VERSION = 1
export const FILE_EXTENSION = '.celeste-workflow.json'
export const MAX_FILE_BYTES = 1_000_000

/** Header names whose values are taken out when a workflow is shared. */
const SECRET_HEADER = /authori[sz]ation|token|secret|key|password|passwd|cookie|credential|signature|session/i

export interface WorkflowFile {
  format: typeof FILE_FORMAT
  version: number
  name: string
  description: string
  definition: WorkflowDefinition
}

/** Only the fields Celeste knows, so a hand-edited file cannot carry anything else along. */
function clean(node: WorkflowNode): WorkflowNode {
  const base = { id: node.id, name: node.name, ...(node.description ? { description: node.description } : {}) }
  const options = (n: ToolNode | AgentNode) => ({ ...(n.onError ? { onError: n.onError } : {}), ...(n.retries !== undefined ? { retries: n.retries } : {}), ...(n.timeoutSec !== undefined ? { timeoutSec: n.timeoutSec } : {}) })
  switch (node.type) {
    case 'start':
      return { ...base, type: 'start', inputs: node.inputs.map((i) => ({ name: i.name, type: i.type, ...(i.label ? { label: i.label } : {}), ...(i.default !== undefined ? { default: i.default } : {}), ...(i.required ? { required: true } : {}), ...(i.options ? { options: [...i.options] } : {}) })) } satisfies StartNode
    case 'end':
      return { ...base, type: 'end', ...(node.output ? { output: node.output } : {}) } satisfies EndNode
    case 'agent':
      return {
        ...base,
        type: 'agent',
        prompt: node.prompt,
        ...(node.vendor ? { vendor: node.vendor } : {}),
        ...(node.model ? { model: node.model } : {}),
        ...(node.effort ? { effort: node.effort } : {}),
        ...(node.approval ? { approval: node.approval } : {}),
        ...(node.outputFormat ? { outputFormat: node.outputFormat } : {}),
        ...options(node)
      } satisfies AgentNode
    case 'tool': {
      const t = node.tool
      const tool: ToolNode['tool'] =
        t.kind === 'shell'
          ? { kind: 'shell', command: t.command, ...(t.cwd ? { cwd: t.cwd } : {}), ...(t.deviceId ? { deviceId: t.deviceId } : {}) }
          : t.kind === 'http'
            ? { kind: 'http', method: t.method, url: t.url, ...(t.headers ? { headers: { ...t.headers } } : {}), ...(t.body ? { body: t.body } : {}) }
            : t.kind === 'file'
              ? { kind: 'file', op: t.op, path: t.path, ...(t.content !== undefined ? { content: t.content } : {}) }
              : { kind: 'mcp', server: t.server, tool: t.tool, args: { ...t.args } }
      return { ...base, type: 'tool', tool, ...options(node) } satisfies ToolNode
    }
  }
}

/** Lays the definition out as the file keeps it: in running order, without positions. */
function plain(def: WorkflowDefinition): WorkflowDefinition {
  return { nodes: def.nodes.map(clean), edges: def.edges.map((e) => ({ from: e.from, to: e.to })) }
}

/** The text to save, and what was taken out of it. */
export function toFile(name: string, description: string, def: WorkflowDefinition): { text: string; filename: string; notes: string[] } {
  const notes: string[] = []
  const definition = plain(def)
  for (const node of definition.nodes) {
    if (node.type !== 'tool') continue
    const t = node.tool
    if (t.kind === 'shell' && t.deviceId) {
      // A device exists only on this computer.
      notes.push(`“${node.name}” ran on a device of yours. The file leaves the device out, so whoever opens it chooses one.`)
      delete t.deviceId
    }
    if (t.kind === 'http' && t.headers) {
      for (const [k, v] of Object.entries(t.headers)) {
        if (SECRET_HEADER.test(k) && v && !/^\{\{[^}]*\}\}$/.test(v.trim())) {
          t.headers[k] = ''
          notes.push(`The value of the “${k}” header in “${node.name}” was left out of the file.`)
        }
      }
    }
  }
  const file: WorkflowFile = { format: FILE_FORMAT, version: FILE_VERSION, name, description, definition }
  return { text: `${JSON.stringify(file, null, 2)}\n`, filename: `${slugify(name) || 'workflow'}${FILE_EXTENSION}`, notes }
}

/** What reading a file gives: the workflow, ready to open as an unsaved draft, and things worth knowing about it. */
export interface ReadFile {
  name: string
  description: string
  definition: WorkflowDefinition
  notes: string[]
}

/** Reads a shared file. Throws a sentence when it is not one, or when the steps in it are not valid. */
export function fromFile(text: string, known: { mcpServers?: string[] } = {}): ReadFile {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('That file is too large to be a workflow.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That is not a workflow file: it is not JSON.')
  }
  const file = raw as Partial<WorkflowFile> | null
  if (!file || typeof file !== 'object' || file.format !== FILE_FORMAT) throw new Error('That is not a Celeste workflow file.')
  if (typeof file.version !== 'number' || file.version > FILE_VERSION) throw new Error('That file was made by a newer Celeste. Update Celeste to open it.')
  if (typeof file.name !== 'string' || !file.name.trim()) throw new Error('That workflow file has no name.')
  const problems = validateWorkflow(file.definition)
  if (problems.length) throw new Error(`That workflow cannot be used: ${problems.slice(0, 3).join(' ')}`)
  const definition = plain(file.definition as WorkflowDefinition)
  const notes: string[] = []
  const servers = new Set((known.mcpServers ?? []).map((s) => s.toLowerCase()))
  for (const node of definition.nodes) {
    if (node.type !== 'tool') continue
    const t = node.tool
    // A device is a thing on one computer: a file from another one cannot name one that is here.
    if (t.kind === 'shell' && t.deviceId) {
      delete t.deviceId
      notes.push(`“${node.name}” named a device. It now runs on this computer; change that in the step if it should run elsewhere.`)
    }
    if (t.kind === 'mcp' && known.mcpServers && !servers.has(t.server.toLowerCase())) notes.push(`“${node.name}” uses the tools “${t.server}”, which are not in your tools yet. Add them in Settings, Tools & Integrations.`)
    if (t.kind === 'http' && t.headers) {
      for (const [k, v] of Object.entries(t.headers)) if (SECRET_HEADER.test(k) && !v) notes.push(`“${node.name}” needs a value for its “${k}” header.`)
    }
  }
  // Said once, however many steps there are.
  const unique = [...new Set(notes)]
  return { name: file.name.trim().slice(0, 100), description: typeof file.description === 'string' ? file.description.slice(0, 1000) : '', definition: lay(definition), notes: unique }
}

/** Puts the steps in a row. A file may have no positions, or ones made on a different screen. */
function lay(def: WorkflowDefinition): WorkflowDefinition {
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const next = new Map(def.edges.map((e) => [e.from, e.to]))
  const start = def.nodes.find((n) => n.type === 'start')
  const order: WorkflowNode[] = []
  for (let at = start?.id; at; at = next.get(at)) order.push(byId.get(at) as WorkflowNode)
  return {
    nodes: order.map((n, i) => ({ ...n, position: { x: i * 270, y: 0 } })),
    edges: def.edges.map((e) => ({ from: e.from, to: e.to }))
  }
}
