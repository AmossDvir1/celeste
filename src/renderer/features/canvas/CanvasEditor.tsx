import { useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { Download, Eraser, Paperclip } from 'lucide-react'
import type { AttachmentInfo } from '@shared/agent'
import { core } from '@/api'
import { Menu } from '@/components/menu'
import { Button } from '@/components/ui'
import { useThemeName } from '@/features/visuals/chat'
import { useDrafts } from '@/stores/drafts'
import { useCanvas, type Elements } from '@/stores/canvas'
import { useUi } from '@/stores/ui'
import { cleanElements, exportPng, exportSvgText, isBlank, sceneJson, type SceneElements } from './scene'

/** What most of the editor's own chrome offers that Celeste does not use: the library of shapes (it is fetched from the network) and its sidebar button. */
const HIDE = '.celeste-canvas .sidebar-trigger { display: none !important; }'

const MAX_FILES = 10
const say = (text: string) => useUi.getState().pushToast({ text })

/**
 * Puts the drawing in the draft of the message at `key`: a picture (light, on white, at most 1024 px on its longer side) and the scene as
 * Excalidraw's file, which the assistant can read when it needs the exact shapes. The picture is what it looks at first.
 */
async function attachDrawing(key: string, elements: SceneElements): Promise<void> {
  const have = useDrafts.getState().drafts[key]?.attachments.length ?? 0
  if (have + 2 > MAX_FILES) return say(`A message can have ${MAX_FILES} files. Take some off first.`)
  try {
    const png = await exportPng(elements)
    const saved: AttachmentInfo[] = [
      await core.call('attachments.save', { name: 'drawing.png', mime: 'image/png', data: await png.blob.arrayBuffer(), width: png.width, height: png.height }),
      await core.call('attachments.save', { name: 'drawing.excalidraw', mime: 'application/json', data: new TextEncoder().encode(sceneJson(elements)).buffer })
    ]
    useDrafts.getState().setAttachments(key, (cur) => [...cur, ...saved])
    say('The drawing is on your message. Write what you want done with it, then send.')
  } catch {
    say('The drawing could not be added.')
  }
}

/** The drawing board of the canvas panel: Excalidraw, with Celeste's own few buttons under it. Loaded on its own, the first time a drawing is needed. */
export default function CanvasEditor({ sceneKey }: { sceneKey: string }) {
  const theme = useThemeName()
  const revision = useCanvas((s) => s.revisions[sceneKey] ?? 0)
  const api = useRef<{ getSceneElements: () => SceneElements } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [clearKey, setClearKey] = useState(0)

  // What the editor starts from: this place's drawing, read again when one is put in from outside (Edit on a drawing in an answer) or cleared.
  const initial = useMemo(() => cleanElements(useCanvas.getState().scenes[sceneKey] ?? []), [sceneKey, revision, clearKey])
  useEffect(() => () => clearTimeout(saveTimer.current), [])
  // The library's "More tools" menu also offers "Mermaid to Excalidraw", which this build leaves out (it would bring a second copy of Mermaid; Celeste draws
  // Mermaid in a block of its own). That one entry is hidden, so no button is left that fails. It shares its test id with "Web Embed", so it is found by its
  // words, which are always English here: the translations are left out too.
  useEffect(() => {
    const hide = () => {
      for (const item of document.querySelectorAll<HTMLElement>('.dropdown-menu-item')) if (item.textContent?.trim() === 'Mermaid to Excalidraw') item.style.display = 'none'
    }
    const watch = new MutationObserver(hide)
    watch.observe(document.body, { childList: true, subtree: true })
    hide()
    return () => watch.disconnect()
  }, [])

  const elements = (): SceneElements => api.current?.getSceneElements() ?? ([] as unknown as SceneElements)
  const blank = () => {
    if (isBlank(elements())) {
      say('Draw something first.')
      return true
    }
    return false
  }
  const run = async (job: () => Promise<void>) => {
    setBusy(true)
    try {
      await job()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="celeste-canvas flex h-full min-h-0 flex-col">
      <style>{HIDE}</style>
      <div className="relative min-h-0 flex-1">
        <Excalidraw
          key={`${sceneKey}:${revision}:${clearKey}`}
          excalidrawAPI={(a) => {
            api.current = a as unknown as typeof api.current
            // A drawing from an answer is bigger than the panel: zoom out until all of it shows (the library only centres it).
            const els = a.getSceneElements()
            if (els.length) a.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.85, animate: false })
          }}
          initialData={{ elements: initial, appState: { viewBackgroundColor: '#ffffff' }, scrollToContent: true } as never}
          theme={theme === 'light' ? 'light' : 'dark'}
          langCode="en"
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false } }}
          onChange={(els) => {
            // Kept for when the panel is closed and opened again: not on every stroke, but a moment after the last.
            clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => useCanvas.getState().setScene(sceneKey, els as unknown as Elements), 300)
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-edge/70 px-3 py-2.5">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(async () => (blank() ? undefined : attachDrawing(sceneKey, elements())))}>
          <Paperclip className="h-3.5 w-3.5" /> Add to message
        </Button>
        <Menu.Root>
          <Menu.Trigger asChild>
            <Button variant="secondary" size="sm" disabled={busy}>
              <Download className="h-3.5 w-3.5" /> Save…
            </Button>
          </Menu.Trigger>
          <Menu.Content align="start" side="top" className="w-[200px]">
            <Menu.Item
              onSelect={() =>
                void run(async () => {
                  if (blank()) return
                  const png = await exportPng(elements(), 2048)
                  const saved = await window.celeste?.saveBinary('drawing.png', await png.blob.arrayBuffer())
                  if (saved?.saved) say(`Saved ${saved.saved}.`)
                })
              }
            >
              As a picture (PNG)
            </Menu.Item>
            <Menu.Item
              onSelect={() =>
                void run(async () => {
                  if (blank()) return
                  const saved = await window.celeste?.saveText('drawing.svg', await exportSvgText(elements(), false))
                  if (saved?.saved) say(`Saved ${saved.saved}.`)
                })
              }
            >
              As an SVG
            </Menu.Item>
            <Menu.Item
              onSelect={() =>
                void run(async () => {
                  if (blank()) return
                  const saved = await window.celeste?.saveText('drawing.excalidraw', sceneJson(elements()))
                  if (saved?.saved) say(`Saved ${saved.saved}.`)
                })
              }
            >
              As an Excalidraw file
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            useCanvas.getState().setScene(sceneKey, [])
            setClearKey((n) => n + 1)
          }}
        >
          <Eraser className="h-3.5 w-3.5" /> Clear
        </Button>
      </div>
    </div>
  )
}
