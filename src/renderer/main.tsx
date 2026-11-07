import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles/index.css'
import { App } from './app/App'
import { applyTheme, useSettings } from './stores/settings'

// Apply the saved theme before the first paint, and follow the system when asked to.
applyTheme(useSettings.getState().theme)
useSettings.subscribe((s, prev) => {
  if (s.theme !== prev.theme) applyTheme(s.theme)
})
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (useSettings.getState().theme === 'system') applyTheme('system')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
