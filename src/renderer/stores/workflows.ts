import { create } from 'zustand'
import { GRAPHS, cloneGraph, makeGraph, type FlowGraph } from '@/features/workflows/graph'

export interface WorkflowSummary {
  id: string
  name: string
  description: string
  icon: 'workflow' | 'package' | 'activity' | 'file' | 'terminal'
  template?: boolean
}

export const MY_WORKFLOWS: WorkflowSummary[] = [
  { id: 'update-old-kbs', name: 'Update old KBs', description: 'Find WFO KBs older than a threshold and install the newest release build of each.', icon: 'workflow' },
  { id: 'vm-health', name: 'VM health check', description: 'Check disk, memory and service state on every WFO VM.', icon: 'workflow' },
  { id: 'build-patch', name: 'Build & patch', description: 'Build the latest service image and roll it out to staging.', icon: 'package' },
  { id: 'fresh-vm', name: 'Prepare fresh VM', description: 'Provision a VM and install the baseline tools.', icon: 'package' },
  { id: 'restart-wfo', name: 'Restart WFO service', description: 'Restart the service and wait until it is healthy.', icon: 'workflow' }
]

export const TEMPLATES: WorkflowSummary[] = [
  { id: 'tpl-deploy', name: 'Deploy application', description: 'Build, test and deploy an application.', icon: 'package', template: true },
  { id: 'tpl-health', name: 'Health check', description: 'Probe endpoints and report problems.', icon: 'activity', template: true },
  { id: 'tpl-report', name: 'Daily report', description: 'Collect yesterday’s numbers and write a summary.', icon: 'file', template: true },
  { id: 'tpl-patch', name: 'Patch management', description: 'Find missing patches and install them in waves.', icon: 'package', template: true },
  { id: 'tpl-logs', name: 'Log analysis', description: 'Search logs for a pattern and explain what changed.', icon: 'terminal', template: true }
]

interface WorkflowsState {
  mine: WorkflowSummary[]
  graphs: Record<string, FlowGraph>
  versions: Record<string, string>
  activeId: string
  open: (id: string) => void
  setGraph: (id: string, graph: FlowGraph) => void
  rename: (id: string, name: string) => void
  save: (id: string) => string
  /** A copy of a template or a new empty workflow, opened right away. */
  createFrom: (templateId: string | null, name?: string, graph?: FlowGraph) => string
  remove: (id: string) => void
}

const ALL_META = [...MY_WORKFLOWS, ...TEMPLATES]

export const useWorkflows = create<WorkflowsState>((set, get) => ({
  mine: MY_WORKFLOWS,
  graphs: Object.fromEntries(Object.entries(GRAPHS).map(([id, g]) => [id, cloneGraph(g)])),
  versions: {},
  activeId: 'update-old-kbs',

  open: (activeId) => set({ activeId }),

  setGraph: (id, graph) => set((s) => ({ graphs: { ...s.graphs, [id]: graph } })),

  rename: (id, name) => {
    const clean = name.trim()
    if (clean) set((s) => ({ mine: s.mine.map((w) => (w.id === id ? { ...w, name: clean } : w)) }))
  },

  save: (id) => {
    const cur = get().versions[id] ?? 'v1.0'
    const minor = Number(cur.split('.')[1] ?? 0) + 1
    const next = `v1.${minor}`
    set((s) => ({ versions: { ...s.versions, [id]: next } }))
    return next
  },

  createFrom: (templateId, name, graph) => {
    const source = templateId ? ALL_META.find((w) => w.id === templateId) : undefined
    const id = `wf-${Date.now().toString(36)}`
    const summary: WorkflowSummary = {
      id,
      name: name ?? (source ? source.name : 'Untitled workflow'),
      description: source?.description ?? 'A new workflow.',
      icon: source?.icon ?? 'workflow'
    }
    const g = graph ?? (templateId && get().graphs[templateId] ? cloneGraph(get().graphs[templateId]) : makeGraph([]))
    set((s) => ({ mine: [...s.mine, summary], graphs: { ...s.graphs, [id]: g }, activeId: id }))
    return id
  },

  remove: (id) =>
    set((s) => {
      const mine = s.mine.filter((w) => w.id !== id)
      return { mine, activeId: s.activeId === id ? (mine[0]?.id ?? 'update-old-kbs') : s.activeId }
    })
}))

export function workflowMeta(id: string, mine: WorkflowSummary[]): WorkflowSummary | undefined {
  return mine.find((w) => w.id === id) ?? TEMPLATES.find((w) => w.id === id)
}
