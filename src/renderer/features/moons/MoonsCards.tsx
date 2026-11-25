import { memo, useState } from 'react'
import { Check, CheckCheck, ChevronRight, CircleAlert, X } from 'lucide-react'
import type { Finding, MoonPattern, MoonRole } from '@shared/moons'
import { cn } from '@/lib/cn'
import type { MoonsMessage, TimelineItem } from '@/stores/types'
import { seatLook, useMoonAvatar, useMoonTheme } from './look'
import { roleColor } from './palette'

type Item<K extends TimelineItem['kind']> = Extract<TimelineItem, { kind: K }>

/** A moon's face, or a plain round dot in its color while the picture is not ready or WebGL is not there. */
export function MoonMark({ role, second, size = 22, className }: { role: MoonRole; second: boolean; size?: number; className?: string }) {
  const url = useMoonAvatar(role, second)
  const theme = useMoonTheme()
  const mid = roleColor(role, second, theme).mid
  return url ? (
    <span aria-hidden className={cn('inline-block shrink-0 bg-contain bg-center bg-no-repeat', className)} style={{ width: size, height: size, backgroundImage: `url(${url})` }} />
  ) : (
    <span aria-hidden className={cn('inline-block shrink-0 rounded-full', className)} style={{ width: Math.round(size * 0.6), height: Math.round(size * 0.6), margin: Math.round(size * 0.2), background: mid }} />
  )
}

/** The message bubble's color: the moon's own at about 20% over the raised surface. */
const bubbleColor = (g: string): string => `color-mix(in srgb, rgb(${g}) 20%, var(--c-raised))`

/* ---------- the hand-over line ---------- */

export const MoonsHandLine = memo(function MoonsHandLine({ item, pattern }: { item: Item<'moonsHand'>; pattern: MoonPattern }) {
  const theme = useMoonTheme()
  const from = seatLook(pattern, item.from, theme)
  const to = seatLook(pattern, item.to, theme)
  return (
    <div className="animate-fade-up flex max-w-[760px] items-center gap-3 text-[12.5px] text-ink-faint">
      <span className="shrink-0">
        <span className="font-medium text-ink-muted">{from.name}</span> hands {item.what} to <span className="font-medium text-ink-muted">{to.name}</span>
      </span>
      <span aria-hidden className="relative h-px min-w-4 flex-1" style={{ background: `linear-gradient(90deg, rgb(${from.color.g}), rgb(${to.color.g}))` }}>
        <span className="absolute -top-[2.5px] right-0 h-1.5 w-1.5 rounded-full" style={{ background: `rgb(${to.color.g})` }} />
      </span>
    </div>
  )
})

/* ---------- the conversation block ---------- */

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

function Bubble({ message, pattern, names }: { message: MoonsMessage; pattern: MoonPattern; names: boolean }) {
  const theme = useMoonTheme()
  const look = seatLook(pattern, message.seat, theme)
  const right = message.seat === 1
  const where = message.file ? `${message.file}${message.line !== undefined ? `:${message.line}` : ''}` : undefined
  return (
    <div className={cn('flex flex-col gap-0.5', right ? 'items-end' : 'items-start')}>
      {names && <span className="px-1 text-[11.5px] text-ink-faint">{look.name}</span>}
      <div
        className={cn('selectable max-w-[min(430px,86%)] rounded-[17px] px-3.5 py-2 text-[14px] leading-[1.45] text-ink', right ? 'rounded-br-[4px]' : 'rounded-bl-[4px]')}
        style={{ background: bubbleColor(look.color.g) }}
      >
        <span className="sr-only">{look.name}: </span>
        {(where || message.code) && (
          <span className="-mx-1 mt-px mb-1.5 block overflow-hidden rounded-[9px] bg-panel/70 px-2.5 py-1 font-mono text-[12px] leading-normal text-ellipsis whitespace-nowrap">
            {where && <small className="block font-sans text-[11.5px] text-ink-muted">{where}</small>}
            {message.code}
          </span>
        )}
        <span className="whitespace-pre-wrap">{message.text}</span>
        <span className="mt-0.5 flex items-center justify-end gap-1.5 text-[11px] leading-[18px] text-ink-faint">
          {message.fixed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success/20 px-2 font-medium text-success">
              <Check className="h-3 w-3" aria-hidden />
              Fixed
            </span>
          )}
          {clock(message.at)}
          <CheckCheck className="h-3.5 w-3.5" style={{ color: `rgb(${look.color.g})` }} aria-hidden />
        </span>
      </div>
    </div>
  )
}

/**
 * What the moons said to each other, in one block that can be folded. While the run goes on it is open; when it has ended it folds by itself
 * to the last message on one line, unless the person has opened or closed it.
 */
export const MoonsTalk = memo(function MoonsTalk({ item, pattern, live }: { item: Item<'moonsTalk'>; pattern: MoonPattern; live: boolean }) {
  const [touched, setTouched] = useState<boolean | null>(null)
  // What a moon said to the person ("@Reviewer what do you think?", a review's verdict) is the answer itself, so it is never folded away.
  const toPerson = item.messages.length > 0 && item.messages.every((m) => m.to === 'person')
  const open = touched ?? (live || toPerson)
  const theme = useMoonTheme()
  const a = seatLook(pattern, 0, theme)
  const b = seatLook(pattern, 1, theme)
  const last = item.messages[item.messages.length - 1]
  const count = item.messages.length
  return (
    <div role="group" aria-label={`${a.name} and ${b.name} talking`} className="animate-fade-up flex max-w-[760px] flex-col gap-2 rounded-2xl border border-edge bg-panel/50 px-4 pt-2.5 pb-3">
      <button type="button" aria-expanded={open} onClick={() => setTouched(!open)} className="flex w-full min-w-0 items-center gap-2.5 rounded-md py-0.5 text-left text-[13px] text-ink-muted hover:text-ink">
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        <span className="flex shrink-0 items-center">
          <MoonMark role={a.role} second={a.second} size={22} />
          <MoonMark role={b.role} second={b.second} size={22} className="-ml-1" />
        </span>
        <b className="shrink-0 font-medium whitespace-nowrap text-ink-soft">
          {a.name} and {b.name}
        </b>
        {!open && last && <span className="min-w-0 flex-1 truncate">{oneLine(last.text)}</span>}
        <em className="ml-auto shrink-0 text-ink-faint not-italic">
          {count} {count === 1 ? 'message' : 'messages'}
        </em>
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          {item.messages.map((m, i) => (
            <Bubble key={m.id} message={m} pattern={pattern} names={i === 0 || item.messages[i - 1]?.seat !== m.seat} />
          ))}
        </div>
      )}
    </div>
  )
})

/* ---------- the plan ---------- */

export const MoonsPlanCard = memo(function MoonsPlanCard({ item, pattern }: { item: Item<'moonsPlan'>; pattern: MoonPattern }) {
  const theme = useMoonTheme()
  const planner = seatLook(pattern, 0, theme)
  return (
    <div role="group" aria-label="The plan" className="animate-fade-up max-w-[760px] rounded-xl border p-4" style={{ borderColor: `rgba(${planner.color.g},.45)`, background: bubbleColor(planner.color.g) }}>
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <MoonMark role={planner.role} second={planner.second} size={22} />
        The plan
      </div>
      {item.say && <p className="selectable mt-2 text-[14px] leading-[1.5] text-ink">{item.say}</p>}
      <ol className="selectable mt-2 list-decimal space-y-1 pl-5 text-[14px] leading-[1.5] text-ink marker:text-ink-muted">
        {item.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {item.agreed && (
        <div className="mt-3 flex items-center gap-1.5 text-[13px] font-medium text-success">
          <Check className="h-3.5 w-3.5" aria-hidden />
          You agreed
        </div>
      )}
    </div>
  )
})

/* ---------- the comparison ---------- */

const whereOf = (f: Finding): string | undefined => (f.file ? `${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : undefined)

function FindingRow({ finding, marks, also }: { finding: Finding; marks: { g: string; name: string }[]; also?: string }) {
  const where = whereOf(finding)
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-[7px] flex shrink-0 gap-0.5" aria-hidden>
        {marks.map((m) => (
          <span key={m.name} className="h-2.5 w-2.5 rounded-full" style={{ background: `rgb(${m.g})` }} />
        ))}
      </span>
      <span className="selectable min-w-0 text-[14px] leading-[1.5] text-ink">
        <span className="sr-only">{marks.map((m) => m.name).join(' and ')}: </span>
        {where && <span className="mr-1.5 font-mono text-[12px] text-ink-muted">{where}</span>}
        {finding.text}
        {finding.code && <span className="mt-0.5 block truncate rounded-md bg-panel/70 px-2 py-0.5 font-mono text-[12px] text-ink-muted">{finding.code}</span>}
        {also && <span className="mt-0.5 block text-[13px] text-ink-muted">{also}</span>}
      </span>
    </li>
  )
}

export const MoonsCompareCard = memo(function MoonsCompareCard({ item, pattern }: { item: Item<'moonsCompare'>; pattern: MoonPattern }) {
  const theme = useMoonTheme()
  const a = seatLook(pattern, 0, theme)
  const b = seatLook(pattern, 1, theme)
  const ma = { g: a.color.g, name: a.name }
  const mb = { g: b.color.g, name: b.name }
  const heading = 'text-[11.5px] font-medium tracking-wide text-ink-faint uppercase'
  return (
    <div role="group" aria-label="What the two reviews found" className="animate-fade-up max-w-[760px] space-y-3 rounded-xl border border-edge bg-panel/50 p-4">
      {item.both.length + item.first.length + item.second.length === 0 && <p className="text-[14px] text-ink-muted">Neither found anything.</p>}
      {item.both.length > 0 && (
        <section aria-label="Found by both">
          <h3 className={heading}>Found by both</h3>
          <ul className="mt-1.5 space-y-2">
            {item.both.map((f, i) => (
              <FindingRow key={i} finding={f} marks={[ma, mb]} />
            ))}
          </ul>
        </section>
      )}
      {item.first.length > 0 && (
        <section aria-label={`Found only by ${a.name}`}>
          <h3 className={heading}>Only {a.name}</h3>
          <ul className="mt-1.5 space-y-2">
            {item.first.map((f, i) => (
              <FindingRow key={i} finding={f} marks={[ma]} />
            ))}
          </ul>
        </section>
      )}
      {item.second.length > 0 && (
        <section aria-label={`Found only by ${b.name}`}>
          <h3 className={heading}>Only {b.name}</h3>
          <ul className="mt-1.5 space-y-2">
            {item.second.map((f, i) => (
              <FindingRow key={i} finding={f} marks={[mb]} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
})

/* ---------- how a run ended ---------- */

export const MoonsEndedLine = memo(function MoonsEndedLine({ item }: { item: Item<'moonsEnded'> }) {
  let text: string
  switch (item.why) {
    case 'rounds': {
      const left = item.left ?? 0
      text = `Two rounds are done, and ${left} ${left === 1 ? 'note is' : 'notes are'} left. Say what you want to do.`
      break
    }
    case 'declined':
      text = 'The plan was not agreed. Say what to change.'
      break
    case 'stopped':
      text = 'You stopped this run.'
      break
    case 'failed':
      text = 'The run could not go on.'
      break
    case 'unread':
      text = 'The answer could not be read as notes, so it is shown as it is.'
      break
    default:
      text = item.note ?? ''
  }
  const bad = item.why === 'failed' || item.why === 'unread'
  const Icon = bad ? CircleAlert : item.why === 'stopped' || item.why === 'declined' ? X : Check
  return (
    <div role="note" className="flex max-w-[760px] flex-col items-center gap-0.5 text-center text-[13px] text-ink-muted">
      <span className="flex items-center gap-1.5">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', bad ? 'text-danger' : 'text-ink-faint')} aria-hidden />
        {text}
      </span>
      {item.why === 'failed' && item.note && <span className="text-[12.5px] text-ink-faint">{item.note}</span>}
    </div>
  )
})
