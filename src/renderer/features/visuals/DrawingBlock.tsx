import { useEffect, useMemo, useState } from 'react'
import { Expand, PencilRuler } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Modal } from '@/components/Dialog'
import { Button } from '@/components/ui'
import { loadScene } from '@/features/canvas/assets'
import { canvasTarget, hasDrawing, useCanvas, type Elements } from '@/stores/canvas'
import { ErrorNote } from './ErrorNote'
import { useThemeName } from './chat'
import { layoutDrawing, parseDrawing } from './drawing'

/**
 * A drawing an assistant wrote in an ```excalidraw block: placed here (the app works out where the shapes and arrows go), drawn by the library as
 * a picture, shown as an image (nothing in it can run), with **Expand** to see it large and **Edit** to open it in the canvas, where the person can
 * change it and send it back. The library is a chunk of its own, loaded when the first drawing is shown.
 */
export function DrawingBlock({ source }: { source: string }) {
  const theme = useThemeName()
  const checked = useMemo(() => parseDrawing(source), [source])
  const layout = useMemo(() => (checked.ok ? layoutDrawing(checked.value) : null), [checked])
  const [drawn, setDrawn] = useState<{ url: string; elements: Elements } | { error: string } | null>(null)
  const [large, setLarge] = useState(false)
  const [replacing, setReplacing] = useState(false)

  useEffect(() => {
    if (!checked.ok || !layout) {
      setDrawn({ error: checked.ok ? 'It could not be placed.' : checked.error })
      return
    }
    let cancelled = false
    let url: string | undefined
    void (async () => {
      try {
        const scene = await loadScene()
        const elements = scene.buildElements(layout)
        const svg = await scene.exportSvgText(elements, theme !== 'light')
        // An image: whatever is in the picture is only ever looked at, and cannot run.
        url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
        if (!cancelled) setDrawn({ url, elements: elements as unknown as Elements })
      } catch (err) {
        if (!cancelled) setDrawn({ error: err instanceof Error ? err.message.split('\n')[0]?.slice(0, 300) || 'The drawing could not be made.' : 'The drawing could not be made.' })
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [checked, layout, theme])

  if (drawn && 'error' in drawn) return <ErrorNote kind="excalidraw" error={drawn.error} source={source} />
  const summary = checked.ok ? (checked.value.summary ?? checked.value.title) : undefined
  const edit = () => {
    if (!drawn || 'error' in drawn) return
    if (hasDrawing(canvasTarget())) setReplacing(true)
    else useCanvas.getState().open(drawn.elements)
  }

  return (
    <figure role="img" aria-label={summary ?? 'Drawing'} className="my-3 max-w-[760px] overflow-hidden rounded-xl border border-edge bg-field p-3">
      {drawn && 'url' in drawn ? (
        <img src={drawn.url} alt="" draggable={false} className="mx-auto block h-auto max-h-[420px] max-w-full" />
      ) : (
        <div className="h-24 animate-pulse rounded-lg bg-raised/60" aria-hidden />
      )}
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-[12.5px] text-ink-muted">{summary}</span>
        {drawn && 'url' in drawn && (
          <span className="flex shrink-0 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setLarge(true)} aria-label="Expand the drawing">
              <Expand className="h-3.5 w-3.5" /> Expand
            </Button>
            {canvasTarget() && (
              <Button variant="ghost" size="sm" onClick={edit} aria-label="Edit the drawing in the canvas">
                <PencilRuler className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </span>
        )}
      </figcaption>
      {large && drawn && 'url' in drawn && (
        <Modal open onOpenChange={(open) => !open && setLarge(false)} title={summary ?? 'Drawing'} className="w-[min(1100px,calc(100vw-48px))]">
          <div className="max-h-[calc(88vh-72px)] overflow-auto px-6 pt-3 pb-6">
            <img src={drawn.url} alt={summary ?? 'Drawing'} draggable={false} className="mx-auto block h-auto max-w-full" />
          </div>
        </Modal>
      )}
      <ConfirmDialog
        open={replacing}
        title="Replace the drawing in the canvas?"
        confirmLabel="Replace it"
        onCancel={() => setReplacing(false)}
        onConfirm={() => {
          setReplacing(false)
          if (drawn && 'elements' in drawn) useCanvas.getState().open(drawn.elements)
        }}
      >
        The canvas has a drawing in it. Opening this one there replaces it.
      </ConfirmDialog>
    </figure>
  )
}
