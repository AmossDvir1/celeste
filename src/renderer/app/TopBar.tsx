import { Code, Laptop, MessageSquare, Moon, Search, Settings, Sparkles, Sun, Workflow } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Logo } from '@/components/Logo'
import { Menu } from '@/components/menu'
import { Avatar, IconButton } from '@/components/ui'
import { useSettings, type ThemePref } from '@/stores/settings'
import { useUi, type AppMode } from '@/stores/ui'

const TABS: { id: AppMode; label: string; icon: typeof Code }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'develop', label: 'Develop', icon: Code },
  { id: 'workflows', label: 'Workflows', icon: Workflow }
]

export function TopBar() {
  const mode = useUi((s) => s.mode)
  const setMode = useUi((s) => s.setMode)
  const setSearchOpen = useUi((s) => s.setSearchOpen)
  const openSettings = useUi((s) => s.openSettings)
  const setWizardOpen = useUi((s) => s.setWizardOpen)
  const userName = useSettings((s) => s.userName)
  const theme = useSettings((s) => s.theme)
  const set = useSettings((s) => s.set)
  const mac = window.celeste?.platform === 'darwin'

  return (
    <header
      className="app-drag relative flex h-14 shrink-0 items-center px-4"
      // Leave room for the native window buttons that Electron draws over the right edge.
      style={{
        paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px)',
        paddingLeft: mac ? 84 : undefined
      }}
    >
      <div className="flex items-center gap-3">
        <Logo size={38} />
        <div className="leading-tight">
          <div className="text-[22px] font-semibold tracking-[-0.01em] text-ink">celeste</div>
          <div className="-mt-0.5 text-xs text-ink-muted">Your AI workbench</div>
        </div>
      </div>

      <nav
        aria-label="Modes"
        className="app-no-drag absolute left-1/2 flex -translate-x-1/2 gap-1 rounded-[14px] border border-edge bg-panel/70 p-1"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = mode === id
          return (
            <button
              key={id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => setMode(id)}
              className={cn(
                'flex h-10 min-w-[118px] items-center justify-center gap-2.5 rounded-[10px] border border-transparent px-5 text-[15px] transition-colors',
                active ? 'tab-active' : 'text-ink-muted hover:text-ink'
              )}
            >
              <Icon className="h-[19px] w-[19px]" />
              {label}
            </button>
          )
        })}
      </nav>

      <div className="app-no-drag ml-auto flex items-center gap-1.5">
        <IconButton label="Search (Ctrl+K)" onClick={() => setSearchOpen(true)}>
          <Search className="h-[19px] w-[19px]" />
        </IconButton>

        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              type="button"
              aria-label={`Account menu for ${userName}`}
              className="ml-1 rounded-full outline-offset-2 transition-opacity hover:opacity-85"
            >
              <Avatar name={userName} size={38} />
            </button>
          </Menu.Trigger>
          <Menu.Content align="end" className="w-[230px]">
            <div className="px-2.5 pt-1.5 pb-2">
              <div className="text-sm font-medium text-ink">{userName}</div>
              <div className="text-xs text-ink-faint">Signed in on this computer</div>
            </div>
            <Menu.Separator />
            <Menu.Label>Theme</Menu.Label>
            <Menu.RadioGroup value={theme} onValueChange={(v) => set({ theme: v as ThemePref })}>
              <Menu.RadioItem value="dark">
                <span className="flex items-center gap-2">
                  <Moon className="h-4 w-4" /> Dark
                </span>
              </Menu.RadioItem>
              <Menu.RadioItem value="light">
                <span className="flex items-center gap-2">
                  <Sun className="h-4 w-4" /> Light
                </span>
              </Menu.RadioItem>
              <Menu.RadioItem value="system">
                <span className="flex items-center gap-2">
                  <Laptop className="h-4 w-4" /> System
                </span>
              </Menu.RadioItem>
            </Menu.RadioGroup>
            <Menu.Separator />
            <Menu.Item onSelect={() => openSettings()}>
              <Settings className="h-4 w-4 text-ink-muted" /> Settings
            </Menu.Item>
            <Menu.Item onSelect={() => setWizardOpen(true)}>
              <Sparkles className="h-4 w-4 text-ink-muted" /> Run setup again
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </div>
    </header>
  )
}
