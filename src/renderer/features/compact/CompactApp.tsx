import { ConversationView } from '@/features/chat/ConversationView'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { CompactHeader } from './CompactHeader'
import { CompactHome } from './CompactHome'
import { CompactWorkflows } from './CompactWorkflows'

function CompactMain() {
  const mode = useUi((s) => s.mode)
  const activeId = useSessions((s) => (mode === 'workflows' ? null : s.active[mode]))
  if (mode === 'workflows') return <CompactWorkflows />
  if (activeId) return <ConversationView key={activeId} sessionId={activeId} compact />
  return <CompactHome key={mode} mode={mode} />
}

/**
 * The small side window (docs/TRAY_AND_COMPACT_PLAN.md, Part 2): a slim top bar, and under it the session compacted with its message box,
 * or, with none chosen, what the sidebar would have shown. It is the same window and the same stores as the full layout.
 */
export function CompactApp() {
  return (
    <>
      <CompactHeader />
      <div className="min-h-0 flex-1 px-2 pb-2">
        <div className="relative h-full overflow-hidden rounded-xl border border-edge bg-panel">
          <CompactMain />
        </div>
      </div>
    </>
  )
}
