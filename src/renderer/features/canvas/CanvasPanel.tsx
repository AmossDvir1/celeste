import { Suspense, lazy } from 'react'
import { PanelCard } from '@/components/PanelCard'
import { Spinner } from '@/components/ui'
import { useSessions } from '@/stores/sessions'
import { useUi } from '@/stores/ui'
import { prepareCanvasAssets } from './assets'

// The library and the editor are a chunk of their own, fetched the first time the panel opens.
const CanvasEditor = lazy(() => {
  prepareCanvasAssets()
  return import('./CanvasEditor')
})

/** The drawing panel beside the chat (docs/plans/CHAT_DISPLAY_PLAN.md, section 5): draw, undo, clear, save, or add the drawing to the message. */
export function CanvasPanel() {
  const setRight = useUi((s) => s.setRight)
  const mode = useUi((s) => s.mode)
  const chat = useSessions((s) => (mode === 'workflows' ? null : (s.active[mode] ?? null)))
  // One drawing for each chat, and one for the page where a new chat starts.
  const key = mode === 'workflows' ? null : (chat ?? `home:${mode}`)
  return (
    <PanelCard title="Drawing" onClose={() => setRight(null)} className="h-full" bodyClassName="overflow-hidden">
      {key && (
        <Suspense
          fallback={
            <p role="status" className="flex items-center gap-2 p-4 text-[13px] text-ink-muted">
              <Spinner className="h-3.5 w-3.5" /> Opening the canvas…
            </p>
          }
        >
          <CanvasEditor key={key} sceneKey={key} />
        </Suspense>
      )}
    </PanelCard>
  )
}
