import { useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange
} from '@xyflow/react'
import {
  ArrowLeft,
  Bot,
  Copy,
  Maximize,
  Minus,
  MousePointer2,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Search,
  Share2,
  Sparkles,
  SquareTerminal,
  Square,
  Trash2,
  Hand
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Modal } from '@/components/Dialog'
import { Field, TextArea } from '@/components/form'
import { Logo } from '@/components/Logo'
import { Menu } from '@/components/menu'
import { Badge, Button, IconButton, Spinner, TextInput, Tip } from '@/components/ui'
import { GlowArc } from '@/glow/GlowArc'
import { useUi } from '@/stores/ui'
import { useWorkflows, workflowMeta } from '@/stores/workflows'
import { NodeDetails } from './NodeDetails'
import { STEP_GAP, STEP_X0, makeGraph, newId, type FlowGraph, type RunStatus, type StepData, type StepNode, type StepSpec } from './graph'
import { nodeTypes } from './nodes'

type RunState = 'idle' | 'running' | 'paused' | 'finished' | 'stopped'
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function RunChip({ state, step, total }: { state: RunState; step: number; total: number }) {
  if (state === 'idle') return null
  const map = {
    running: { text: `Running · step ${step} of ${total}`, tone: 'info' as const },
    paused: { text: 'Paused · waiting for you', tone: 'warning' as const },
    finished: { text: 'Last run succeeded', tone: 'success' as const },
    stopped: { text: 'Last run stopped', tone: 'warning' as const }
  }[state]
  return <Badge tone={map.tone}>{state === 'running' && <Spinner className="h-3 w-3" />}{map.text}</Badge>
}

/** Turns a plain description into a draft: each clause becomes a Tool step. Real Build with AI uses an agent. */
function draftFromPrompt(prompt: string): { name: string; steps: StepSpec[] } {
  const clauses = prompt
    .split(/,|;|\bthen\b|\band then\b|\bafter that\b|\band\b/i)
    .map((c) => c.trim().replace(/[.]+$/, ''))
    .filter((c) => c.length > 2)
    .slice(0, 4)
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const steps: StepSpec[] = (clauses.length ? clauses : ['Do the work']).map((c, i, all) => ({
    kind: i === all.length - 1 && /summar|report|explain|write|email/i.test(c) ? 'agent' : 'tool',
    title: cap(c).length > 24 ? `${cap(c).slice(0, 23)}…` : cap(c),
    description: cap(c),
    icon: i === all.length - 1 && /summar|report|explain|write/i.test(c) ? 'file' : 'terminal',
    prompt: /summar|report|explain|write/i.test(c) ? cap(c) : undefined
  }))
  return { name: cap(clauses[0] ?? 'New workflow').slice(0, 32), steps }
}

function BuildWithAi({ open, onOpenChange, onBuild }: { open: boolean; onOpenChange: (o: boolean) => void; onBuild: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const examples = ['Every morning, collect yesterday’s numbers, write a summary, then email the team', 'Find missing patches, install them on canary hosts, wait for the service and report']

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Build with AI"
      description="Describe what should happen. You get a draft to review before anything runs."
      className="w-[min(600px,calc(100vw-48px))]"
    >
      <div className="space-y-4 px-6 pt-4 pb-6">
        <TextArea
          autoFocus
          rows={4}
          value={prompt}
          aria-label="Describe the workflow"
          placeholder="For example: find old KBs, install the newest builds, wait for the service, then summarize"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setPrompt(ex)}
              className="rounded-full border border-edge-strong px-3 py-1.5 text-left text-[12.5px] text-ink-muted hover:border-accent-edge hover:text-ink"
            >
              {ex}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!prompt.trim() || busy}
            onClick={async () => {
              setBusy(true)
              await sleep(1600)
              onBuild(prompt)
              setBusy(false)
              setPrompt('')
              onOpenChange(false)
            }}
          >
            {busy ? (
              <>
                <Spinner className="h-4 w-4 text-white" /> Drafting…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> Build draft
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Editor({ id }: { id: string }) {
  const mine = useWorkflows((s) => s.mine)
  const graph = useWorkflows((s) => s.graphs[id]) as FlowGraph
  const setGraph = useWorkflows((s) => s.setGraph)
  const rename = useWorkflows((s) => s.rename)
  const save = useWorkflows((s) => s.save)
  const version = useWorkflows((s) => s.versions[id] ?? 'v1.0')
  const createFrom = useWorkflows((s) => s.createFrom)
  const remove = useWorkflows((s) => s.remove)
  const setMode = useUi((s) => s.setMode)
  const pushToast = useUi((s) => s.pushToast)
  const rf = useReactFlow()

  const meta = workflowMeta(id, mine)
  const isTemplate = !!meta?.template
  const [tool, setTool] = useState<'select' | 'pan'>('select')
  const [status, setStatus] = useState<Record<string, RunStatus>>({})
  const [runState, setRunState] = useState<RunState>('idle')
  const [paused, setPaused] = useState<{ nodeId: string; question: string } | null>(null)
  const [runInputs, setRunInputs] = useState(false)
  const [buildOpen, setBuildOpen] = useState(false)
  const [title, setTitle] = useState(meta?.name ?? '')
  const token = useRef(0)
  const resume = useRef<((go: boolean) => void) | null>(null)

  const ordered = useMemo(() => [...graph.nodes].sort((a, b) => a.position.x - b.position.x), [graph.nodes])
  const doneCount = Object.values(status).filter((s) => s === 'done').length

  const nodes = useMemo<StepNode[]>(
    () =>
      graph.nodes.map((n) => ({
        ...n,
        deletable: n.data.kind !== 'start' && n.data.kind !== 'end',
        data: { ...n.data, status: status[n.id] }
      })),
    [graph.nodes, status]
  )
  const edges = useMemo(
    () => graph.edges.map((e) => ({ ...e, animated: runState === 'running' && status[e.target] === 'running' })),
    [graph.edges, status, runState]
  )
  const selected = graph.nodes.find((n) => n.selected) ?? null

  const commit = (next: Partial<FlowGraph>) => setGraph(id, { ...graph, ...next })
  const patchNode = (nodeId: string, patch: Partial<StepData>) =>
    commit({ nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)) })

  const addStep = (kind: 'tool' | 'agent') => {
    const end = graph.nodes.find((n) => n.data.kind === 'end')
    const steps = graph.nodes.filter((n) => n.data.kind === 'tool' || n.data.kind === 'agent')
    const last = steps.sort((a, b) => a.position.x - b.position.x).at(-1) ?? graph.nodes.find((n) => n.data.kind === 'start')
    if (!end || !last) return
    const nid = newId('step')
    const node: StepNode = {
      id: nid,
      type: 'step',
      position: { x: last.data.kind === 'start' ? STEP_X0 : last.position.x + STEP_GAP, y: 0 },
      selected: true,
      data: {
        kind,
        title: kind === 'agent' ? 'New agent step' : 'New tool step',
        description: kind === 'agent' ? 'Describe what the agent should do.' : 'Describe what this step does.',
        icon: kind === 'agent' ? 'bot' : 'terminal',
        tool: kind === 'tool' ? 'Run shell command' : undefined,
        model: kind === 'agent' ? 'Copilot Auto' : undefined,
        approval: kind === 'agent' ? 'auto' : undefined,
        prompt: kind === 'agent' ? '' : undefined,
        inputs: [],
        onError: 'stop',
        timeoutSeconds: 300
      }
    }
    commit({
      nodes: [...graph.nodes.map((n) => ({ ...n, selected: false })).map((n) => (n.id === end.id ? { ...n, position: { x: node.position.x + STEP_GAP, y: 36 } } : n)), node],
      edges: [
        ...graph.edges.filter((e) => !(e.source === last.id && e.target === end.id)),
        { id: `e-${last.id}-${nid}`, source: last.id, target: nid },
        { id: `e-${nid}-${end.id}`, source: nid, target: end.id }
      ]
    })
    setTimeout(() => rf.fitView({ padding: 0.1, maxZoom: 1.05, duration: 300 }), 50)
  }

  const run = async () => {
    const t = ++token.current
    setStatus({})
    setRunState('running')
    for (const n of ordered) {
      if (t !== token.current) return
      setStatus((s) => ({ ...s, [n.id]: 'running' }))
      if (n.data.confirm) {
        setRunState('paused')
        setPaused({ nodeId: n.id, question: n.data.confirm })
        const go = await new Promise<boolean>((resolve) => (resume.current = resolve))
        setPaused(null)
        if (t !== token.current) return
        if (!go) {
          setStatus((s) => ({ ...s, [n.id]: 'error' }))
          setRunState('stopped')
          return
        }
        setRunState('running')
      }
      await sleep(n.data.kind === 'start' || n.data.kind === 'end' ? 450 : 1300)
      setStatus((s) => ({ ...s, [n.id]: 'done' }))
    }
    if (t !== token.current) return
    setRunState('finished')
    pushToast({ text: `${meta?.name ?? 'Workflow'} finished` })
  }
  const stop = () => {
    token.current += 1
    resume.current?.(false)
    setPaused(null)
    setRunState('stopped')
    setStatus((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v === 'running' ? 'error' : v])))
  }
  const startInputs = graph.nodes.find((n) => n.data.kind === 'start')?.data.inputs ?? []
  const active = runState === 'running' || runState === 'paused'

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 gap-3">
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-edge bg-panel">
        <header className="relative z-10 flex min-h-[78px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge/70 px-5 py-3">
          <IconButton label="Back to Chat" onClick={() => setMode('chat')}>
            <ArrowLeft className="h-[18px] w-[18px]" />
          </IconButton>
          <Logo size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              {isTemplate ? (
                <h1 className="truncate text-[22px] font-semibold text-ink">{meta?.name}</h1>
              ) : (
                <input
                  value={title}
                  aria-label="Workflow name"
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => (title.trim() ? rename(id, title) : setTitle(meta?.name ?? ''))}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  className="min-w-0 max-w-full rounded-md bg-transparent px-1 text-[22px] font-semibold text-ink outline-offset-2 hover:bg-hover focus:bg-hover"
                  size={Math.max(8, title.length)}
                />
              )}
              <Badge tone={isTemplate ? 'info' : 'accent'}>{isTemplate ? 'Template' : version}</Badge>
            </div>
            <div className="flex items-center gap-2.5 px-1">
              <p className="min-w-0 truncate text-[13px] text-ink-muted">{meta?.description}</p>
              <RunChip state={runState} step={Math.min(doneCount + 1, ordered.length)} total={ordered.length} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!isTemplate && (
              <Menu.Root>
                <Menu.Trigger asChild>
                  <IconButton label="More actions" className="h-10 w-10 border border-edge-strong">
                    <MoreHorizontal className="h-[18px] w-[18px]" />
                  </IconButton>
                </Menu.Trigger>
                <Menu.Content align="end" className="w-[190px]">
                  <Menu.Item onSelect={() => createFrom(id, `${meta?.name ?? 'Workflow'} copy`)}>
                    <Copy className="h-4 w-4 text-ink-muted" /> Duplicate
                  </Menu.Item>
                  <Menu.Item onSelect={() => pushToast({ text: `Exported ${meta?.name}.celeste-workflow.json (no secrets included)` })}>
                    <Share2 className="h-4 w-4 text-ink-muted" /> Export as file
                  </Menu.Item>
                  <Menu.Separator />
                  <Menu.Item
                    className="text-danger"
                    onSelect={() => {
                      remove(id)
                      pushToast({ text: `Deleted “${meta?.name}”` })
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </Menu.Item>
                </Menu.Content>
              </Menu.Root>
            )}
            <Button variant="secondary" size="lg" className="h-10" onClick={() => pushToast({ text: `Exported ${meta?.name}.celeste-workflow.json` })}>
              <Share2 className="h-4 w-4" /> Share
            </Button>
            {isTemplate ? (
              <Button variant="primary" size="lg" className="h-10" onClick={() => createFrom(id)}>
                <Plus className="h-4 w-4" /> Use this template
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="lg" className="h-10" onClick={() => pushToast({ text: `Saved as ${save(id)}` })}>
                  <Save className="h-4 w-4" /> Save
                </Button>
                {active ? (
                  <Button variant="danger" size="lg" className="h-10 min-w-[96px]" onClick={stop}>
                    <Square className="h-3.5 w-3.5 fill-current" /> Stop
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="lg"
                    className="h-10 min-w-[96px]"
                    onClick={() => (startInputs.length ? setRunInputs(true) : void run())}
                  >
                    <Play className="h-4 w-4 fill-current" /> Run
                  </Button>
                )}
              </>
            )}
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <GlowArc className="[transform:scale(-1,-1)] opacity-60" />
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(c: NodeChange<StepNode>[]) => commit({ nodes: applyNodeChanges(c, graph.nodes) })}
            onEdgesChange={(c: EdgeChange[]) => commit({ edges: applyEdgeChanges(c, graph.edges) })}
            onConnect={(c: Connection) => commit({ edges: addEdge(c, graph.edges) })}
            nodesDraggable={!isTemplate}
            nodesConnectable={!isTemplate}
            elementsSelectable
            panOnDrag={tool === 'pan' ? true : [1, 2]}
            selectionOnDrag={false}
            fitView
            fitViewOptions={{ padding: 0.1, maxZoom: 1.05 }}
            minZoom={0.3}
            maxZoom={1.6}
            deleteKeyCode={isTemplate ? null : ['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
            className="!bg-transparent"
            aria-label="Workflow canvas"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--c-edge-strong)" />
          </ReactFlow>

          {!isTemplate && (
            <div className="absolute top-4 left-4 z-10">
              <Menu.Root>
                <Menu.Trigger asChild>
                  <Button variant="secondary" size="sm" className="bg-raised-2/80 backdrop-blur">
                    <Plus className="h-4 w-4" /> Add step
                  </Button>
                </Menu.Trigger>
                <Menu.Content className="w-[250px]">
                  <Menu.Item onSelect={() => addStep('tool')}>
                    <SquareTerminal className="h-4 w-4 text-accent-text" />
                    <span>
                      Tool step
                      <span className="block text-xs text-ink-faint">Calls a tool directly. No model.</span>
                    </span>
                  </Menu.Item>
                  <Menu.Item onSelect={() => addStep('agent')}>
                    <Bot className="h-4 w-4 text-[#a99cff]" />
                    <span>
                      Agent step
                      <span className="block text-xs text-ink-faint">An agent runs a prompt.</span>
                    </span>
                  </Menu.Item>
                </Menu.Content>
              </Menu.Root>
            </div>
          )}

          <div role="toolbar" aria-label="Canvas tools" className="absolute bottom-4 left-4 z-10 flex gap-0.5 rounded-xl border border-edge-strong bg-raised-2/90 p-1 backdrop-blur">
            <IconButton label="Select" active={tool === 'select'} className={cn(tool === 'select' && 'bg-accent-soft text-accent-text')} onClick={() => setTool('select')}>
              <MousePointer2 className="h-[18px] w-[18px]" />
            </IconButton>
            <IconButton label="Pan" active={tool === 'pan'} className={cn(tool === 'pan' && 'bg-accent-soft text-accent-text')} onClick={() => setTool('pan')}>
              <Hand className="h-[18px] w-[18px]" />
            </IconButton>
            <IconButton label="Zoom to 100%" onClick={() => void rf.zoomTo(1, { duration: 200 })}>
              <Search className="h-[18px] w-[18px]" />
            </IconButton>
            <IconButton label="Zoom in" onClick={() => void rf.zoomIn({ duration: 200 })}>
              <Plus className="h-[18px] w-[18px]" />
            </IconButton>
            <IconButton label="Zoom out" onClick={() => void rf.zoomOut({ duration: 200 })}>
              <Minus className="h-[18px] w-[18px]" />
            </IconButton>
            <IconButton label="Fit to screen" onClick={() => void rf.fitView({ padding: 0.1, maxZoom: 1.05, duration: 250 })}>
              <Maximize className="h-[18px] w-[18px]" />
            </IconButton>
          </div>

          {!isTemplate && (
            <Tip label="Describe it and get a draft">
              <Button
                variant="secondary"
                size="lg"
                className="absolute right-4 bottom-4 z-10 h-12 border-accent-edge bg-raised-2/80 px-6 text-[15px] backdrop-blur hover:bg-accent-soft"
                onClick={() => setBuildOpen(true)}
              >
                <Sparkles className="h-[18px] w-[18px] text-accent-text" /> Build with AI
              </Button>
            </Tip>
          )}

          {paused && (
            <div role="alertdialog" aria-label="Run paused" className="animate-fade-up absolute bottom-20 left-1/2 z-20 w-[min(460px,calc(100%-32px))] -translate-x-1/2 rounded-xl border border-accent-edge bg-raised-2 p-4 shadow-pop">
              <div className="text-xs font-medium tracking-wide text-accent-text uppercase">The run is waiting for you</div>
              <div className="mt-1 text-[15px] text-ink">{paused.question}</div>
              <div className="mt-3 flex gap-2">
                <Button variant="primary" size="sm" onClick={() => resume.current?.(true)} autoFocus>
                  Continue
                </Button>
                <Button variant="ghost" size="sm" onClick={() => resume.current?.(false)}>
                  Stop the run
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="h-full w-[330px] shrink-0">
        <NodeDetails
          node={selected}
          readOnly={isTemplate}
          onChange={(patch) => selected && patchNode(selected.id, patch)}
          onClose={() => commit({ nodes: graph.nodes.map((n) => ({ ...n, selected: false })) })}
        />
      </div>

      <Modal open={runInputs} onOpenChange={setRunInputs} title="Run workflow" description="Check the inputs for this run.">
        <form
          className="space-y-4 px-6 pt-4 pb-6"
          onSubmit={(e) => {
            e.preventDefault()
            setRunInputs(false)
            void run()
          }}
        >
          {startInputs.map((inp) => (
            <Field key={inp.id} label={`${inp.label}${inp.required ? ' (required)' : ''}`}>
              {(fid) => (
                <TextInput
                  id={fid}
                  value={inp.value}
                  required={inp.required}
                  onChange={(e) =>
                    commit({
                      nodes: graph.nodes.map((n) =>
                        n.data.kind === 'start' ? { ...n, data: { ...n.data, inputs: n.data.inputs.map((i) => (i.id === inp.id ? { ...i, value: e.target.value } : i)) } } : n
                      )
                    })
                  }
                />
              )}
            </Field>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setRunInputs(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" autoFocus>
              <Play className="h-4 w-4 fill-current" /> Start run
            </Button>
          </div>
        </form>
      </Modal>

      <BuildWithAi
        open={buildOpen}
        onOpenChange={setBuildOpen}
        onBuild={(prompt) => {
          const draft = draftFromPrompt(prompt)
          createFrom(null, draft.name, makeGraph(draft.steps))
          pushToast({ text: 'Draft created. Review the steps before running it.' })
        }}
      />
    </div>
  )
}

export function WorkflowsScreen() {
  const activeId = useWorkflows((s) => s.activeId)
  const exists = useWorkflows((s) => !!s.graphs[s.activeId])
  if (!exists) return null
  return (
    <ReactFlowProvider>
      <Editor key={activeId} id={activeId} />
    </ReactFlowProvider>
  )
}
