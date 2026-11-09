import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Bot, Clock, FileText, Globe, History, MoreHorizontal, MousePointer2, Play, Plug, Plus, Save, Share2, Smartphone, Sparkles, Terminal, Trash2 } from 'lucide-react'
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeChange } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { core } from '@/api'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Modal } from '@/components/Dialog'
import { Menu } from '@/components/menu'
import { Badge, Button, IconButton, TextInput } from '@/components/ui'
import { insertStep, makeStep, orderedNodes, STEP_WIDTH, type NewStep } from '@shared/workflow-edit'
import { foldRun, stateOf } from '@shared/workflow-run'
import type { RunSummary, StartNode } from '@shared/workflow'
import { formatDay, formatTime, sameDay } from '@/lib/format'
import { useRuns } from '@/stores/runs'
import { isDirty, problemsOf, useWorkflows } from '@/stores/workflows'
import { NodeDetails } from './NodeDetails'
import { BuildDialog } from './BuildDialog'
import { RunDialog } from './RunDialog'
import { RunPanel } from './RunPanel'
import { metaOf, StepNode, type StepData } from './steps'

const nodeTypes = { step: StepNode }

function Canvas() {
  const def = useWorkflows((s) => s.draft?.definition)
  const selected = useWorkflows((s) => s.selectedNode)
  const select = useWorkflows((s) => s.selectNode)
  const flow = useReactFlow()

  const order = useMemo(() => (def ? orderedNodes(def) : []), [def])
  // While a run is shown, each step lights up as the run reaches it.
  const run = useRuns((s) => (s.watching ? s.runs[s.watching] : undefined))
  const view = useMemo(() => (run ? foldRun(run.events) : undefined), [run])
  const nodes = useMemo<Node[]>(
    () =>
      order.map(
        (step, index): StepData => ({
          id: step.id,
          type: 'step',
          // Steps run in a line, so the line is laid out here whatever positions a file came with (an imported one may have none).
          position: { x: index * STEP_WIDTH, y: 0 },
          data: { step, selected: step.id === selected, state: view ? stateOf(view, step.id) : undefined, waiting: view?.waiting !== undefined && 'nodeId' in view.waiting && view.waiting.nodeId === step.id },
          draggable: false,
          connectable: false,
          selected: step.id === selected,
          ariaLabel: `${step.name}, ${metaOf(step).label}. Press Enter to change it.`
        })
      ),
    [order, selected, view]
  )
  const edges = useMemo<Edge[]>(
    () =>
      (def?.edges ?? []).map((e) => ({
        id: `${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        selectable: false,
        focusable: false,
        style: { stroke: 'var(--c-accent)', strokeWidth: 1.6 },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--c-accent)', width: 16, height: 16 }
      })),
    [def]
  )

  // The canvas reports a step being selected (by a click, or Enter or Space on a step with keyboard focus) as a change to its nodes.
  const onChanges = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type !== 'select' || !c.selected) continue
        // While a run is shown a step opens its result in the run; otherwise its details.
        if (useRuns.getState().watching) useRuns.getState().focus(c.id)
        else if (c.id !== useWorkflows.getState().selectedNode) select(c.id)
      }
    },
    [select]
  )

  // A new step, or one taken away, changes how much has to fit.
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.25, maxZoom: 1, duration: 200 }), 30)
    return () => clearTimeout(t)
  }, [order.length, flow, selected === null, run === undefined])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.5}
      onNodeClick={(_, n) => (useRuns.getState().watching ? useRuns.getState().focus(n.id) : select(n.id))}
      onNodesChange={onChanges}
      onPaneClick={() => select(null)}
      aria-label="The steps of this workflow, in the order they run"
    >
      <Background gap={22} size={1.2} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  )
}

const ADD: { label: string; icon: typeof Terminal; step: NewStep }[] = [
  { label: 'Run a command', icon: Terminal, step: { type: 'tool', kind: 'shell' } },
  { label: 'Call a web address', icon: Globe, step: { type: 'tool', kind: 'http' } },
  { label: 'Read or write a file', icon: FileText, step: { type: 'tool', kind: 'file' } },
  { label: 'Use a tool from your tools', icon: Plug, step: { type: 'tool', kind: 'mcp' } },
  { label: 'Ask the assistant', icon: Sparkles, step: { type: 'agent' } },
  { label: 'Use the computer', icon: MousePointer2, step: { type: 'agent', computer: true } },
  { label: 'Use the phone', icon: Smartphone, step: { type: 'agent', phone: true } }
]

function AddStep() {
  const edit = useWorkflows((s) => s.edit)
  const select = useWorkflows((s) => s.selectNode)
  const after = useWorkflows((s) => s.selectedNode)
  const add = (step: NewStep) => {
    const def = useWorkflows.getState().draft?.definition
    if (!def) return
    const node = makeStep(step, def.nodes.map((n) => n.id))
    // After the step that is open, when there is one; Start and End are not places to insert after (End is not, Start is).
    const at = after && def.nodes.find((n) => n.id === after)?.type !== 'end' ? after : undefined
    edit((d) => insertStep(d, node, at))
    select(node.id)
  }
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button variant="secondary" size="md">
          <Plus className="h-4 w-4" /> Add a step
        </Button>
      </Menu.Trigger>
      <Menu.Content align="start" className="w-[260px]">
        <Menu.Label>{after ? 'Added after the open step' : 'Added before End'}</Menu.Label>
        {ADD.map(({ label, icon: Icon, step }) => (
          <Menu.Item key={label} onSelect={() => add(step)}>
            <Icon className="h-4 w-4 text-ink-muted" /> {label}
          </Menu.Item>
        ))}
      </Menu.Content>
    </Menu.Root>
  )
}

/** Every run of this workflow, newest first. Choosing one shows it beside the canvas. */
function RunHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const history = useRuns((s) => s.history)
  const watch = useRuns((s) => s.watch)
  const [list, setList] = useState<RunSummary[] | null>(null)
  useEffect(() => {
    void history(id).then(setList)
  }, [id, history])
  const STATUS: Record<string, string> = { running: 'Running', waiting: 'Waiting', completed: 'Finished', failed: 'Failed', cancelled: 'Stopped' }
  return (
    <Modal open onOpenChange={(next) => !next && onClose()} title="Run history" className="w-[min(520px,calc(100vw-48px))]">
      <div className="px-6 pt-2 pb-5">
        {list && list.length === 0 && <p className="text-[13px] text-ink-muted">This workflow has not been run yet.</p>}
        <ul aria-label="Runs" className="mt-1 max-h-[50vh] divide-y divide-edge/70 overflow-y-auto rounded-xl border border-edge">
          {(list ?? []).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  watch(r.id)
                  onClose()
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover"
              >
                <span className="flex-1 text-[14px] text-ink">
                  {STATUS[r.status] ?? r.status}
                  <span className="ml-2 text-[12.5px] text-ink-muted">version {r.version}</span>
                </span>
                <span className="text-[12.5px] text-ink-muted">{sameDay(r.startedAt, Date.now()) ? formatTime(r.startedAt) : `${formatDay(r.startedAt)}, ${formatTime(r.startedAt)}`}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Versions({ id, current, onClose }: { id: string; current: number; onClose: () => void }) {
  const restore = useWorkflows((s) => s.restore)
  const [list, setList] = useState<{ version: number; createdAt: number }[] | null>(null)
  useEffect(() => {
    void core.call('workflows.versions', id).then(setList, () => setList([]))
  }, [id])
  return (
    <Modal open onOpenChange={(next) => !next && onClose()} title="Versions" className="w-[min(460px,calc(100vw-48px))]">
      <div className="px-6 pt-2 pb-5">
        <p className="text-[13px] text-ink-muted">Every change to the steps is saved as a new version. Restoring one puts its steps on the canvas; save to keep them as the newest version.</p>
        <ul aria-label="Saved versions" className="mt-3 divide-y divide-edge/70 rounded-xl border border-edge">
          {(list ?? []).map((v) => (
            <li key={v.version} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex-1 text-[14px] text-ink">
                Version {v.version}
                {v.version === current && <span className="ml-2 text-xs text-ink-faint">newest</span>}
              </span>
              <span className="text-[12.5px] text-ink-muted">{new Date(v.createdAt).toLocaleString()}</span>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Restore version ${v.version}`}
                disabled={v.version === current}
                onClick={() => {
                  void restore(v.version)
                  onClose()
                }}
              >
                Restore
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function WorkflowEditor() {
  const draft = useWorkflows((s) => s.draft)
  const selected = useWorkflows((s) => s.selectedNode)
  const select = useWorkflows((s) => s.selectNode)
  const setName = useWorkflows((s) => s.setName)
  const setDescription = useWorkflows((s) => s.setDescription)
  const close = useWorkflows((s) => s.close)
  const save = useWorkflows((s) => s.save)
  const remove = useWorkflows((s) => s.remove)
  const share = useWorkflows((s) => s.share)
  const setAssistant = useWorkflows((s) => s.setAssistant)
  const assistantMay = useWorkflows((s) => s.list.find((w) => w.id === s.draft?.id)?.allowAssistant === true)
  const [building, setBuilding] = useState(false)
  const [versions, setVersions] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [history, setHistory] = useState(false)
  const watching = useRuns((s) => s.watching)
  const watch = useRuns((s) => s.watch)
  // Another workflow's run has nothing to do with this canvas.
  useEffect(() => {
    watch(null)
  }, [draft?.id, watch])
  if (!draft) return null
  const dirty = isDirty(draft)
  const problems = problemsOf(draft)

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <section aria-label="Workflow" className="relative flex min-w-0 flex-1 flex-col">
        <h1 className="sr-only">{draft.name.trim() || 'New workflow'}</h1>
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2 px-1 pb-3">
          <IconButton label="Back to all workflows" onClick={close}>
            <ArrowLeft className="h-[18px] w-[18px]" />
          </IconButton>
          <div className="min-w-[220px] flex-1">
            <div className="flex items-center gap-2">
              <TextInput
                aria-label="Workflow name"
                value={draft.name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 max-w-[420px] border-transparent bg-transparent px-1 text-[22px] font-semibold hover:border-edge focus:border-accent-edge"
              />
              {draft.version > 0 && <Badge>{`v${draft.version}`}</Badge>}
              {assistantMay && <Badge tone="accent">Assistant may run this</Badge>}
              {dirty && <span className="text-xs text-accent-text">Unsaved changes</span>}
            </div>
            <TextInput
              aria-label="Workflow description"
              placeholder="What does this workflow do?"
              value={draft.description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-8 border-transparent bg-transparent px-1 text-[13px] text-ink-muted hover:border-edge focus:border-accent-edge"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {draft.id && (
              <Menu.Root>
                <Menu.Trigger asChild>
                  <IconButton label="More about this workflow">
                    <MoreHorizontal className="h-[18px] w-[18px]" />
                  </IconButton>
                </Menu.Trigger>
                <Menu.Content align="end" className="w-[220px]">
                  <Menu.Item onSelect={() => void setAssistant(!assistantMay)}>
                    <Bot className="h-4 w-4 text-ink-muted" /> {assistantMay ? 'Do not let the assistant run this' : 'Allow the assistant to run this'}
                  </Menu.Item>
                  <Menu.Item onSelect={() => setHistory(true)}>
                    <Clock className="h-4 w-4 text-ink-muted" /> Run history
                  </Menu.Item>
                  <Menu.Item onSelect={() => setVersions(true)}>
                    <History className="h-4 w-4 text-ink-muted" /> Versions
                  </Menu.Item>
                  <Menu.Item onSelect={() => setDeleting(true)}>
                    <Trash2 className="h-4 w-4 text-danger" /> Delete this workflow
                  </Menu.Item>
                </Menu.Content>
              </Menu.Root>
            )}
            {draft.id && (
              <Button variant="secondary" disabled={dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => void share()}>
                <Share2 className="h-4 w-4" /> Share
              </Button>
            )}
            <Button
              variant="primary"
              disabled={saving || (!dirty && draft.version > 0)}
              title={problems[0]}
              onClick={async () => {
                setSaving(true)
                await save()
                setSaving(false)
              }}
            >
              <Save className="h-4 w-4" /> Save
            </Button>
            <Button
              variant="primary"
              disabled={saving || problems.length > 0}
              title={problems[0]}
              onClick={async () => {
                // It runs what is on the screen: if that has not been saved, it is saved first, so the run and the version agree.
                if (dirty || !draft.id) {
                  setSaving(true)
                  const ok = await save()
                  setSaving(false)
                  if (!ok) return
                }
                setRunning(true)
              }}
            >
              <Play className="h-4 w-4" /> Run
            </Button>
          </div>
        </header>

        {problems.length > 0 && (
          <div role="status" className="mx-1 mb-2 rounded-lg border border-edge bg-field px-3 py-2 text-[12.5px] text-ink-muted">
            <span className="text-ink">To save: </span>
            {problems[0]}
            {problems.length > 1 && ` (and ${problems.length - 1} more)`}
          </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-edge bg-panel">
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
          <div className="absolute top-3 left-3 z-10">
            <AddStep />
          </div>
          <div className="absolute right-4 bottom-8 z-10">
            <Button variant="secondary" size="lg" onClick={() => setBuilding(true)} className="border-accent-edge">
              <Sparkles className="h-4 w-4 text-accent-text" /> Build with AI
            </Button>
          </div>
        </div>
      </section>

      {selected && !watching && <NodeDetails id={selected} onClose={() => select(null)} />}

      {watching && <RunPanel runId={watching} onClose={() => watch(null)} onRunAgain={() => setRunning(true)} />}
      {running && draft.id && (
        <RunDialog
          workflowId={draft.id}
          name={draft.name}
          inputs={(draft.definition.nodes.find((n): n is StartNode => n.type === 'start')?.inputs) ?? []}
          onClose={() => setRunning(false)}
        />
      )}
      {building && <BuildDialog onClose={() => setBuilding(false)} />}
      {history && draft.id && <RunHistory id={draft.id} onClose={() => setHistory(false)} />}
      {versions && draft.id && <Versions id={draft.id} current={draft.version} onClose={() => setVersions(false)} />}
      <ConfirmDialog
        open={deleting}
        title="Delete this workflow?"
        confirmLabel="Delete it"
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false)
          if (draft.id) void remove(draft.id)
        }}
      >
        “{draft.name}” is deleted with all its versions and its history of runs. This cannot be undone.
      </ConfirmDialog>
    </div>
  )
}
