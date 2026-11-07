import { useEffect } from 'react'
import { PanelLeft } from 'lucide-react'
import { ChatHome } from '@/features/chat/ChatHome'
import { AddDeviceDialog } from '@/features/devices/AddDeviceDialog'
import { FolderPicker } from '@/features/devices/FolderPicker'
import { ConversationView } from '@/features/chat/ConversationView'
import { ProjectBar } from '@/features/develop/ProjectBar'
import { ChangesPanel, FilesPanel, TerminalPanel } from '@/features/develop/panels'
import { SearchDialog } from '@/features/search/SearchDialog'
import { SettingsDialog } from '@/features/settings/SettingsDialog'
import { ToolsPanel } from '@/features/tools/ToolsPanel'
import { Wizard } from '@/features/wizard/Wizard'
import { WorkflowsScreen } from '@/features/workflows/WorkflowsScreen'
import { Toasts } from '@/components/Toasts'
import { IconButton, TooltipProvider } from '@/components/ui'
import { useSessions } from '@/stores/sessions'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { DevMenu } from './DevMenu'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

function MainPanel() {
  const mode = useUi((s) => s.mode)
  const activeId = useSessions((s) => (mode === 'workflows' ? null : s.active[mode]))
  const send = useSessions((s) => s.send)

  if (mode === 'workflows') return null
  if (activeId) return <ConversationView key={activeId} sessionId={activeId} />
  return (
    <ChatHome
      key={mode}
      mode={mode}
      onSend={(input) => send(mode, input)}
      extras={mode === 'develop' ? <ProjectBar /> : undefined}
    />
  )
}

function RightPanel() {
  const panel = useUi((s) => s.rightPanel)
  const mode = useUi((s) => s.mode)
  if (!panel || mode === 'workflows') return null
  // Develop panels only make sense in Develop.
  if (panel !== 'tools' && mode !== 'develop') return null
  return (
    <div className="animate-slide-in-right h-full w-[400px] shrink-0">
      {panel === 'tools' && <ToolsPanel />}
      {panel === 'changes' && <ChangesPanel />}
      {panel === 'files' && <FilesPanel />}
      {panel === 'terminal' && <TerminalPanel />}
    </div>
  )
}

/** Keyboard shortcuts for the whole window. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const ui = useUi.getState()
      const settings = useSettings.getState()
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        ui.setSearchOpen(true)
      } else if (key === ',') {
        e.preventDefault()
        ui.openSettings()
      } else if (key === 'b') {
        e.preventDefault()
        settings.set({ sidebarCollapsed: !settings.sidebarCollapsed })
      } else if (key === '1' || key === '2' || key === '3') {
        e.preventDefault()
        ui.setMode((['chat', 'develop', 'workflows'] as const)[Number(key) - 1])
      } else if (key === 'n') {
        e.preventDefault()
        const m = ui.mode === 'develop' ? 'develop' : 'chat'
        if (ui.mode === 'workflows') ui.setMode('chat')
        useSessions.getState().home(m)
        ui.resetDraft()
      } else if (key === 'd' && e.shiftKey && import.meta.env.DEV) {
        e.preventDefault()
        ui.setDevMenuOpen(!ui.devMenuOpen)
      }
    }
    // Dropping a file outside a drop zone must not make the window navigate to it.
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])
}

export function App() {
  const bare = new URLSearchParams(window.location.search).get('bare')
  const collapsed = useSettings((s) => s.sidebarCollapsed)
  const set = useSettings((s) => s.set)
  const mode = useUi((s) => s.mode)
  const wizardOpen = useUi((s) => s.wizardOpen)
  useShortcuts()

  // First run: show the setup wizard once.
  useEffect(() => {
    if (!useSettings.getState().wizardDone) useUi.getState().setWizardOpen(true)
  }, [])

  // `?bare=chat` renders the Chat home alone at any size. The comparison script uses it to match the picture.
  if (bare === 'chat') {
    return (
      <TooltipProvider>
        <div className="h-screen w-screen bg-canvas">
          <ChatHome mode="chat" onSend={() => {}} greeting="Good morning" />
        </div>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col bg-canvas text-ink">
        <TopBar />
        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
          {!collapsed && <Sidebar />}
          <main className="relative flex min-w-0 flex-1 gap-3">
            {collapsed && (
              <div className="absolute top-3 left-3 z-30">
                <IconButton label="Show sidebar (Ctrl+B)" onClick={() => set({ sidebarCollapsed: false })}>
                  <PanelLeft className="h-[18px] w-[18px]" />
                </IconButton>
              </div>
            )}
            {mode === 'workflows' ? (
              <WorkflowsScreen />
            ) : (
              <>
                <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-edge bg-panel">
                  <MainPanel />
                </div>
                <RightPanel />
              </>
            )}
          </main>
        </div>
        {wizardOpen && <Wizard />}
        <SettingsDialog />
        <SearchDialog />
        <AddDeviceDialog />
        <FolderPicker />
        <Toasts />
        {import.meta.env.DEV && <DevMenu />}
      </div>
    </TooltipProvider>
  )
}
