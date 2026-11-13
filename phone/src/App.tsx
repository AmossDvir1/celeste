import { useEffect } from 'react'
import { Info } from 'lucide-react'
import { useApp } from './store'
import { Setup } from './screens/Setup'
import { Home } from './screens/Home'
import { Chat, NewChat } from './screens/Chat'
import { GlowDefs } from './ui'
import { CardSheet } from './CardSheet'
import { PictureViewer } from './Files'

function useTheme() {
  const pref = useApp((s) => s.prefs.theme)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#080c17' : '#f7f8fc')
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [pref])
}

export function App() {
  const screen = useApp((s) => s.screen)
  const toast = useApp((s) => s.toast)
  useTheme()
  return (
    <div className="app">
      <GlowDefs />
      <div className="screen" key={screen.name === 'chat' ? `chat-${screen.id}` : screen.name}>
        {screen.name === 'setup' && <Setup />}
        {screen.name === 'home' && <Home tab={screen.tab} />}
        {screen.name === 'chat' && <Chat id={screen.id} />}
        {screen.name === 'new' && <NewChat />}
      </div>
      <CardSheet />
      <PictureViewer />
      {toast && (
        <div className="toast" key={toast.at}>
          <Info size={18} />
          <span>{toast.text}</span>
          {toast.action && (
            <button className="toast-act" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
