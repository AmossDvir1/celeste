import { createContext, useContext } from 'react'
import { ShimmerText } from '@/components/ShimmerText'
import { ChartBlock } from './ChartBlock'
import { DrawingBlock } from './DrawingBlock'
import { MermaidBlock } from './MermaidBlock'
import { StepsBlock } from './StepsBlock'
import { useChatWorking } from './chat'
import type { VisualKind } from './spec'

/**
 * The text of a fenced block in the piece being drawn that has not been closed yet (the closing fence has not arrived), or null. The one
 * block whose text is this is still coming in, so it is not drawn until it is whole: no half a diagram, no error for a cut-off one.
 */
export const OpenFence = createContext<string | null>(null)

const NAME: Record<VisualKind, string> = { mermaid: 'diagram', chart: 'chart', steps: 'steps', excalidraw: 'drawing' }

/** A fenced block that is a picture: drawn when it is whole, and while the reply is still arriving a quiet "Drawing…" in its place. */
export function Visual({ kind, source }: { kind: VisualKind; source: string }) {
  const open = useContext(OpenFence)
  const working = useChatWorking()
  if (open !== null && working && open.trim() === source.trim()) {
    return (
      <div className="my-3 max-w-[760px] rounded-xl border border-edge bg-field px-4 py-3 text-[13.5px]" role="status" aria-label={`Drawing the ${NAME[kind]}`}>
        <ShimmerText>Drawing…</ShimmerText>
      </div>
    )
  }
  return kind === 'mermaid' ? <MermaidBlock source={source} /> : kind === 'chart' ? <ChartBlock source={source} /> : kind === 'excalidraw' ? <DrawingBlock source={source} /> : <StepsBlock source={source} />
}
