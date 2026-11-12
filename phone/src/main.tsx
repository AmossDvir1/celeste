import '@fontsource-variable/outfit'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { x25519 } from '@noble/curves/ed25519.js'
import { setX25519Fallback } from '@shared/phone'
import { App } from './App'
import { onBack, onResume, onShared, screen, setupNotifications } from './native'
import { useShare } from './Share'
import { restorePairing, useApp } from './store'

// Older WebViews (before Chrome 133) have no X25519 in WebCrypto: the audited pure-JS one stands in.
setX25519Fallback({
  keyPair: () => {
    const priv = x25519.utils.randomSecretKey()
    return { priv, pub: x25519.getPublicKey(priv) }
  },
  shared: (priv, peerPub) => x25519.getSharedSecret(priv, peerPub)
})

// Approve and Deny straight from a notification, and tapping one opens its chat.
void setupNotifications((action, extra) => {
  const st = useApp.getState()
  if (!extra?.sessionId) return
  if (action === 'allow' || action === 'deny') {
    if (extra.requestId) void st.approve(extra.sessionId, extra.requestId, action === 'allow')
    return
  }
  void st.openChat(extra.sessionId)
})
onBack(() => useApp.getState().back())
// "Show phone screen" was pressed on the computer while the app is open: Android's dialog comes up at once.
useApp.subscribe((s, before) => {
  if (s.shareAsked !== before.shareAsked) void useShare.getState().start()
})
// ... or it was pressed while the app was closed or away: the notification opened the app, which asks now.
const shareIfAsked = () => void screen.takeAsked().then((yes) => yes && void useShare.getState().start())
shareIfAsked()
onResume(() => {
  shareIfAsked()
  const st = useApp.getState()
  if (!st.pairing) return
  // The WebView froze the page while it was hidden, and a stream open across that never delivers again: a new one says
  // connected, which reads the open chat again.
  if (st.linkState === 'connected' && st.link) st.link.reopen()
  else st.connect()
})

// The pairing is read from the Keystore-encrypted store first, so the app never shows Setup to a phone that is paired.
void restorePairing().finally(() => {
  if (useApp.getState().pairing) useApp.getState().connect()
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
  // Share → Celeste from another app: a new chat with the text written in, ready to send (once the phone is paired).
  onShared((text) => {
    const st = useApp.getState()
    if (!st.pairing) return st.say('Connect Celeste to your computer first, then share again.')
    useApp.setState({ shared: text })
    if (st.screen.name !== 'new') st.go({ name: 'new' })
  })
})
