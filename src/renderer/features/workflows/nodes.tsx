import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Activity,
  Bot,
  Box,
  Check,
  Clock,
  Database,
  Download,
  FileText,
  Mail,
  Play,
  Search,
  Server,
  Shield,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { Spinner } from '@/components/ui'
import type { IconKey, StepNode } from './graph'

export const STEP_ICONS: Record<IconKey, typeof Play> = {
  play: Play,
  square: Square,
  search: Search,
  download: Download,
  clock: Clock,
  file: FileText,
  box: Box,
  bot: Bot,
  mail: Mail,
  database: Database,
  server: Server,
  terminal: SquareTerminal,
  shield: Shield,
  activity: Activity
}

/** Start and End are pills. Tool steps are pink, Agent steps are violet. */
export function StepNodeView({ data, selected }: NodeProps<StepNode>) {
  const Icon = STEP_ICONS[data.icon]
  const { kind, status } = data
  const pill = kind === 'start' || kind === 'end'

  const frame = cn(
    'relative border text-ink transition-shadow',
    pill ? 'flex h-[54px] items-center gap-2.5 rounded-full px-5' : 'w-[150px] rounded-2xl p-3',
    kind === 'start' && 'border-info/70 bg-info/10',
    kind === 'end' && 'border-accent bg-accent/15',
    kind === 'tool' && 'border-accent-edge bg-accent-soft',
    kind === 'agent' && 'border-[#8b7cf6]/60 bg-[#8b7cf6]/12',
    selected && 'shadow-[0_0_0_3px_color-mix(in_oklab,var(--c-accent)_35%,transparent)]',
    status === 'running' && 'animate-pulse'
  )
  const tile = cn(
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
    kind === 'agent' ? 'bg-[#8b7cf6]/25 text-[#a99cff]' : 'bg-accent/20 text-accent-text'
  )

  return (
    <div className={frame}>
      {kind !== 'start' && <Handle type="target" position={Position.Left} />}
      {pill ? (
        <>
          <Icon className={cn('h-[18px] w-[18px]', kind === 'start' ? 'fill-info text-info' : 'fill-accent text-accent')} />
          <span className="text-[15px] font-medium">{data.title}</span>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <span className={tile}>
              <Icon className="h-[17px] w-[17px]" />
            </span>
            <span className="min-w-0 text-[14px] leading-tight font-semibold">{data.title}</span>
          </div>
          <p className="mt-2 text-[12px] leading-snug text-ink-muted">{data.description}</p>
          <span className="mt-2.5 inline-block text-[10px] tracking-wider text-ink-faint uppercase">{kind === 'agent' ? 'Agent step' : 'Tool step'}</span>
        </>
      )}
      {kind !== 'end' && <Handle type="source" position={Position.Right} />}

      {status && status !== 'pending' && (
        <span
          className={cn(
            'absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border-2 border-panel',
            status === 'done' && 'bg-success text-white',
            status === 'error' && 'bg-danger text-white',
            status === 'running' && 'bg-raised-2'
          )}
        >
          {status === 'done' && <Check className="h-3 w-3" strokeWidth={3} />}
          {status === 'error' && <X className="h-3 w-3" strokeWidth={3} />}
          {status === 'running' && <Spinner className="h-3 w-3" />}
        </span>
      )}
    </div>
  )
}

export const nodeTypes = { step: StepNodeView }
