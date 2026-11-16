import { create } from 'zustand'
import { chatNow } from '@/features/visuals/chat'
import { useUi } from './ui'

/** The elements of a scene, kept without the library's own types: the library is only loaded when a drawing is needed. */
export type Elements = readonly Record<string, unknown>[]

/** Where the canvas belongs: the chat that is open, or the page where a new one starts. Null on the workflows screen. */
export function canvasTarget(): string | null {
  const { mode } = useUi.getState()
  if (mode === 'workflows') return null
  return chatNow()?.id ?? `home:${mode}`
}

/**
 * The drawing in the canvas panel, for each place it can be opened (a chat, or a new one). Kept while the window is open, so closing the panel
 * and opening it again, or going to another chat and back, does not lose it. Not saved to disk: a drawing that matters is sent with a message.
 */
interface CanvasState {
  scenes: Record<string, Elements>
  /** Bumped when a scene is put in from outside, so the editor starts again from it. */
  revisions: Record<string, number>
  setScene: (key: string, elements: Elements) => void
  /** Shows the panel, with `elements` in it (replacing what is there) when given. */
  open: (elements?: Elements) => void
}

export const useCanvas = create<CanvasState>()((set) => ({
  scenes: {},
  revisions: {},
  setScene: (key, elements) => set((s) => ({ scenes: { ...s.scenes, [key]: elements } })),
  open: (elements) => {
    const key = canvasTarget()
    if (!key) return
    if (elements) set((s) => ({ scenes: { ...s.scenes, [key]: elements }, revisions: { ...s.revisions, [key]: (s.revisions[key] ?? 0) + 1 } }))
    useUi.getState().setRight('canvas')
  }
}))

/** Whether there is anything drawn in the canvas at `key`. */
export const hasDrawing = (key: string | null): boolean => !!key && (useCanvas.getState().scenes[key] ?? []).some((e) => !e.isDeleted)
