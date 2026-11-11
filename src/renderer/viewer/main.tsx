import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/index.css'
import { App, type ViewerFile } from './App'

// The viewer page (docs/FILE_VIEWER_PLAN.md): the file it was opened with, and how to show it, are in its address. It has no connection to
// Celeste and no other way to learn anything.
const q = new URLSearchParams(window.location.search)
document.documentElement.dataset['theme'] = q.get('d') === 'light' ? 'light' : 'dark'
const file: ViewerFile = {
  token: q.get('t') ?? '',
  name: q.get('n') ?? 'File',
  view: q.get('v') ?? 'card',
  label: q.get('l') ?? 'File',
  size: Number(q.get('s') ?? 0),
  note: q.get('c') ?? undefined
}
document.title = file.name

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App file={file} />
  </StrictMode>
)
