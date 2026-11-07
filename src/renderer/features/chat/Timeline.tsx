import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Plug,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type { AskAnswers, Question, SessionMode, ToolKind } from '@shared/agent'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { Markdown } from '@/components/Markdown'
import { ShimmerText } from '@/components/ShimmerText'
import { Button, Spinner } from '@/components/ui'
import { DiffList } from '@/features/develop/DiffView'
import { AttachmentStrip } from './attachments'
import type { Session, TimelineItem } from '@/stores/types'

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>
type ThinkingItem = Extract<TimelineItem, { kind: 'thinking' }>

const TOOL_ICON: Record<ToolKind, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus,
  shell: SquareTerminal,
  web: Globe,
  search: Search,
  mcp: Plug,
  agent: Bot,
  other: Wrench
}

/* ---------- user and assistant messages ---------- */

function UserMessage({ item }: { item: Extract<TimelineItem, { kind: 'user' }> }) {
  return (
    <div className="animate-fade-up flex flex-col items-end gap-2">
      {item.attachments.length > 0 && <AttachmentStrip items={item.attachments} className="max-w-[78%] justify-end" />}
      {item.text && (
        <div className="selectable max-w-[78%] rounded-2xl rounded-br-md border border-edge bg-raised px-4 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap text-ink">
          {item.text}
        </div>
      )}
    </div>
  )
}

function AssistantMessage({ item }: { item: Extract<TimelineItem, { kind: 'assistant' }> }) {
  return (
    <div className="animate-fade-up max-w-[760px]">
      <Markdown>{item.text}</Markdown>
    </div>
  )
}

/* ---------- thinking ---------- */

function ThinkingRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false)
  const done = item.endedAt !== undefined
  if (!done) {
    // While it streams, show the reasoning itself: the line below says "Thinking".
    return (
      <div className="max-w-[760px] border-l-2 border-edge-strong pl-4 text-[13.5px] leading-[1.65] text-ink-muted italic">
        {item.text}
      </div>
    )
  }
  return (
    <div className="max-w-[760px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-[13px] text-ink-muted hover:text-ink"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        Thought for {formatDuration((item.endedAt ?? item.startedAt) - item.startedAt)}
      </button>
      {open && <div className="mt-1 ml-1 border-l-2 border-edge-strong pl-4 text-[13.5px] leading-[1.65] text-ink-muted italic">{item.text}</div>}
    </div>
  )
}

/* ---------- tools ---------- */

function StatusMark({ status }: { status: ToolItem['status'] }) {
  if (status === 'running') return <Spinner className="h-3.5 w-3.5" />
  if (status === 'ok') return <Check className="h-3.5 w-3.5 text-success" />
  return <X className="h-3.5 w-3.5 text-danger" />
}

function ToolCard({ item, detailed }: { item: ToolItem; detailed: boolean }) {
  const Icon = TOOL_ICON[item.tool]
  const hasBody = item.output.trim().length > 0 || (item.diff?.length ?? 0) > 0
  // Develop shows diffs and running commands open. Chat keeps everything folded.
  const [open, setOpen] = useState(detailed && ((item.diff?.length ?? 0) > 0 || item.status === 'running'))
  const duration = item.endedAt ? formatDuration(item.endedAt - item.startedAt) : null
  const outputLines = item.output.trimEnd().split('\n')

  return (
    <div className={cn('max-w-[760px] overflow-hidden rounded-xl border bg-panel/60', item.status === 'failed' ? 'border-danger/40' : 'border-edge')}>
      <button
        type="button"
        disabled={!hasBody}
        aria-expanded={hasBody ? open : undefined}
        onClick={() => setOpen(!open)}
        className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left', hasBody && 'hover:bg-hover')}
      >
        <Icon className="h-4 w-4 shrink-0 text-ink-muted" />
        <span className={cn('min-w-0 flex-1 truncate text-[13.5px]', item.tool === 'shell' && 'font-mono text-[12.5px]')}>{item.title}</span>
        {duration && <span className="shrink-0 text-xs text-ink-faint">{duration}</span>}
        <StatusMark status={item.status} />
        {hasBody && <ChevronRight className={cn('h-4 w-4 shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />}
      </button>
      {open && hasBody && (
        <div className="space-y-2 border-t border-edge/70 p-3">
          {item.diff && item.diff.length > 0 && <DiffList diffs={item.diff} />}
          {item.output.trim() && (
            <pre className="selectable max-h-[260px] overflow-auto rounded-lg bg-field p-3 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap text-ink-muted">
              {item.status === 'running' && outputLines.length > 8 ? outputLines.slice(-8).join('\n') : item.output.trimEnd()}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function summarize(tools: ToolItem[]): string {
  const count = (k: ToolKind[]) => tools.filter((t) => k.includes(t.tool)).length
  const parts: string[] = []
  const reads = count(['read'])
  if (reads) parts.push(`read ${plural(reads, 'file', 'files')}`)
  const searches = count(['search'])
  if (searches) parts.push(searches === 1 ? 'searched the project' : `searched ${searches} times`)
  if (count(['web'])) parts.push('browsed the web')
  const cmds = count(['shell'])
  if (cmds) parts.push(`ran ${plural(cmds, 'command', 'commands')}`)
  if (count(['edit', 'write'])) parts.push('edited files')
  const mcp = count(['mcp', 'agent', 'other'])
  if (mcp) parts.push(`used ${plural(mcp, 'tool', 'tools')}`)
  const text = parts.join(', ')
  return text ? text[0].toUpperCase() + text.slice(1) : 'Worked'
}

/** Chat folds a run of tool calls into one line. Develop never uses this: it shows every call. */
function ActivityGroup({ items }: { items: (ToolItem | ThinkingItem)[] }) {
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
  const running = tools.some((t) => t.status === 'running')
  const [open, setOpen] = useState(false)
  const shown = open || running
  const start = Math.min(...items.map((i) => i.startedAt))
  const end = Math.max(...items.map((i) => ('endedAt' in i && i.endedAt ? i.endedAt : start)))

  return (
    <div className="max-w-[760px]">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md py-0.5 text-[13px] text-ink-muted hover:text-ink"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', shown && 'rotate-90')} />
        {running ? 'Working…' : `${summarize(tools)} · ${formatDuration(end - start)}`}
      </button>
      {shown && (
        <div className="mt-1.5 ml-1 space-y-1.5 border-l-2 border-edge pl-4">
          {items.map((i) => (i.kind === 'tool' ? <ToolCard key={i.id} item={i} detailed={false} /> : <ThinkingRow key={i.id} item={i} />))}
        </div>
      )}
    </div>
  )
}

/* ---------- approval ---------- */

const APPROVAL_TITLE: Partial<Record<ToolKind, string>> = {
  shell: 'Run this command?',
  edit: 'Edit these files?',
  write: 'Create this file?',
  web: 'Allow web access?',
  mcp: 'Call this tool?',
  agent: 'Start a helper agent?'
}

function ApprovalCard({
  item,
  onAnswer
}: {
  item: Extract<TimelineItem, { kind: 'approval' }>
  onAnswer: (allow: boolean, always?: boolean) => void
}) {
  const Icon = TOOL_ICON[item.tool]
  // A command on a device is Celeste's own approval: it names the device, and cannot be allowed for the whole session.
  const onDevice = item.requestId.startsWith('tool-')
  if (item.status !== 'pending') {
    const allowed = item.status === 'allowed'
    return (
      <div className="flex max-w-[760px] items-center gap-2 text-[13px] text-ink-muted">
        {allowed ? <Check className="h-3.5 w-3.5 text-success" /> : <X className="h-3.5 w-3.5 text-danger" />}
        {allowed ? 'You allowed' : 'You denied'}: <span className="truncate font-mono text-[12.5px]">{item.title}</span>
      </div>
    )
  }
  return (
    <div role="group" aria-label="Approval needed" className="animate-fade-up max-w-[760px] rounded-xl border border-accent-edge bg-accent-soft/50 p-4">
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <ShieldQuestion className="h-[18px] w-[18px] text-accent-text" />
        {onDevice ? `${item.title}?` : (APPROVAL_TITLE[item.tool] ?? 'Allow this action?')}
      </div>
      <div className="mt-2.5 flex items-start gap-2.5 rounded-lg bg-field px-3 py-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
        <div className="selectable min-w-0 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-ink">
          {item.detail ?? item.title}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => onAnswer(true)} autoFocus>
          Allow
        </Button>
        {!onDevice && (
          <Button variant="secondary" size="sm" onClick={() => onAnswer(true, true)}>
            Allow for this session
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => onAnswer(false)}>
          Deny
        </Button>
      </div>
    </div>
  )
}

/* ---------- ask_user ---------- */

function AskUserCard({
  item,
  onAnswer
}: {
  item: Extract<TimelineItem, { kind: 'ask' }>
  onAnswer: (answers: AskAnswers) => void
}) {
  const { questions } = item
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [typingOther, setTypingOther] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const q: Question = questions[step]
  const last = step === questions.length - 1

  useEffect(() => {
    if (item.status === 'pending') root.current?.focus()
  }, [item.status])

  if (item.status === 'answered' && item.answers) {
    return (
      <div className="max-w-[760px] space-y-1 text-[13px] text-ink-muted">
        {questions.map((qq) => {
          const a = item.answers?.[qq.question]
          return (
            <div key={qq.question} className="flex items-start gap-2">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              <span>
                {qq.question} <span className="text-ink">{Array.isArray(a) ? a.join(', ') : a}</span>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const current = picked[q.question] ?? []
  const otherText = (other[q.question] ?? '').trim()
  const hasAnswer = current.length > 0 || otherText.length > 0

  const toggle = (label: string) => {
    setPicked((p) => {
      const cur = p[q.question] ?? []
      if (q.multiSelect) return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      return { ...p, [q.question]: [label] }
    })
    if (!q.multiSelect) setOther((o) => ({ ...o, [q.question]: '' }))
  }

  const finish = () => {
    const answers: AskAnswers = {}
    for (const qq of questions) {
      const labels = picked[qq.question] ?? []
      const free = (other[qq.question] ?? '').trim()
      const all = free ? [...labels, free] : labels
      answers[qq.question] = qq.multiSelect ? all : (all[0] ?? '')
    }
    onAnswer(answers)
  }
  const next = () => {
    if (!hasAnswer) return
    if (last) finish()
    else {
      setStep(step + 1)
      setTypingOther(false)
    }
  }

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="group"
      aria-label="Celeste is asking you a question"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') {
          if (e.key === 'Enter') next()
          return
        }
        const n = Number(e.key)
        if (n >= 1 && n <= q.options.length) toggle(q.options[n - 1].label)
        if (e.key === 'Enter') next()
      }}
      className="animate-fade-up max-w-[760px] rounded-xl border border-accent-edge bg-accent-soft/50 p-4 outline-none"
    >
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <ShieldQuestion className="h-4 w-4 text-accent-text" />
        <span className="font-medium text-accent-text">Celeste is asking</span>
        {questions.length > 1 && (
          <span className="ml-auto">
            Question {step + 1} of {questions.length}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-edge-strong px-2 py-0.5 text-[11px] text-ink-muted">{q.header}</span>
        <h3 className="text-[15px] font-medium text-ink">{q.question}</h3>
      </div>
      <div role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question} className="mt-3 space-y-1.5">
        {q.options.map((o, i) => {
          const on = current.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              onClick={() => toggle(o.label)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                on ? 'border-accent-edge bg-accent-soft' : 'border-edge bg-field hover:border-edge-strong'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center border text-[10px] font-semibold',
                  q.multiSelect ? 'rounded' : 'rounded-full',
                  on ? 'border-accent bg-accent text-white' : 'border-edge-strong text-ink-faint'
                )}
              >
                {on ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] text-ink">{o.label}</span>
                {o.description && <span className="block text-[12.5px] text-ink-muted">{o.description}</span>}
              </span>
            </button>
          )
        })}
        <div
          className={cn(
            'flex items-center gap-3 rounded-lg border px-3 py-1.5',
            otherText ? 'border-accent-edge bg-accent-soft' : 'border-edge bg-field'
          )}
        >
          <span className="w-[18px] shrink-0 text-center text-[11px] text-ink-faint">…</span>
          <input
            value={other[q.question] ?? ''}
            placeholder="Something else"
            aria-label="Other answer"
            onFocus={() => setTypingOther(true)}
            onChange={(e) => {
              setOther({ ...other, [q.question]: e.target.value })
              if (!q.multiSelect && e.target.value) setPicked((p) => ({ ...p, [q.question]: [] }))
            }}
            className="h-8 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={!hasAnswer} onClick={next}>
          {last ? 'Send answers' : 'Next'}
        </Button>
        {step > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <span className="ml-auto text-xs text-ink-faint">{typingOther ? 'Enter to continue' : 'Press 1–' + q.options.length + ' to choose, Enter to continue'}</span>
      </div>
    </div>
  )
}

/* ---------- errors, notices, activity ---------- */

function ErrorCard({ item, onRetry }: { item: Extract<TimelineItem, { kind: 'error' }>; onRetry?: () => void }) {
  return (
    <div role="alert" className="animate-fade-up flex max-w-[760px] items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4">
      <CircleAlert className="mt-0.5 h-[18px] w-[18px] shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">Something went wrong</div>
        <div className="mt-0.5 text-[13.5px] text-ink-muted">{item.error.message}</div>
        {item.error.retryable && onRetry && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  )
}

export function ActivityLine({ activity }: { activity: NonNullable<Session['activity']> }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2.5 text-[14px]">
      {activity.working ? (
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
      ) : (
        <span className="h-2.5 w-2.5 rounded-full border-2 border-accent-text" aria-hidden />
      )}
      <ShimmerText active={activity.working}>{activity.label}</ShimmerText>
      {activity.working && <span className="text-ink-faint">…</span>}
    </div>
  )
}

/* ---------- the timeline ---------- */

type Block = { kind: 'item'; item: TimelineItem } | { kind: 'group'; id: string; items: (ToolItem | ThinkingItem)[] }

/** Chat folds runs of thinking and tool calls into one group. Develop shows each one. */
function toBlocks(items: TimelineItem[], mode: SessionMode): Block[] {
  if (mode === 'develop') return items.map((item) => ({ kind: 'item', item }))
  const out: Block[] = []
  for (const item of items) {
    if (item.kind === 'tool' || (item.kind === 'thinking' && item.endedAt !== undefined)) {
      const last = out[out.length - 1]
      if (last?.kind === 'group') last.items.push(item)
      else out.push({ kind: 'group', id: item.id, items: [item] })
    } else {
      out.push({ kind: 'item', item })
    }
  }
  return out.filter((b) => b.kind !== 'group' || b.items.some((i) => i.kind === 'tool'))
}

export function Timeline({
  session,
  onApproval,
  onAsk,
  onRetry
}: {
  session: Session
  onApproval: (requestId: string, allow: boolean, always?: boolean) => void
  onAsk: (requestId: string, answers: AskAnswers) => void
  onRetry: () => void
}) {
  const blocks = useMemo(() => toBlocks(session.items, session.mode), [session.items, session.mode])
  return (
    <div className="space-y-4">
      {blocks.map((b) => {
        if (b.kind === 'group') return <ActivityGroup key={b.id} items={b.items} />
        const it = b.item
        switch (it.kind) {
          case 'user':
            return <UserMessage key={it.id} item={it} />
          case 'assistant':
            return <AssistantMessage key={it.id} item={it} />
          case 'thinking':
            return <ThinkingRow key={it.id} item={it} />
          case 'tool':
            return <ToolCard key={it.id} item={it} detailed={session.mode === 'develop'} />
          case 'approval':
            return <ApprovalCard key={it.id} item={it} onAnswer={(allow, always) => onApproval(it.requestId, allow, always)} />
          case 'ask':
            return <AskUserCard key={it.id} item={it} onAnswer={(a) => onAsk(it.requestId, a)} />
          case 'error':
            return <ErrorCard key={it.id} item={it} onRetry={onRetry} />
          case 'notice':
            return (
              <div key={it.id} className="text-center text-xs text-ink-faint">
                {it.text}
              </div>
            )
        }
      })}
      {session.activity && <ActivityLine activity={session.activity} />}
    </div>
  )
}
