import { FileText, Flag, Globe, Play, Plug, Sparkles, Terminal } from 'lucide-react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { WorkflowNode } from '@shared/workflow'
import { cn } from '@/lib/cn'

export interface StepMeta {
  icon: typeof Play
  /** What kind of step it is, in words. */
  label: string
  /** Colours of its border and icon tile, from the design: Start blue, tools pink, the assistant violet, End pink. */
  tone: string
  tile: string
}

const BLUE = 'border-info/70'
const PINK = 'border-accent/70'
const VIOLET = 'border-[#8b7bff]/70'

export function metaOf(step: WorkflowNode): StepMeta {
  switch (step.type) {
    case 'start':
      return { icon: Play, label: 'Start', tone: BLUE, tile: 'bg-info/15 text-info' }
    case 'end':
      return { icon: Flag, label: 'End', tone: PINK, tile: 'bg-accent-soft text-accent-text' }
    case 'agent':
      return { icon: Sparkles, label: 'Assistant step', tone: VIOLET, tile: 'bg-[#8b7bff]/15 text-[#a99dff]' }
    case 'tool': {
      const t = step.tool
      const icon = t.kind === 'shell' ? Terminal : t.kind === 'http' ? Globe : t.kind === 'file' ? FileText : Plug
      const label = { shell: 'Command', http: 'Web request', file: 'File', mcp: 'Tool' }[t.kind]
      return { icon, label: `${label} step`, tone: PINK, tile: 'bg-accent-soft text-accent-text' }
    }
  }
}

/** What a step says it does, for the line under its name: its own description, or what it is set to do. */
export function summaryOf(step: WorkflowNode): string {
  if (step.description?.trim()) return step.description.trim()
  switch (step.type) {
    case 'start':
      return step.inputs.length ? `Asks for ${step.inputs.map((i) => i.label || i.name).join(', ')}.` : 'Where the workflow begins.'
    case 'end':
      return 'Where the workflow ends and gives its result.'
    case 'agent':
      return step.prompt.trim() || 'Not filled in yet.'
    case 'tool': {
      const t = step.tool
      const text = t.kind === 'shell' ? t.command : t.kind === 'http' ? `${t.method} ${t.url}` : t.kind === 'file' ? `${t.op} ${t.path}` : [t.server, t.tool].filter(Boolean).join(': ')
      return text.trim() || 'Not filled in yet.'
    }
  }
}

export type StepData = Node<{ step: WorkflowNode; selected: boolean }, 'step'>

/** One step on the canvas. It is a button in all but looks: Enter or Space opens its details. */
export function StepNode({ data }: NodeProps<StepData>) {
  const { step, selected } = data
  const meta = metaOf(step)
  const Icon = meta.icon
  return (
    <div
      className={cn(
        'w-[230px] rounded-xl border bg-raised-2 p-3 text-left shadow-pop transition-shadow',
        meta.tone,
        selected && 'ring-2 ring-accent ring-offset-2 ring-offset-canvas'
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="!h-2 !w-2 !border-0 !bg-accent" />
      <div className="flex items-start gap-2.5">
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', meta.tile)}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{step.name}</div>
          <div className="text-[11.5px] text-ink-faint">{meta.label}</div>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-[12.5px] leading-snug text-ink-muted">{summaryOf(step)}</p>
      <Handle type="source" position={Position.Right} isConnectable={false} className="!h-2 !w-2 !border-0 !bg-accent" />
    </div>
  )
}
