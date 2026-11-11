import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { Message } from './ui'
import CardView from './views/CardView'

export interface ViewerFile {
  token: string
  name: string
  /** The view to show it with: one of ViewerView, or 'card'. */
  view: string
  label: string
  size: number
  note?: string | undefined
}

export interface ViewProps {
  file: ViewerFile
  data: ArrayBuffer
}

// Each view is loaded only when it is needed: the Office libraries are large.
const VIEWS: Record<string, LazyExoticComponent<ComponentType<ViewProps>>> = {
  code: lazy(() => import('./views/CodeView')),
  json: lazy(() => import('./views/JsonView')),
  markdown: lazy(() => import('./views/MarkdownView')),
  notebook: lazy(() => import('./views/NotebookView')),
  sheet: lazy(() => import('./views/SheetView')),
  docx: lazy(() => import('./views/DocxView')),
  pptx: lazy(() => import('./views/PptxView')),
  opendoc: lazy(() => import('./views/OpenDocView')),
  rtf: lazy(() => import('./views/RtfView')),
  zip: lazy(() => import('./views/ZipView'))
}

export function App({ file }: { file: ViewerFile }) {
  const [data, setData] = useState<ArrayBuffer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const View = VIEWS[file.view]

  useEffect(() => {
    if (!View) return
    let live = true
    // The file arrives by its token, from the one address the page may read.
    fetch(`/__file/${encodeURIComponent(file.token)}/${encodeURIComponent(file.name)}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status === 413 ? 'This file is too large to show here.' : 'The file could not be read.'))))
      .then((b) => live && setData(b))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'The file could not be read.'))
    return () => {
      live = false
    }
  }, [View, file.token, file.name])

  // Every page is a main landmark with the file's name as its heading, for a screen reader (a card has a heading of its own).
  if (!View) return <Page><CardView file={file} /></Page>
  if (error) return <Page><CardView file={file} note={error} /></Page>
  if (!data) return <Page title={file.name}><Message>Opening {file.name}…</Message></Page>
  return (
    <Page title={file.name}>
      <Suspense fallback={<Message>Opening {file.name}…</Message>}>
        <ViewGuard file={file}>
          <View file={file} data={data} />
        </ViewGuard>
      </Suspense>
    </Page>
  )
}

function Page({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <main>
      {title && <h1 className="sr-only">{title}</h1>}
      {children}
    </main>
  )
}

/** A file the viewer could not make sense of is a message, not a blank page. */
class ViewGuard extends Component<{ file: ViewerFile; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  render() {
    return this.state.error ? <CardView file={this.props.file} note={`This file could not be shown: ${this.state.error}`} /> : this.props.children
  }
}
