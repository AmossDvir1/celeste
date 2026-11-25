import { ChevronDown } from 'lucide-react'
import { PATTERNS, type MoonsInfo, type Seat } from '@shared/moons'
import { cn } from '@/lib/cn'
import { Popover } from '@/components/menu'
import { ModelControls } from '@/features/chat/controls'
import { useSessions } from '@/stores/sessions'
import type { Session } from '@/stores/types'
import { MoonMark } from './MoonsCards'
import { seatLook, useMoonTheme } from './look'

/**
 * In the chat's header, in place of the model: the two names with a dot each, the one that works lit. It opens a panel with each moon's
 * model, since each can have its own.
 */
export function MoonsHeader({ session, child, moons }: { session: Session; child: Session | undefined; moons: MoonsInfo }) {
  const setPrefs = useSessions((s) => s.setPrefs)
  const theme = useMoonTheme()
  const pattern = moons.pattern
  const pen = PATTERNS[pattern].pen
  const looks = ([0, 1] as Seat[]).map((seat) => seatLook(pattern, seat, theme))
  // No event marks the pen's first step: a chat that works without a turn is the pen at work, or both reviewers.
  const busy = session.status !== 'idle'
  const both = busy && pattern === 'reviews' && session.moonsTurn?.step !== 'answer'
  const seatNow: Seat | undefined = busy ? (session.moonsTurn?.seat ?? pen) : undefined
  const isLit = (seat: Seat) => both || seatNow === seat
  const working = !both && seatNow !== undefined ? looks[seatNow] : undefined
  const names = `${looks[0]?.name} and ${looks[1]?.name}`
  const target = (seat: Seat): Session | undefined => (seat === pen ? session : child)
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={working ? `${names}. ${working.name} is working. Models` : `${names}. Models`}
          className="flex h-7 shrink-0 items-center gap-2 rounded-lg border border-edge-strong bg-pill px-2.5 text-[13px] text-ink-soft transition-colors hover:bg-raised-2 hover:text-ink data-[state=open]:bg-raised-2 data-[state=open]:text-ink"
        >
          <span className="flex items-center gap-1" aria-hidden>
            {looks.map((l) => (
              <span
                key={l.seat}
                className={cn('h-2.5 w-2.5 rounded-full transition-opacity', isLit(l.seat) ? 'opacity-100 ring-2 ring-offset-1 ring-offset-transparent' : busy ? 'opacity-40' : 'opacity-80')}
                style={{ background: `rgb(${l.color.g})`, ['--tw-ring-color' as string]: `rgba(${l.color.g},.35)` }}
              />
            ))}
          </span>
          {names}
          <ChevronDown className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Content className="w-[400px]">
        <div className="flex flex-col gap-3">
          {looks.map((l) => {
            const who = target(l.seat)
            return (
              <div key={l.seat} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5">
                <MoonMark role={l.role} second={l.second} size={34} />
                <b className="font-medium text-ink">{l.name}</b>
                {who ? (
                  <ModelControls prefs={{ model: who.model, effort: who.effort, approval: who.approval }} only={who.vendor} onPrefs={(p) => setPrefs(who.id, { ...(p.model ? { model: p.model } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}) })} compact />
                ) : (
                  <span className="text-xs text-ink-faint">Not loaded yet</span>
                )}
              </div>
            )
          })}
        </div>
        <p className="mt-3 text-xs text-ink-faint">A change takes effect on its next turn.</p>
      </Popover.Content>
    </Popover.Root>
  )
}
