import { Plus, Settings2, Terminal, Globe } from 'lucide-react'
import { DevicesPanelSection } from '@/features/devices/DevicesPanelSection'
import { PanelCard } from '@/components/PanelCard'
import { Button, Switch } from '@/components/ui'
import { useMcp } from '@/stores/mcp'
import { useUi } from '@/stores/ui'
import { McpStatusBadge } from './McpSettings'

/**
 * Tools & Integrations: the tools the person added (given to every vendor) and the devices attached to this chat.
 * The full list, with how to change each, is in Settings.
 */
export function ToolsPanel() {
  const setRight = useUi((s) => s.setRight)
  const openSettings = useUi((s) => s.openSettings)
  const servers = useMcp((s) => s.servers)
  const setEnabled = useMcp((s) => s.setEnabled)
  const setEditing = useMcp((s) => s.setEditing)

  return (
    <PanelCard title="Tools & Integrations" onClose={() => setRight(null)} className="h-full">
      <section aria-label="Tools" className="border-b border-edge px-4 pt-3 pb-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-medium tracking-wide text-ink-muted uppercase">Tools</h3>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" aria-label="Add a tool" onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" aria-label="Manage tools" onClick={() => openSettings('tools')}>
              <Settings2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {servers.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-muted">No tools yet. Add an internal tool once and the assistant of any vendor can use it.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {servers.map((s) => {
              const Icon = s.type === 'stdio' ? Terminal : Globe
              return (
                <li key={s.id} className="flex items-center gap-3 rounded-xl px-2 py-2">
                  <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[14px] text-ink">{s.name}</span>
                    <McpStatusBadge status={s.status} enabled={s.enabled} />
                  </span>
                  <Switch label={`${s.name} on`} checked={s.enabled} onCheckedChange={(v) => void setEnabled(s.id, v)} />
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">A change applies to chats you start afterwards.</p>
      </section>
      <DevicesPanelSection />
    </PanelCard>
  )
}
