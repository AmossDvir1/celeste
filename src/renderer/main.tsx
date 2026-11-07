import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles/index.css'
import { App } from './app/App'
import { bootstrap } from './bootstrap'
import { applyTheme, mirroredTheme, useSettings } from './stores/settings'

// Show the theme from the last run straight away, then the saved one once Core has answered.
const mirrored = mirroredTheme()
if (mirrored) applyTheme(mirrored)
useSettings.subscribe((s, prev) => {
  if (s.theme !== prev.theme) applyTheme(s.theme)
})
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (useSettings.getState().theme === 'system') applyTheme('system')
})

const root = createRoot(document.getElementById('root')!)

function StartupError({ message }: { message: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-canvas p-8 text-ink">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Celeste could not start</h1>
        <p className="mt-3 text-[15px] text-ink-muted">Its storage did not respond, so nothing was changed. {message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 h-10 rounded-lg bg-accent px-5 text-[14px] font-medium text-accent-ink hover:brightness-110"
        >
          Try again
        </button>
      </div>
    </div>
  )
}

bootstrap().then(
  () => {
    applyTheme(useSettings.getState().theme)
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  },
  (err: unknown) => root.render(<StartupError message={err instanceof Error ? err.message : String(err)} />)
)
