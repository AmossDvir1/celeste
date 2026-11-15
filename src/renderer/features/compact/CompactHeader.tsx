import { Maximize2, Pin, PinOff } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Logo } from '@/components/Logo'
import { IconButton } from '@/components/ui'
import { BusyDot, TABS } from '@/app/TopBar'
import { useUi } from '@/stores/ui'

/**
 * The top bar of the small side window: the mark, the three modes as icons, the pin, and the way back to the full window, which sits
 * where the button that made the window small sits in the full one. The native window buttons are drawn over the right edge.
 */
export function CompactHeader() {
  const mode = useUi((s) => s.mode)
  const setMode = useUi((s) => s.setMode)
  const pinned = useUi((s) => s.compactPinned)
  const setPinned = useUi((s) => s.setCompactPinned)
  const setCompact = useUi((s) => s.setCompact)

  return (
    <header
      className="app-drag relative flex h-11 shrink-0 items-center gap-2 pl-3"
      // Leave room for the native window buttons that Electron draws over the right edge.
      style={{
        paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 8px)',
        paddingLeft: window.celeste?.platform === 'darwin' ? 84 : undefined
      }}
    >
      <Logo size={24} />
      <nav aria-label="Modes" className="app-no-drag flex gap-0.5 rounded-xl border border-edge bg-panel/70 p-0.5">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = mode === id
          return (
            <button
              key={id}
              type="button"
              aria-label={label}
              title={label}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMode(id)}
              className={cn(
                'relative flex h-8 w-9 items-center justify-center rounded-[9px] border border-transparent transition-colors',
                active ? 'tab-active' : 'text-ink-muted hover:text-ink'
              )}
            >
              <Icon className="h-[17px] w-[17px]" />
              {!active && <BusyDot mode={id} className="top-1 right-1" />}
            </button>
          )
        })}
      </nav>
      <div className="app-no-drag ml-auto flex items-center gap-0.5">
        <IconButton label={pinned ? 'Unpin window' : 'Pin window on top'} active={pinned} aria-pressed={pinned} onClick={() => setPinned(!pinned)}>
          {pinned ? <Pin className="h-[17px] w-[17px]" /> : <PinOff className="h-[17px] w-[17px]" />}
        </IconButton>
        <IconButton label="Full view (Ctrl+Shift+M)" onClick={() => setCompact(false)}>
          <Maximize2 className="h-[17px] w-[17px]" />
        </IconButton>
      </div>
    </header>
  )
}
