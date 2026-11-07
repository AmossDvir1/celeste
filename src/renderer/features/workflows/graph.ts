import type { Edge, Node } from '@xyflow/react'

export type StepKind = 'start' | 'tool' | 'agent' | 'end'
export type IconKey =
  | 'play'
  | 'square'
  | 'search'
  | 'download'
  | 'clock'
  | 'file'
  | 'box'
  | 'bot'
  | 'mail'
  | 'database'
  | 'server'
  | 'terminal'
  | 'shield'
  | 'activity'

export interface InputDef {
  id: string
  name: string
  label: string
  value: string
  required: boolean
}

export type RunStatus = 'pending' | 'running' | 'done' | 'error'

export interface StepData extends Record<string, unknown> {
  kind: StepKind
  title: string
  description: string
  icon: IconKey
  /** Tool steps call an MCP tool or a built-in directly, with no model involved. */
  tool?: string
  inputs: InputDef[]
  /** Agent steps run a prompt with a chosen model. */
  prompt?: string
  model?: string
  approval?: 'auto' | 'edits' | 'ask'
  onError: 'stop' | 'retry' | 'continue'
  timeoutSeconds: number
  /** The simulated run asks before this step. */
  confirm?: string
  status?: RunStatus
}

export type StepNode = Node<StepData, 'step'>
export type FlowGraph = { nodes: StepNode[]; edges: Edge[] }

export const TOOL_CHOICES = ['WFO KB Scanner', 'KB Installer', 'Service Waiter', 'Report Builder', 'Run shell command', 'HTTP request', 'Read file']
export const MODEL_CHOICES = ['Copilot Auto', 'Claude Sonnet', 'GPT-5', 'Gemini Pro']

let seq = 0
export const newId = (p: string) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`

export interface StepSpec {
  kind: 'tool' | 'agent'
  title: string
  description: string
  icon: IconKey
  tool?: string
  inputs?: Omit<InputDef, 'id'>[]
  prompt?: string
  confirm?: string
}

export const STEP_X0 = 132
export const STEP_GAP = 178

/** Lays steps out left to right between a Start and an End node. */
export function makeGraph(steps: StepSpec[], startInputs: Omit<InputDef, 'id'>[] = []): FlowGraph {
  const nodes: StepNode[] = []
  const base = { onError: 'stop' as const, timeoutSeconds: 300 }

  nodes.push({
    id: 'start',
    type: 'step',
    position: { x: 0, y: 36 },
    data: { ...base, kind: 'start', title: 'Start', description: 'Where the workflow begins.', icon: 'play', inputs: startInputs.map((i) => ({ ...i, id: newId('in') })) }
  })

  steps.forEach((s, i) => {
    nodes.push({
      id: `step-${i + 1}`,
      type: 'step',
      position: { x: STEP_X0 + i * STEP_GAP, y: 0 },
      data: {
        ...base,
        kind: s.kind,
        title: s.title,
        description: s.description,
        icon: s.icon,
        tool: s.kind === 'tool' ? (s.tool ?? TOOL_CHOICES[0]) : undefined,
        prompt: s.prompt,
        model: s.kind === 'agent' ? 'Copilot Auto' : undefined,
        approval: s.kind === 'agent' ? 'auto' : undefined,
        confirm: s.confirm,
        inputs: (s.inputs ?? []).map((inp) => ({ ...inp, id: newId('in') }))
      }
    })
  })

  nodes.push({
    id: 'end',
    type: 'step',
    position: { x: STEP_X0 + steps.length * STEP_GAP, y: 36 },
    data: { ...base, kind: 'end', title: 'End', description: 'The workflow output.', icon: 'square', inputs: [] }
  })

  const edges: Edge[] = nodes.slice(0, -1).map((n, i) => ({ id: `e-${n.id}-${nodes[i + 1].id}`, source: n.id, target: nodes[i + 1].id, type: 'default' }))
  return { nodes, edges }
}

export const GRAPHS: Record<string, FlowGraph> = {
  'update-old-kbs': makeGraph(
    [
      {
        kind: 'tool',
        title: 'Find old KBs',
        description: 'List KBs older than configured threshold.',
        icon: 'search',
        tool: 'WFO KB Scanner',
        inputs: [{ name: 'older_than_days', label: 'Older than (days)', value: '365', required: true }]
      },
      { kind: 'tool', title: 'Install updates', description: 'Install the latest release build for each KB.', icon: 'download', tool: 'KB Installer', confirm: 'Install the newest build of 14 KBs on 3 hosts?' },
      { kind: 'tool', title: 'Wait for service', description: 'Wait until WFO is running and healthy.', icon: 'clock', tool: 'Service Waiter' },
      { kind: 'agent', title: 'Summarize', description: 'Create a summary of updated KBs.', icon: 'file', prompt: 'Summarize which KBs were updated, on which hosts, and whether the service came back healthy.' }
    ],
    [{ name: 'older_than_days', label: 'Older than (days)', value: '365', required: true }]
  ),
  'vm-health': makeGraph([
    { kind: 'tool', title: 'List VMs', description: 'Get every WFO virtual machine.', icon: 'server', tool: 'Run shell command' },
    { kind: 'tool', title: 'Check resources', description: 'Disk, memory and CPU per VM.', icon: 'activity', tool: 'HTTP request' },
    { kind: 'agent', title: 'Report', description: 'Explain which VMs need attention.', icon: 'file', prompt: 'List the VMs that are low on disk or memory and suggest what to do.' }
  ]),
  'build-patch': makeGraph([
    { kind: 'tool', title: 'Build image', description: 'Build the latest service image.', icon: 'box', tool: 'Run shell command' },
    { kind: 'tool', title: 'Run tests', description: 'Stop if any test fails.', icon: 'shield', tool: 'Run shell command' },
    { kind: 'tool', title: 'Roll out', description: 'Deploy to staging.', icon: 'download', tool: 'KB Installer', confirm: 'Deploy build 2.4.1 to staging?' }
  ]),
  'fresh-vm': makeGraph([
    { kind: 'tool', title: 'Create VM', description: 'Provision from the baseline image.', icon: 'server', tool: 'Run shell command' },
    { kind: 'tool', title: 'Install tools', description: 'Install the baseline tools.', icon: 'download', tool: 'KB Installer' }
  ]),
  'restart-wfo': makeGraph([
    { kind: 'tool', title: 'Restart service', description: 'Restart the WFO service.', icon: 'terminal', tool: 'Run shell command', confirm: 'Restart the WFO service on wfo-vm-17?' },
    { kind: 'tool', title: 'Wait for service', description: 'Wait until it is healthy.', icon: 'clock', tool: 'Service Waiter' }
  ]),
  'tpl-deploy': makeGraph([
    { kind: 'tool', title: 'Build', description: 'Build the application.', icon: 'box', tool: 'Run shell command' },
    { kind: 'tool', title: 'Test', description: 'Run the test suite.', icon: 'shield', tool: 'Run shell command' },
    { kind: 'tool', title: 'Deploy', description: 'Roll out to the target.', icon: 'download', tool: 'KB Installer', confirm: 'Deploy to production?' }
  ]),
  'tpl-health': makeGraph([
    { kind: 'tool', title: 'Probe endpoints', description: 'Call each health endpoint.', icon: 'activity', tool: 'HTTP request' },
    { kind: 'agent', title: 'Summarize', description: 'Report what is unhealthy.', icon: 'file', prompt: 'Summarize which endpoints failed and why.' }
  ]),
  'tpl-report': makeGraph([
    { kind: 'tool', title: 'Collect numbers', description: 'Pull yesterday’s numbers.', icon: 'database', tool: 'HTTP request' },
    { kind: 'agent', title: 'Write summary', description: 'Turn the numbers into a short report.', icon: 'file', prompt: 'Write a five-line summary of yesterday’s numbers.' },
    { kind: 'tool', title: 'Send email', description: 'Email the report.', icon: 'mail', tool: 'HTTP request', confirm: 'Send the report to the team?' }
  ]),
  'tpl-patch': makeGraph([
    { kind: 'tool', title: 'Find missing patches', description: 'Scan hosts for missing patches.', icon: 'search', tool: 'WFO KB Scanner' },
    { kind: 'tool', title: 'Install in waves', description: 'Canary first, then the rest.', icon: 'download', tool: 'KB Installer', confirm: 'Install patches on the canary hosts?' },
    { kind: 'tool', title: 'Verify', description: 'Wait for health checks.', icon: 'clock', tool: 'Service Waiter' }
  ]),
  'tpl-logs': makeGraph([
    { kind: 'tool', title: 'Search logs', description: 'Find the pattern in the log window.', icon: 'search', tool: 'Run shell command', inputs: [{ name: 'pattern', label: 'Pattern', value: 'ERROR', required: true }] },
    { kind: 'agent', title: 'Explain', description: 'Say what changed and why.', icon: 'file', prompt: 'Explain what the matching log lines have in common.' }
  ])
}

export function cloneGraph(g: FlowGraph): FlowGraph {
  return JSON.parse(JSON.stringify(g)) as FlowGraph
}
