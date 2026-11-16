import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CalendarClock, Clock, MoreHorizontal, PauseCircle, Pencil, Play, PlayCircle, ScrollText, Trash2 } from 'lucide-react'
import type { ScheduleLogEntry, ScheduleSummary } from '@shared/schedule'
import type { StartNode } from '@shared/workflow'
import { core } from '@/api'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Modal } from '@/components/Dialog'
import { Menu } from '@/components/menu'
import { Badge, Button, IconButton, Switch } from '@/components/ui'
import { useRuns } from '@/stores/runs'
import { useSchedules } from '@/stores/schedules'
import { useWorkflows } from '@/stores/workflows'
import { formatDay, formatTime, sameDay } from '@/lib/format'
import { ScheduleDialog } from './ScheduleDialog'
import { atWords } from './scheduleForm'

const RESULT: Record<string, string> = { running: 'Running now', waiting: 'Waiting for you', completed: 'Last run finished', failed: 'Last run failed', cancelled: 'Last run was stopped' }
const when = (at: number) => (sameDay(at, Date.now()) ? formatTime(at) : `${formatDay(at)}, ${formatTime(at)}`)

/** What a schedule is doing, in words, and how to read it at a glance: a badge for the ones that need the person. */
export function stateOf(s: ScheduleSummary): { badge?: { text: string; tone: 'warning' | 'neutral' | 'accent' }; line: string } {
  if (s.pausedReason === 'edited') return { badge: { text: 'Needs your OK again', tone: 'warning' }, line: 'The workflow changed, so nothing runs until you look at it and approve it again.' }
  if (s.pausedReason === 'failures') return { badge: { text: 'Switched off', tone: 'warning' }, line: 'It failed 3 times in a row, so it was switched off.' }
  if (s.pausedReason === 'all') return { badge: { text: 'Paused: all', tone: 'neutral' }, line: 'Every schedule is paused. Press Resume all above, or use Celeste’s icon near the clock.' }
  if (!s.enabled) return { badge: { text: s.spec.kind === 'once' && s.lastFireAt ? 'Done' : 'Off', tone: 'neutral' }, line: s.spec.kind === 'once' && s.lastFireAt ? 'It ran once.' : 'Switched off.' }
  return { line: s.nextRunAt ? `Next: ${atWords(s.nextRunAt)}` : 'Nothing more to run.' }
}

/** The inputs a workflow asks at its Start step, and its name: what the schedule dialog needs. Null when the workflow is gone. */
async function startOf(workflowId: string) {
  const w = await core.call('workflows.get', workflowId)
  if (!w) return null
  return { name: w.name, inputs: (w.definition.nodes.find((n): n is StartNode => n.type === 'start')?.inputs) ?? [] }
}

/** Opens the schedule dialog for a workflow, to make a schedule or to change `existing`. */
export function useScheduleDialog(): { ask: (workflowId: string, existing?: ScheduleSummary) => void; dialog: ReactNode } {
  const [asking, setAsking] = useState<{ workflowId: string; name: string; inputs: StartNode['inputs']; existing?: ScheduleSummary } | null>(null)
  const ask = (workflowId: string, existing?: ScheduleSummary) => {
    void startOf(workflowId).then((s) => s && setAsking({ workflowId, ...s, ...(existing ? { existing } : {}) }))
  }
  const dialog = asking && <ScheduleDialog workflowId={asking.workflowId} name={asking.name} inputs={asking.inputs} {...(asking.existing ? { existing: asking.existing } : {})} onClose={() => setAsking(null)} />
  return { ask, dialog }
}

/** The small clock on a workflow's row when it has schedules that are on. */
export function ScheduleChip({ workflowId }: { workflowId: string }) {
  // The stored list itself, filtered here: a selector that makes a new array each time would make the store think it changed on every look.
  const all = useSchedules((s) => s.list)
  const mine = useMemo(() => all.filter((x) => x.workflowId === workflowId), [all, workflowId])
  if (mine.length === 0) return null
  const on = mine.filter((s) => s.enabled && !s.pausedReason)
  const needs = mine.some((s) => s.pausedReason === 'edited' || s.pausedReason === 'failures')
  return (
    <Badge tone={needs ? 'warning' : on.length ? 'accent' : 'neutral'} className="shrink-0">
      <Clock className="h-3 w-3" aria-hidden />
      {needs ? 'Needs your OK' : on.length ? (on.length === 1 ? (on[0] as ScheduleSummary).describe : `${on.length} schedules`) : 'Schedule off'}
    </Badge>
  )
}

function LogDialog({ schedule, onClose }: { schedule: ScheduleSummary; onClose: () => void }) {
  const log = useSchedules((s) => s.log)
  const [entries, setEntries] = useState<ScheduleLogEntry[] | null>(null)
  useEffect(() => {
    void log(schedule.id).then(setEntries)
  }, [schedule.id, log])
  return (
    <Modal open onOpenChange={(next) => !next && onClose()} title={`Log of “${schedule.workflowName}”, ${schedule.describe.toLowerCase()}`} className="w-[min(520px,calc(100vw-48px))]">
      <div className="px-6 pt-2 pb-5">
        <p className="text-[13px] text-ink-muted">Times it was missed or skipped, and when it was switched off or on. Its runs are in the workflow’s run history.</p>
        {entries && entries.length === 0 && <p className="mt-3 text-[13px] text-ink-muted">Nothing to report.</p>}
        <ul aria-label="Log" className="mt-3 max-h-[50vh] divide-y divide-edge/70 overflow-y-auto rounded-xl border border-edge empty:hidden">
          {(entries ?? []).map((e) => (
            <li key={e.id} className="flex gap-3 px-4 py-2.5 text-[13px]">
              <span className="w-32 shrink-0 text-ink-muted">{when(e.at)}</span>
              <span className="text-ink">{e.text}</span>
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

function Row({ s, onEdit }: { s: ScheduleSummary; onEdit: () => void }) {
  const setEnabled = useSchedules((x) => x.setEnabled)
  const remove = useSchedules((x) => x.remove)
  const open = useWorkflows((x) => x.open)
  const start = useRuns((x) => x.start)
  const [deleting, setDeleting] = useState(false)
  const [log, setLog] = useState(false)
  const st = stateOf(s)

  // "Run now" is an ordinary run, with the answers and folder of the schedule and the usual card: the way to try a fix without waiting.
  const runNow = async () => {
    await open(s.workflowId)
    await start(s.workflowId, s.inputs, s.folder)
  }

  return (
    <li className="rounded-xl border border-edge bg-field/50 px-4 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <CalendarClock className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-medium text-ink">{s.workflowName}</span>
            {st.badge && <Badge tone={st.badge.tone}>{st.badge.text}</Badge>}
          </div>
          <div className="text-[13px] text-ink-muted">{s.describe}</div>
          <div className="text-[12.5px] text-ink-faint">
            {st.line}
            {s.lastRun ? ` · ${RESULT[s.lastRun.status] ?? 'Ran'}, ${when(s.lastRun.at)}` : ''}
            {s.lastLog && (s.lastLog.kind === 'missed' || s.lastLog.kind === 'skipped') ? ` · ${s.lastLog.text}` : ''}
          </div>
        </div>
        <Switch label={`${s.workflowName}, ${s.describe}: on or off`} checked={s.enabled} onCheckedChange={(on) => void setEnabled(s.id, on)} />
        <Menu.Root>
          <Menu.Trigger asChild>
            <IconButton label={`More about the schedule of ${s.workflowName}`}>
              <MoreHorizontal className="h-[18px] w-[18px]" />
            </IconButton>
          </Menu.Trigger>
          <Menu.Content align="end" className="w-[200px]">
            <Menu.Item onSelect={onEdit}>
              <Pencil className="h-4 w-4 text-ink-muted" /> {s.pausedReason === 'edited' ? 'Look and approve again' : 'Change'}
            </Menu.Item>
            <Menu.Item onSelect={() => void runNow()}>
              <Play className="h-4 w-4 text-ink-muted" /> Run now
            </Menu.Item>
            <Menu.Item onSelect={() => setLog(true)}>
              <ScrollText className="h-4 w-4 text-ink-muted" /> Log
            </Menu.Item>
            <Menu.Item onSelect={() => setDeleting(true)}>
              <Trash2 className="h-4 w-4 text-danger" /> Delete
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </div>
      {log && <LogDialog schedule={s} onClose={() => setLog(false)} />}
      <ConfirmDialog
        open={deleting}
        title="Delete this schedule?"
        confirmLabel="Delete it"
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false)
          void remove(s.id)
        }}
      >
        The workflow stays. It just stops running {s.describe.toLowerCase()}.
      </ConfirmDialog>
    </li>
  )
}

/** Under the list of workflows: every schedule, with its switch. Nothing at all when there are none. */
export function SchedulesList() {
  const list = useSchedules((s) => s.list)
  const paused = useSchedules((s) => s.paused)
  const pauseAll = useSchedules((s) => s.pauseAll)
  const { ask, dialog } = useScheduleDialog()
  if (list.length === 0) return null
  return (
    <section aria-label="Scheduled" className="mt-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Scheduled</h2>
          <p className="mt-0.5 text-[13px] text-ink-muted">These run by themselves, while this computer is on and Celeste is running.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void pauseAll(!paused)} title={paused ? 'Let the schedules run again' : 'Nothing new starts until you resume. Runs that are going carry on.'}>
          {paused ? <PlayCircle className="h-3.5 w-3.5" /> : <PauseCircle className="h-3.5 w-3.5" />} {paused ? 'Resume all' : 'Pause all'}
        </Button>
      </div>
      <ul aria-label="Your schedules" className="mt-3 space-y-2.5">
        {list.map((s) => (
          <Row key={s.id} s={s} onEdit={() => ask(s.workflowId, s)} />
        ))}
      </ul>
      {dialog}
    </section>
  )
}
