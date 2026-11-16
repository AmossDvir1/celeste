import { convertToExcalidrawElements, exportToBlob, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw'
import { FONT_SIZE, type DrawingColor, type Layout } from '../visuals/drawing'

/*
 * The part of the canvas that touches the library (a chunk of its own, loaded by `loadScene`). A drawing the assistant wrote is placed by
 * `layoutDrawing` (pure); this turns it into Excalidraw's elements, cleans scenes that come from outside, and makes the pictures and the file
 * that go back to the assistant.
 */

type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number]
export type SceneElements = ReturnType<typeof convertToExcalidrawElements>

const PALETTE: Record<DrawingColor, { stroke: string; fill: string }> = {
  default: { stroke: '#1e1e1e', fill: 'transparent' },
  blue: { stroke: '#1971c2', fill: '#a5d8ff' },
  green: { stroke: '#2f9e44', fill: '#b2f2bb' },
  orange: { stroke: '#e8590c', fill: '#ffd8a8' },
  red: { stroke: '#e03131', fill: '#ffc9c9' },
  purple: { stroke: '#9c36b5', fill: '#eebefa' }
}

/** What a scene from outside may not contain: things that load a page or a picture, or follow an address. Never drawn, whatever the scene says. */
const REFUSED = new Set(['embeddable', 'iframe', 'image', 'magicframe', 'frame'])

/** A placed drawing as Excalidraw's elements, arrows bound to their shapes so that moving a shape in the editor takes the arrow with it. */
export function buildElements(layout: Layout): SceneElements {
  const skeleton: Skeleton[] = []
  const kinds = new Map(layout.shapes.map((s) => [s.id, s.kind]))
  for (const s of layout.shapes) {
    const color = PALETTE[s.color]
    if (s.kind === 'text') {
      skeleton.push({ type: 'text', id: s.id, x: s.x, y: s.y, text: s.text, fontSize: FONT_SIZE, strokeColor: color.stroke } as Skeleton)
      continue
    }
    skeleton.push({
      type: s.kind === 'box' ? 'rectangle' : s.kind,
      id: s.id,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      strokeColor: color.stroke,
      backgroundColor: color.fill,
      fillStyle: 'solid',
      ...(s.text ? { label: { text: s.text, fontSize: FONT_SIZE, strokeColor: '#1e1e1e' } } : {})
    } as Skeleton)
  }
  for (const a of layout.arrows) {
    skeleton.push({
      type: 'arrow',
      x: a.x,
      y: a.y,
      points: [
        [0, 0],
        [a.dx, a.dy]
      ],
      // A text shape cannot hold an arrow.
      ...(kinds.get(a.from) !== 'text' ? { start: { id: a.from } } : {}),
      ...(kinds.get(a.to) !== 'text' ? { end: { id: a.to } } : {}),
      ...(a.text ? { label: { text: a.text, fontSize: 16 } } : {})
    } as Skeleton)
  }
  return convertToExcalidrawElements(skeleton)
}

/** A scene from outside (a drawing opened for editing, or a file the person chose) without what is refused, and without any address. */
export function cleanElements(elements: readonly unknown[]): SceneElements {
  return elements
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !REFUSED.has(String((e as { type?: unknown }).type)))
    .map(({ link: _link, customData: _custom, ...rest }) => rest) as unknown as SceneElements
}

export const isBlank = (elements: readonly { isDeleted?: boolean }[]): boolean => elements.every((e) => e.isDeleted)

/** The picture shown in an answer: an SVG with the text and the fonts in it, for the colours of the theme in use. */
export async function exportSvgText(elements: SceneElements, dark: boolean): Promise<string> {
  const svg = await exportToSvg({ elements, appState: { exportWithDarkMode: dark, exportBackground: false, exportEmbedScene: false }, files: null, exportPadding: 12 })
  return new XMLSerializer().serializeToString(svg)
}

/** The picture that goes with a message: light, on white, and at most `max` pixels on its longer side (what a model reads well, and image cost grows with size). */
export async function exportPng(elements: SceneElements, max = 1024): Promise<{ blob: Blob; width: number; height: number }> {
  const blob = await exportToBlob({ elements, appState: { exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: '#ffffff' }, files: null, mimeType: 'image/png', maxWidthOrHeight: max, exportPadding: 16 })
  const bitmap = await createImageBitmap(blob)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return { blob, ...size }
}

/** The drawing as Excalidraw's own file, which the assistant can read and the person can open in Excalidraw. */
export const sceneJson = (elements: SceneElements): string => serializeAsJSON(elements, { viewBackgroundColor: '#ffffff' }, {}, 'local')
