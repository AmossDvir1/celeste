import { Package } from 'lucide-react'
import { DevicesPanelSection } from '@/features/devices/DevicesPanelSection'
import { PanelCard } from '@/components/PanelCard'
import { useUi } from '@/stores/ui'

/**
 * Tools & Integrations. The devices attached to the chat are real. The shared list of MCP tools, which Celeste will
 * pass to whichever vendor runs the session, is not built yet, so it says so instead of listing tools that are not there.
 */
export function ToolsPanel() {
  const setRight = useUi((s) => s.setRight)

  return (
    <PanelCard title="Tools & Integrations" onClose={() => setRight(null)} className="h-full">
      <DevicesPanelSection />
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <Package className="h-8 w-8 text-ink-faint" />
        <div className="text-[14px] text-ink">No tools connected yet</div>
        <div className="text-[13px] text-ink-muted">
          A shared list of tools for every vendor is planned. For now, the agent uses its own built-in tools and the devices attached to this chat.
        </div>
      </div>
    </PanelCard>
  )
}
