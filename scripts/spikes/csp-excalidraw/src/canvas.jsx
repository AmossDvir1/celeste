import { createRoot } from 'react-dom/client'
import { Excalidraw, convertToExcalidrawElements, exportToBlob, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'

/** What a model would send: a few shapes with labels and arrows between them, as the skeleton. */
export const SKELETON = [
  { type: 'rectangle', id: 'browser', x: 40, y: 80, width: 160, height: 80, label: { text: 'Browser' } },
  { type: 'rectangle', id: 'server', x: 360, y: 80, width: 160, height: 80, label: { text: 'Server' } },
  { type: 'ellipse', id: 'db', x: 380, y: 260, width: 120, height: 90, label: { text: 'Database' } },
  { type: 'arrow', x: 200, y: 120, start: { id: 'browser' }, end: { id: 'server' }, label: { text: 'request' } },
  { type: 'arrow', x: 440, y: 160, start: { id: 'server' }, end: { id: 'db' } },
  { type: 'text', x: 40, y: 20, text: 'Sign-in flow', fontSize: 28 }
]

/** What a hostile scene could hold: things that load a page, an image, or follow a link. */
export const HOSTILE = [
  { type: 'embeddable', x: 0, y: 0, width: 200, height: 120, link: 'https://evil.test/frame' },
  { type: 'iframe', x: 0, y: 0, width: 200, height: 120 },
  { type: 'image', x: 0, y: 150, width: 100, height: 100, fileId: 'remote-1', status: 'saved' },
  { type: 'rectangle', x: 250, y: 0, width: 100, height: 60, link: 'javascript:window.__pwned=1', label: { text: 'click me' } },
  { type: 'rectangle', x: 250, y: 100, width: 100, height: 60, link: 'https://evil.test/link', label: { text: 'link' } }
]

/** The rule the app would apply to an agent's scene before anything is drawn. */
const DROP = new Set(['embeddable', 'iframe', 'image', 'magicframe'])
export function clean(elements) {
  return elements.filter((e) => !DROP.has(e.type)).map(({ link: _link, ...rest }) => rest)
}

export const convert = (skeleton) => convertToExcalidrawElements(skeleton)

let root
export function mount(el, elements, props = {}) {
  root?.unmount()
  root = createRoot(el)
  root.render(<Excalidraw initialData={{ elements, appState: { viewBackgroundColor: '#ffffff' }, scrollToContent: true }} {...props} />)
}
export const unmount = () => root?.unmount()

export async function exportSvg(elements) {
  const svg = await exportToSvg({ elements, appState: { exportWithDarkMode: false, exportBackground: true }, files: {} })
  return svg.outerHTML
}
export async function exportPng(elements) {
  const blob = await exportToBlob({ elements, appState: { exportBackground: true }, files: {}, mimeType: 'image/png' })
  return { size: blob.size, type: blob.type }
}
export const sceneJson = (elements) => serializeAsJSON(elements, { viewBackgroundColor: '#ffffff' }, {}, 'local')
