import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
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
  RotateCcw,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Wrench,
  X
} from 'lucide-react'
import type { AskAnswers, SessionMode, ToolKind } from '@shared/agent'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { Markdown } from '@/components/Markdown'
import { ShimmerText } from '@/components/ShimmerText'
import { Button, Spinner } from '@/components/ui'
import { DiffList } from '@/features/develop/DiffView'
import { RevertDialog } from '@/features/develop/RevertDialog'
import { ReviewDialog } from '@/features/develop/ReviewDialog'
import { useSessions } from '@/stores/sessions'
import { AttachmentStrip } from './attachments'
import { AskUserCard } from './AskUserCard'
import { ContextStrip } from './context'
import { DesktopCard } from './DesktopCard'
import { FileCards } from './FileCards'
import { WorkflowRunCard } from './WorkflowRunCard'
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

const UserMessage = memo(function UserMessage({
  item,
  canRevert,
  onRevert,
  onReview
}: {
  item: Extract<TimelineItem, { kind: 'user' }>
  canRevert: boolean
  onRevert: (checkpointId: string) => void
  onReview: (checkpointId: string) => void
}) {
  const checkpoint = item.checkpoint
  const files = checkpoint?.files
  const added = files?.reduce((n, f) => n + f.added, 0) ?? 0
  const removed = files?.reduce((n, f) => n + f.removed, 0) ?? 0
  return (
    <div className="animate-fade-up flex flex-col items-end gap-2">
      {item.context && <ContextStrip items={item.context} className="max-w-[78%] justify-end" />}
      {item.attachments.length > 0 && <AttachmentStrip items={item.attachments} className="max-w-[78%] justify-end" />}
      {item.text && (
        <div className="selectable max-w-[78%] rounded-2xl rounded-br-md border border-edge bg-raised px-4 py-2.5 text-[15px] leading-[1.6] whitespace-pre-wrap text-ink">
          {item.text}
        </div>
      )}
      {checkpoint && (
        <div className="flex items-center gap-2 text-xs text-ink-faint">
          {files && files.length === 0 && <span>No files changed</span>}
          {files && files.length > 0 && (
            <button
              type="button"
              onClick={() => onReview(checkpoint.id)}
              className="rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink"
            >
              {files.length}
              {checkpoint.more ? `+${checkpoint.more}` : ''} {files.length === 1 && !checkpoint.more ? 'file' : 'files'} changed{' '}
              <span className="font-mono">
                <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
              </span>
              {/* The name starts with the words on the button, then says what pressing it does. */}
              <span className="sr-only">. Review the changes this message made</span>
            </button>
          )}
          <button
            type="button"
            disabled={!canRevert}
            onClick={() => onRevert(checkpoint.id)}
            aria-label="Revert to before this message"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" /> Revert to before this
          </button>
        </div>
      )}
    </div>
  )
})

const RevertedNotice = memo(function RevertedNotice({ item, canUndo, onUndo }: { item: Extract<TimelineItem, { kind: 'reverted' }>; canUndo: boolean; onUndo: () => void }) {
  const parts = [item.restored > 0 && `${item.restored} ${item.restored === 1 ? 'file' : 'files'} put back`, item.removed > 0 && `${item.removed} removed`].filter(Boolean)
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-ink-faint">
      <RotateCcw className="h-3 w-3" />
      <span>{parts.length ? `Reverted: ${parts.join(', ')}.` : 'Reverted: nothing needed to change.'}</span>
      {canUndo && (
        <button type="button" onClick={onUndo} className="rounded-md px-1.5 py-0.5 underline decoration-edge-strong underline-offset-2 hover:bg-hover hover:text-ink">
          Undo
        </button>
      )}
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({ item }: { item: Extract<TimelineItem, { kind: 'assistant' }> }) {
  return (
    <div className="animate-fade-up max-w-[760px]">
      <Markdown>{item.text}</Markdown>
    </div>
  )
})

/* ---------- thinking ---------- */

/** What the assistant thought. Chat folds it into a group; Develop shows it, a little at a time: the last lines while it streams, a line when done. */
const ThinkingRow = memo(function ThinkingRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false)
  const done = item.endedAt !== undefined
  const body = 'mt-1 ml-1 border-l-2 border-edge-strong pl-4 text-[13.5px] leading-[1.65] text-ink-muted italic'
  if (!done) {
    // While it streams only the last lines show, and a click opens all of it. (A long line of thought is a lot to draw for each word.)
    const tail = item.text.length > TAIL ? `…${item.text.slice(-TAIL).trimStart()}` : item.text
    return (
      <div className="max-w-[760px]">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-md py-0.5 text-[13px] text-ink-muted hover:text-ink">
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          <ShimmerText active>Thinking</ShimmerText>
        </button>
        <div className={cn(body, !open && 'max-h-[5.2em] overflow-hidden')}>{open ? item.text : tail}</div>
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
      {open && <div className={body}>{item.text}</div>}
    </div>
  )
})

/** About three lines of thinking, as shown while it streams in Develop. */
const TAIL = 240

/* ---------- tools ---------- */

function StatusMark({ status }: { status: ToolItem['status'] }) {
  if (status === 'running') return <Spinner className="h-3.5 w-3.5" />
  if (status === 'ok') return <Check className="h-3.5 w-3.5 text-success" />
  return <X className="h-3.5 w-3.5 text-danger" />
}

const ToolCard = memo(function ToolCard({ item, detailed }: { item: ToolItem; detailed: boolean }) {
  const Icon = TOOL_ICON[item.tool]
  const hasBody = item.output.trim().length > 0 || (item.diff?.length ?? 0) > 0
  // Develop shows diffs and running commands open. Chat keeps everything folded.
  const [open, setOpen] = useState(detailed && ((item.diff?.length ?? 0) > 0 || item.status === 'running'))
  const duration = item.endedAt ? formatDuration(item.endedAt - item.startedAt) : null
  // Only what is on screen is worked out: a closed card has no use for its output split into lines.
  const outputLines = open ? item.output.trimEnd().split('\n') : []

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
})

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

const sameItems = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * A run of thinking and tool calls folded into one line, closed until the person opens it (also while it is still going: what it
 * is doing now is the line under the conversation). Chat folds all of it; Develop folds the quiet part, reading and searching.
 */
const ActivityGroup = memo(
  function ActivityGroup({ items, detailed }: { items: (ToolItem | ThinkingItem)[]; detailed: boolean }) {
    const tools = items.filter((i): i is ToolItem => i.kind === 'tool')
    const running = tools.some((t) => t.status === 'running') || items.some((i) => i.kind === 'thinking' && i.endedAt === undefined)
    const [open, setOpen] = useState(false)
    const start = Math.min(...items.map((i) => i.startedAt))
    const end = Math.max(...items.map((i) => ('endedAt' in i && i.endedAt ? i.endedAt : start)))
    const label = running ? (tools.length ? 'Working' : 'Thinking') : tools.length ? summarize(tools) : 'Thought'

    return (
      <div className="max-w-[760px]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 rounded-md py-0.5 text-[13px] text-ink-muted hover:text-ink"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          {running ? (
            <ShimmerText active>{`${label}…`}</ShimmerText>
          ) : (
            `${label}${tools.length ? ' · ' : ' for '}${formatDuration(end - start)}`
          )}
        </button>
        {open && (
          <div className="mt-1.5 ml-1 space-y-1.5 border-l-2 border-edge pl-4">
            {items.map((i) => (i.kind === 'tool' ? <ToolCard key={i.id} item={i} detailed={detailed} /> : <ThinkingRow key={i.id} item={i} />))}
          </div>
        )}
      </div>
    )
  },
  (a, b) => a.detailed === b.detailed && sameItems(a.items, b.items)
)

/* ---------- approval ---------- */

const APPROVAL_TITLE: Partial<Record<ToolKind, string>> = {
  shell: 'Run this command?',
  edit: 'Edit these files?',
  write: 'Create this file?',
  web: 'Allow web access?',
  mcp: 'Call this tool?',
  agent: 'Start a helper agent?'
}

const ApprovalCard = memo(function ApprovalCard({
  item,
  onAnswer
}: {
  item: Extract<TimelineItem, { kind: 'approval' }>
  onAnswer: (requestId: string, allow: boolean, always?: boolean) => void
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
        <Button variant="primary" size="sm" onClick={() => onAnswer(item.requestId, true)} autoFocus>
          {item.choices?.allow ?? 'Allow'}
        </Button>
        {item.choices ? (
          <Button variant="secondary" size="sm" onClick={() => onAnswer(item.requestId, true, true)}>
            {item.choices.always}
          </Button>
        ) : (
          !onDevice && (
            <Button variant="secondary" size="sm" onClick={() => onAnswer(item.requestId, true, true)}>
              Allow for this session
            </Button>
          )
        )}
        <Button variant="ghost" size="sm" onClick={() => onAnswer(item.requestId, false)}>
          Deny
        </Button>
      </div>
    </div>
  )
})

/** A question card, with its answer wired to its own request. */
const AskRow = memo(function AskRow({ item, onAsk }: { item: Extract<TimelineItem, { kind: 'ask' }>; onAsk: (requestId: string, answers: AskAnswers) => void }) {
  return <AskUserCard item={item} onAnswer={(a) => onAsk(item.requestId, a)} />
})

const MemoWorkflowRunCard = memo(WorkflowRunCard)
const MemoDesktopCard = memo(DesktopCard)
const MemoFileCards = memo(FileCards)

/* ---------- errors, notices, activity ---------- */

const ErrorCard = memo(function ErrorCard({ item, onRetry }: { item: Extract<TimelineItem, { kind: 'error' }>; onRetry?: () => void }) {
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
})

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

const blockId = (b: Block) => (b.kind === 'group' ? b.id : b.item.id)
const holds = (b: Block, id: string) => (b.kind === 'group' ? b.items.some((i) => i.id === id) : b.item.id === id)

/** Reading and searching: the part of Develop's work that is folded. Edits, commands, web and tools stay as cards of their own. */
const QUIET: ToolKind[] = ['read', 'search']

/**
 * Chat folds all thinking and every tool call into groups: a person using it for questions wants the answer, and the way there is
 * one click away. Develop shows thinking while it streams and each tool call, but folds runs of reading and searching, which
 * are many and the least interesting.
 */
export function toBlocks(items: TimelineItem[], mode: SessionMode): Block[] {
  const out: Block[] = []
  let run: (ToolItem | ThinkingItem)[] = []
  const emit = () => {
    if (run.length === 0) return
    if (mode === 'chat' || run.some((i) => i.kind === 'tool')) out.push({ kind: 'group', id: run[0]!.id, items: run })
    // Develop: thinking with no reading beside it is shown on its own.
    else for (const item of run) out.push({ kind: 'item', item })
    run = []
  }
  for (const item of items) {
    const foldable =
      mode === 'chat'
        ? item.kind === 'tool' || item.kind === 'thinking'
        : (item.kind === 'tool' && QUIET.includes(item.tool)) || (item.kind === 'thinking' && item.endedAt !== undefined)
    if (foldable) run.push(item as ToolItem | ThinkingItem)
    else {
      emit()
      out.push({ kind: 'item', item })
    }
  }
  emit()
  return out
}

/** How many blocks a long conversation opens with at the bottom, and how many more each "earlier" brings. */
const FIRST = 60
const PAGE = 40
/** The newest blocks are always drawn in full; older ones are only drawn while they are near the screen. */
const LIVE_TAIL = 12

const NO_ROOT: RefObject<HTMLDivElement | null> = { current: null }

/** The top of what is drawn, when older blocks are held back: it loads more as it comes near the screen. */
function Earlier({ hidden, onMore, root }: { hidden: number; onMore: () => void; root: RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLButtonElement>(null)
  const more = useRef(onMore)
  more.current = onMore
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more.current(), { root: root.current, rootMargin: '900px 0px 0px 0px' })
    io.observe(el)
    return () => io.disconnect()
    // It watches again after each page, in case the next is already near.
  }, [root, hidden])
  return (
    <button ref={ref} type="button" onClick={onMore} className="mx-auto flex rounded-full border border-edge px-3 py-1 text-xs text-ink-muted hover:bg-hover hover:text-ink">
      Show earlier messages ({hidden})
    </button>
  )
}

export function Timeline({
  session,
  scroller,
  onApproval,
  onAsk,
  onRetry
}: {
  session: Session
  /** The element that scrolls, to keep what is being read in place when earlier messages are added above it. */
  scroller?: RefObject<HTMLDivElement | null>
  onApproval: (requestId: string, allow: boolean, always?: boolean) => void
  onAsk: (requestId: string, answers: AskAnswers) => void
  onRetry: () => void
}) {
  const blocks = useMemo(() => toBlocks(session.items, session.mode), [session.items, session.mode])
  const revert = useSessions((s) => s.revert)
  const [target, setTarget] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  // Only the newest revert can be undone, and only until the person says something else: after that, files have moved on.
  const lastReverted = useMemo(() => {
    const last = session.items.map((it) => it.kind).lastIndexOf('reverted')
    return last >= 0 && !session.items.slice(last).some((it) => it.kind === 'user') ? session.items[last]?.id : undefined
  }, [session.items])
  const idle = session.status === 'idle'

  // The callbacks the cards get never change, so a card is drawn again only when it itself changes.
  const latest = useRef({ onApproval, onAsk, onRetry })
  latest.current = { onApproval, onAsk, onRetry }
  const approve = useCallback((requestId: string, allow: boolean, always?: boolean) => latest.current.onApproval(requestId, allow, always), [])
  const ask = useCallback((requestId: string, answers: AskAnswers) => latest.current.onAsk(requestId, answers), [])
  const retry = useCallback(() => latest.current.onRetry(), [])
  const sessionId = session.id
  const undo = useCallback((undoId: string) => void revert(sessionId, undoId), [revert, sessionId])

  // A long conversation is drawn from near its end; what is above is held back until the reader goes there. The first block that
  // is drawn is remembered by its id, so what is drawn does not shift as the conversation grows.
  const [from, setFrom] = useState<string | null>(null)
  const index = from === null ? Math.max(0, blocks.length - FIRST) : Math.max(0, blocks.findIndex((b) => holds(b, from)))
  const first = blocks[index]
  useLayoutEffect(() => {
    if (from === null && first) setFrom(blockId(first))
  }, [from, first])
  const opened = useRef<number | null>(null)
  if (opened.current === null && blocks.length > 0) opened.current = index
  const hold = useRef<{ height: number; top: number } | null>(null)
  const more = useCallback(() => {
    const el = scroller?.current
    hold.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null
    const at = Math.max(0, index - PAGE)
    const b = blocks[at]
    if (b) setFrom(blockId(b))
  }, [blocks, index, scroller])
  // Messages added above keep what the reader is looking at where it was.
  useLayoutEffect(() => {
    const el = scroller?.current
    const h = hold.current
    hold.current = null
    if (el && h) el.scrollTop = h.top + (el.scrollHeight - h.height)
  }, [from, scroller])

  return (
    <div className="space-y-4">
      {target && <RevertDialog sessionId={session.id} checkpointId={target} onClose={() => setTarget(null)} />}
      {reviewing && <ReviewDialog sessionId={session.id} scope={reviewing} onClose={() => setReviewing(null)} />}
      {index > 0 && <Earlier hidden={index} onMore={more} root={scroller ?? NO_ROOT} />}
      {blocks.slice(index).map((b, n) => {
        const at = index + n
        // Blocks far from the end are skipped by the browser while they are off screen (nothing is laid out or painted for them), and
        // those brought in from above do not play the entrance animation.
        const cls = cn(at < blocks.length - LIVE_TAIL && 'cv-auto', at < (opened.current ?? 0) && 'no-anim')
        return (
          <div key={blockId(b)} className={cls || undefined}>
            {renderBlock(b)}
          </div>
        )
      })}
      {session.activity && <ActivityLine activity={session.activity} />}
    </div>
  )

  function renderBlock(b: Block) {
    if (b.kind === 'group') return <ActivityGroup items={b.items} detailed={session.mode === 'develop'} />
    const it = b.item
    switch (it.kind) {
      case 'user':
        return <UserMessage item={it} canRevert={idle && !!it.checkpoint} onRevert={setTarget} onReview={setReviewing} />
      case 'workflow':
        return <MemoWorkflowRunCard runId={it.runId} name={it.name} workflowId={it.workflowId} />
      case 'desktop':
        return <MemoDesktopCard item={it} />
      case 'files':
        return <MemoFileCards sessionId={session.id} files={it.files} more={it.more} />
      case 'reverted':
        return <RevertedNotice item={it} canUndo={idle && it.id === lastReverted} onUndo={() => undo(it.undoId)} />
      case 'assistant':
        return <AssistantMessage item={it} />
      case 'thinking':
        return <ThinkingRow item={it} />
      case 'tool':
        return <ToolCard item={it} detailed={session.mode === 'develop'} />
      case 'approval':
        return <ApprovalCard item={it} onAnswer={approve} />
      case 'ask':
        return <AskRow item={it} onAsk={ask} />
      case 'error':
        return <ErrorCard item={it} onRetry={retry} />
      case 'notice':
        return <div className="text-center text-xs text-ink-faint">{it.text}</div>
    }
  }
}
