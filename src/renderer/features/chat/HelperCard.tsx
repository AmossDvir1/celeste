import { memo, useState } from 'react'
import { Ban, Bot, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge, Button } from '@/components/ui'
import { VENDORS } from '@/lib/vendors'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import type { TimelineItem } from '@/stores/types'

export type HelperItem = Extract<TimelineItem, { kind: 'helper' }>

/** How the card says where a helper stands. */
const STATE: Record<'working' | 'waiting' | 'done' | 'failed' | 'stopped' | 'abandoned' | 'deleted', { text: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'info' }> = {
  working: { text: 'Working', tone: 'info' },
  waiting: { text: 'Waiting for you', tone: 'accent' },
  done: { text: 'Done', tone: 'success' },
  failed: { text: 'Failed', tone: 'warning' },
  stopped: { text: 'Stopped', tone: 'neutral' },
  abandoned: { text: 'Not finished', tone: 'neutral' },
  deleted: { text: 'Deleted', tone: 'neutral' }
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''
const firstLines = (text: string, n: number): { shown: string; more: boolean } => {
  const lines = text.trim().split('\n')
  return { shown: lines.slice(0, n).join('\n'), more: lines.length > n }
}

/**
 * One card for each helper the assistant started: who and what, how it stands, and what it answered. While the helper works its state is
 * read from the helper's own session (so a question it asked shows as "Waiting for you"); once it has ended, from what the parent's log says.
 */
export const HelperCard = memo(function HelperCard({ item }: { item: HelperItem }) {
  const status = useSessions((s) => s.sessions[item.childId]?.status)
  const mode = useSessions((s) => s.sessions[item.childId]?.mode)
  const exists = useSessions((s) => s.sessions[item.childId] !== undefined)
  const open = useSessions((s) => s.open)
  const stop = useSessions((s) => s.stop)
  const setMode = useUi((s) => s.setMode)
  const [unfolded, setUnfolded] = useState(false)

  const finished = item.finished
  const state = finished ? finished.status : !exists ? 'deleted' : status === 'waiting' ? 'waiting' : 'working'
  const live = state === 'working' || state === 'waiting'
  const { text, tone } = STATE[state]
  const answer = finished?.status === 'done' && finished.result ? firstLines(finished.result, 6) : undefined
  const latest = item.tasks[item.tasks.length - 1] ?? ''

  return (
    <section aria-label={`Helper: ${item.title}`} className="animate-fade-up max-w-[760px] rounded-xl border border-edge bg-field/50 p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-ink">{item.title}</div>
          <div className="truncate text-[12px] text-ink-muted">
            Helper · {VENDORS[item.vendor].menuLabel} · {item.model}
            {item.folder === 'copy' && ' · separate copy'}
          </div>
        </div>
        <Badge tone={tone}>{text}</Badge>
        {exists && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (mode) setMode(mode)
              open(item.childId)
            }}
          >
            Open
          </Button>
        )}
        {live && exists && (
          <Button variant="secondary" size="sm" onClick={() => stop(item.childId)}>
            <Ban className="h-3.5 w-3.5" /> Stop
          </Button>
        )}
        <button
          type="button"
          aria-expanded={unfolded}
          aria-label={unfolded ? 'Hide the task' : 'Show the task'}
          onClick={() => setUnfolded(!unfolded)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-hover hover:text-ink"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', unfolded && 'rotate-180')} />
        </button>
      </div>

      {unfolded ? (
        <div className="mt-3 space-y-2 text-[13px] text-ink-muted">
          {item.tasks.map((t, i) => (
            <div key={i} className="selectable whitespace-pre-wrap">
              {item.tasks.length > 1 && <span className="mr-1 text-ink-faint">{i === 0 ? 'Task:' : 'More work:'}</span>}
              {t}
            </div>
          ))}
          {answer && (
            <div className="selectable rounded-lg border border-edge bg-raised/60 p-2.5 whitespace-pre-wrap text-ink">
              {answer.shown}
              {answer.more && <span className="text-ink-faint"> …</span>}
            </div>
          )}
          {finished?.error && <div className="text-danger">{finished.error}</div>}
        </div>
      ) : (
        <div className="mt-2 truncate text-[13px] text-ink-muted">{firstLine(latest)}</div>
      )}
      {item.told && <div className="mt-2 text-[12px] text-ink-faint">The assistant was told.</div>}
    </section>
  )
})
