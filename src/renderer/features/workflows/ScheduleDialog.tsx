import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, ChevronRight, ShieldQuestion } from 'lucide-react'
import { DEFAULT_GRACE_SEC, DEFAULT_WAIT_LIMIT_SEC, describeSpec, type NotifyWhen, type SchedulePreview, type ScheduleSummary } from '@shared/schedule'
import { checkInputs, type InputDef } from '@shared/workflow'
import { Field, SelectField } from '@/components/form'
import { Modal } from '@/components/Dialog'
import { Button, Checkbox, Segmented, Spinner, TextInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useSchedules } from '@/stores/schedules'
import { FolderField, InputFields, answersFrom, initialAnswers } from './RunFields'
import { ActionList } from './RunParts'
import { KINDS, KIND_LABEL, LATE_CHOICES, NOTIFY_CHOICES, WAIT_CHOICES, atWords, emptyForm, formFromSpec, specFromForm, withValue, type WhenForm } from './scheduleForm'

const DAYS = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' }
]

const computerZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** The card the person approves: what every run will do, how often, and what it costs. Drawn from what Core says a run would do. */
export function ScheduleCard({ preview, spec, name }: { preview: SchedulePreview; spec: string; name: string }) {
  return (
    <section role="group" aria-label="What this schedule will do" className="rounded-xl border border-accent-edge bg-accent-soft/50 p-4">
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <ShieldQuestion className="h-[18px] w-[18px] shrink-0 text-accent-text" /> {spec}, Celeste will do this for “{name}”, without asking again.
      </div>
      {preview.actions.length > 0 ? <ActionList actions={preview.actions} /> : <p className="mt-2 text-[13px] text-ink-muted">This workflow has nothing to do yet.</p>}
      {preview.agentSteps > 0 && (
        <p className="mt-2.5 text-xs text-ink-muted">
          {preview.agentSteps === 1 ? '1 assistant step' : `${preview.agentSteps} assistant steps`} in every run, which spend your assistant allowance while nobody is watching.
        </p>
      )}
    </section>
  )
}

/**
 * Makes a schedule, or changes one. Pressing the button is the approval: the card above it says what every run will do, and the run
 * starts with no card of its own. A change to the workflow, the answers or the folder asks again (Core pauses the schedule).
 */
export function ScheduleDialog({ workflowId, name, inputs, existing, onClose }: { workflowId: string; name: string; inputs: InputDef[]; existing?: ScheduleSummary; onClose: () => void }) {
  const preview = useSchedules((s) => s.preview)
  const save = useSchedules((s) => s.save)
  const [when, setWhen] = useState<WhenForm>(() => (existing ? formFromSpec(existing.spec) : emptyForm()))
  const [values, setValues] = useState(() => (existing ? answersFrom(inputs, existing.inputs) : initialAnswers(inputs)))
  const [folder, setFolder] = useState(existing?.folder ?? '')
  const [grace, setGrace] = useState(existing?.graceSec ?? DEFAULT_GRACE_SEC)
  const [wait, setWait] = useState(existing?.waitLimitSec ?? DEFAULT_WAIT_LIMIT_SEC)
  const [notify, setNotify] = useState<NotifyWhen>(existing?.notify ?? 'problems')
  const [more, setMore] = useState(false)
  const [seen, setSeen] = useState<SchedulePreview | null>(null)
  const [looking, setLooking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Starting Celeste when the person signs in: the system holds the answer. Absent where it cannot be done (not the installed Windows app).
  const [login, setLogin] = useState<{ available: boolean; enabled: boolean } | null>(null)
  const [startAtSignIn, setStartAtSignIn] = useState(false)
  const zone = useMemo(computerZone, [])

  useEffect(() => {
    void window.celeste?.loginItem.get().then(
      (state) => {
        setLogin(state)
        setStartAtSignIn(state.enabled)
      },
      () => undefined
    )
  }, [])

  const spec = useMemo(() => specFromForm(when), [when])
  const words = spec ? describeSpec(spec, zone) : ''

  // What a run would do and when the next ones are: asked of Core as the person types, once they stop for a moment.
  useEffect(() => {
    if (!spec) {
      setSeen(null)
      return
    }
    let alive = true
    setLooking(true)
    const t = setTimeout(() => {
      void preview({ workflowId, inputs: values, spec, timezone: zone }).then((p) => {
        if (!alive) return
        setSeen(p)
        setLooking(false)
      })
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [spec, values, workflowId, zone, preview])

  const problems = [...(seen?.problems ?? [])]
  const can = spec !== null && seen !== null && problems.length === 0 && !looking && !saving

  const go = async () => {
    if (!spec) return
    try {
      checkInputs(inputs, values)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Check the answers.')
      return
    }
    setProblem(null)
    setSaving(true)
    const saved = await save({ ...(existing ? { id: existing.id } : {}), workflowId, spec, inputs: values, folder, timezone: zone, graceSec: grace, waitLimitSec: wait, notify })
    // Asked once, here, and only changed when the person changed it.
    if (saved && login?.available && startAtSignIn !== login.enabled) await window.celeste?.loginItem.set(startAtSignIn).catch(() => undefined)
    setSaving(false)
    if (saved) onClose()
  }

  const set = (patch: Partial<WhenForm>) => setWhen({ ...when, ...patch })

  return (
    <Modal open onOpenChange={(next) => !next && onClose()} title={existing ? `Change the schedule of “${name}”` : `Schedule “${name}”`} className="w-[min(560px,calc(100vw-48px))]">
      <form
        className="max-h-[calc(88vh-64px)] space-y-4 overflow-y-auto px-6 pt-2 pb-5"
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
      >
        {existing?.pausedReason === 'edited' && <p className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-[13px] text-ink">The workflow changed since you approved this. Look at what it will do now, and approve it again.</p>}
        {existing?.pausedReason === 'failures' && <p className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-[13px] text-ink">This was switched off because it failed 3 times in a row. Saving it switches it on again.</p>}

        <Field label="When">
          {(id) => (
            <SelectField id={id} value={when.kind} onChange={(e) => set({ kind: e.target.value as WhenForm['kind'] })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </SelectField>
          )}
        </Field>

        {when.kind === 'once' && (
          <Field label="Date and time">{(id) => <TextInput id={id} type="datetime-local" value={when.at} onChange={(e) => set({ at: e.target.value })} />}</Field>
        )}
        {when.kind === 'every' && (
          <div className="flex items-end gap-2">
            <Field label="Every" className="w-28">
              {(id) => <TextInput id={id} inputMode="decimal" value={when.every} onChange={(e) => set({ every: e.target.value })} />}
            </Field>
            <div className="pb-0.5">
              <Segmented
                label="Minutes or hours"
                value={when.unit}
                onChange={(unit) => set({ unit })}
                options={[
                  { value: 'minutes', label: 'minutes' },
                  { value: 'hours', label: 'hours' }
                ]}
              />
            </div>
          </div>
        )}
        {(when.kind === 'daily' || when.kind === 'weekly' || when.kind === 'monthly') && (
          <Field label="At">{(id) => <TextInput id={id} type="time" value={when.time} onChange={(e) => set({ time: e.target.value })} className="w-40" />}</Field>
        )}
        {when.kind === 'daily' && <Checkbox label="Weekdays only (Monday to Friday)" checked={when.weekdaysOnly} onChange={(weekdaysOnly) => set({ weekdaysOnly })} />}
        {when.kind === 'weekly' && (
          <div role="group" aria-label="Days of the week" className="flex flex-wrap gap-1.5">
            {DAYS.map((d) => {
              const on = when.days.includes(d.day)
              return (
                <button
                  key={d.day}
                  type="button"
                  aria-pressed={on}
                  aria-label={d.long}
                  onClick={() => set({ days: on ? when.days.filter((x) => x !== d.day) : [...when.days, d.day] })}
                  className={cn('h-9 min-w-12 rounded-lg border px-2.5 text-[13px] font-medium transition-colors', on ? 'border-accent-edge bg-accent-soft text-accent-text' : 'border-edge bg-field text-ink-muted hover:text-ink')}
                >
                  {d.short}
                </button>
              )
            })}
          </div>
        )}
        {when.kind === 'monthly' && (
          <Field label="On day" hint="Days a short month does not have run on its last day.">
            {(id) => (
              <SelectField id={id} value={when.day} onChange={(e) => set({ day: e.target.value })} className="w-48">
                {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                  <option key={d} value={d}>
                    {d === '31' ? 'The last day' : d}
                  </option>
                ))}
              </SelectField>
            )}
          </Field>
        )}

        {inputs.length > 0 && <InputFields inputs={inputs} values={values} onChange={setValues} />}
        <FolderField folder={folder} onChange={setFolder} />

        <div>
          <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-ink">
            <ChevronRight className={cn('h-4 w-4 transition-transform', more && 'rotate-90')} /> More choices
          </button>
          {more && (
            <div className="mt-3 space-y-3 rounded-xl border border-edge p-3.5">
              <Field label="If Celeste was closed at the time, still run it when it is late by up to" hint="Later than that, the run is skipped and the history says so. It never runs once for each time it missed.">
                {(id) => (
                  <SelectField id={id} value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
                    {withValue(LATE_CHOICES, grace).map((c) => (
                      <option key={c.sec} value={c.sec}>
                        {c.label}
                      </option>
                    ))}
                  </SelectField>
                )}
              </Field>
              <Field label="If a run asks you something, wait" hint="Then the run is stopped and counts as a failure.">
                {(id) => (
                  <SelectField id={id} value={wait} onChange={(e) => setWait(Number(e.target.value))}>
                    {withValue(WAIT_CHOICES, wait).map((c) => (
                      <option key={c.sec} value={c.sec}>
                        {c.label}
                      </option>
                    ))}
                  </SelectField>
                )}
              </Field>
              <Field label="Tell me">
                {(id) => (
                  <SelectField id={id} value={notify} onChange={(e) => setNotify(e.target.value as NotifyWhen)}>
                    {NOTIFY_CHOICES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </SelectField>
                )}
              </Field>
            </div>
          )}
        </div>

        {seen && seen.next.length > 0 && problems.length === 0 && (
          <p className="text-[13px] text-ink-muted">
            <span className="text-ink">Next:</span> {seen.next.slice(0, 3).map(atWords).join(', then ')}
          </p>
        )}
        {looking && !seen && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-ink-muted">
            <Spinner className="h-3.5 w-3.5" /> Working out what it will do…
          </p>
        )}
        {problems.length > 0 && (
          <ul role="alert" className="space-y-1 text-[13px] text-danger">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {seen && problems.length === 0 && <ScheduleCard preview={seen} spec={words} name={name} />}

        {problem && (
          <p role="alert" className="text-[13px] text-danger">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!can}>
            <CalendarClock className="h-4 w-4" /> {existing ? 'Approve and save' : 'Schedule'}
          </Button>
        </div>
        {login?.available && <Checkbox label="Start Celeste when I sign in, so this runs without opening it" checked={startAtSignIn} onChange={setStartAtSignIn} />}
        <p className="text-xs text-ink-faint">Runs while this computer is on and Celeste is running. Times are in {zone.replace(/_/g, ' ')}.</p>
      </form>
    </Modal>
  )
}
