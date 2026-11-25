import type { MoonPattern, Seat } from '@shared/moons'
import { cn } from '@/lib/cn'
import { MoonMark } from './MoonsCards'
import { seatLook, useMoonTheme, type SeatLook } from './look'

/** The two moons of a chat, or none when it is an ordinary one. */
export function useMoonLooks(pattern: MoonPattern | undefined): SeatLook[] {
  const theme = useMoonTheme()
  return pattern ? ([0, 1] as Seat[]).map((seat) => seatLook(pattern, seat, theme)) : []
}

/** The moons that match what is typed after "@", in the order of their seats. */
export function mentionLooks(looks: SeatLook[], query: string): SeatLook[] {
  const q = query.toLowerCase()
  return looks.filter((l) => l.name.toLowerCase().includes(q))
}

/** The "@" menu of a Two Moons message: a small row with the two faces, right above the "@". The message box keeps its focus. */
export function MoonMention({ id, looks, index, onPick, onHover }: { id: string; looks: SeatLook[]; index: number; onPick: (i: number) => void; onHover: (i: number) => void }) {
  return (
    <div
      role="listbox"
      id={id}
      aria-label="Message one of them"
      aria-orientation="horizontal"
      onMouseDown={(e) => e.preventDefault()}
      className="animate-fade-up absolute bottom-full left-2 z-30 mb-2 flex items-center gap-1 rounded-full border border-edge-strong bg-raised-2 p-1 shadow-pop"
    >
      {looks.map((l, i) => (
        <div
          key={l.seat}
          id={`${id}-${i}`}
          role="option"
          aria-label={l.name}
          aria-selected={i === index}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(i)
          }}
          className={cn('flex h-8 cursor-pointer items-center gap-1.5 rounded-full pr-3.5 pl-1 text-[13px] whitespace-nowrap transition-colors', i === index ? 'text-ink' : 'text-ink-muted')}
          style={i === index ? { background: `rgba(${l.color.g},.22)` } : undefined}
        >
          <MoonMark role={l.role} second={l.second} size={24} />
          {l.name}
        </div>
      ))}
    </div>
  )
}
