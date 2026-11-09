import '@fontsource-variable/outfit'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { x25519 } from '@noble/curves/ed25519.js'
import { setX25519Fallback } from '@shared/phone'
import { App } from './App'
import { onBack, onResume, setupNotifications } from './native'
import { useApp } from './store'

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
onResume(() => {
  const st = useApp.getState()
  if (st.pairing && st.linkState !== 'connected') st.connect()
  else void st.refresh()
})

if (useApp.getState().pairing) useApp.getState().connect()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
