import { Check, MousePointer2, Pause, Smartphone, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TimelineItem } from '@/stores/types'

const SHOWN = 8

/**
 * The assistant's use of this computer's mouse and keyboard, as one card: why it asked, each thing it did (or was refused), and how it
 * ended. A grant whose end was never written (Celeste was closed) shows as ended once its time is up.
 */
export function DesktopCard({ item }: { item: Extract<TimelineItem, { kind: 'desktop' }> }) {
  const live = !item.ended && item.until > Date.now()
  const hidden = Math.max(0, item.actions.length - SHOWN)
  const shown = item.actions.slice(-SHOWN)
  const phone = item.where === 'phone'
  // The phone's own state (paused by the person's touch) is the last note it sent.
  const paused = phone && live && item.actions.at(-1)?.text.startsWith('Paused')
  const Icon = phone ? Smartphone : MousePointer2
  const minutes = Math.max(1, Math.round((item.until - Date.now()) / 60_000))
  return (
    <div role="group" aria-label={phone ? 'Phone control' : 'Desktop control'} className={cn('animate-fade-up max-w-[760px] rounded-xl border p-4', live ? 'border-warning/50 bg-warning/10' : 'border-edge bg-field')}>
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <Icon className={cn('h-[18px] w-[18px]', live ? 'text-warning' : 'text-ink-muted')} />
        {phone
          ? live
            ? paused
              ? 'Phone control is paused: press Continue on the phone'
              : `The assistant is controlling your phone (up to ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'})`
            : 'The assistant controlled your phone'
          : live
            ? 'The assistant is controlling this computer'
            : 'The assistant controlled this computer'}
      </div>
      <div className="mt-1 text-[13px] text-ink-muted">{item.reason}</div>
      {item.actions.length > 0 && (
        <ul className="mt-2.5 space-y-1 font-mono text-[12.5px]">
          {hidden > 0 && <li className="text-ink-faint">… {hidden} earlier {hidden === 1 ? 'action' : 'actions'}</li>}
          {shown.map((a, i) => (
            <li key={i} className="flex items-start gap-2 text-ink">
              {a.note ? <Pause className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" /> : a.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />}
              <span className="min-w-0 break-words">{a.ok || a.note ? a.text : `Refused: ${a.text}`}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5 text-[12.5px] text-ink-faint">
        {item.ended
          ? `Ended: ${item.ended.why} ${item.ended.actions} ${item.ended.actions === 1 ? 'action' : 'actions'} in all.`
          : live
            ? phone
              ? 'Stop it on the phone: the Stop button on its screen, or volume down three times. Stop here ends it too.'
              : 'Stop it any time with the Stop button on the bar, or Ctrl+Alt+Esc.'
            : 'It ended when the time ran out, or Celeste was closed.'}
      </div>
    </div>
  )
}
