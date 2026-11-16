/**
 * Where Excalidraw finds its fonts: the app's own folder. Set before the library is loaded, and as an absolute address: a relative one is joined
 * to the page's origin, which is empty for a `file://` page, and would be ignored (docs/plans/CHAT_DISPLAY_PLAN.md, section 11b).
 */
export function prepareCanvasAssets(): void {
  ;(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL('./', location.href).href
}

let loading: Promise<typeof import('./scene')> | undefined
/** The canvas code, loaded when the first drawing or the panel needs it: a chunk of its own, with the library. */
export function loadScene(): Promise<typeof import('./scene')> {
  prepareCanvasAssets()
  loading ??= import('./scene')
  return loading
}
