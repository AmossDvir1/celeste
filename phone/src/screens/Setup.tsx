import { useEffect, useRef, useState } from 'react'
import { Check, Monitor, Smartphone, Wifi } from 'lucide-react'
import { hello, pair, type PhonePairing } from '@shared/phone-client'
import { deviceName, discover, isNative } from '../native'
import { useApp } from '../store'
import { Arc, Logo, Shimmer, buzz, rise } from '../ui'

type Phase = 'search' | 'list' | 'manual' | 'pairing' | 'done'
interface Target {
  name: string
  base: string
}

/** "Celeste on DANA-PC" → "DANA-PC" */
const computerName = (announced: string) => announced.replace(/^Celeste on /, '')

/** Turns what the person typed (192.168.1.5:41234, or a whole link) into the computer's address. */
export function baseFrom(text: string): string | null {
  const t = text.trim().replace(/\/+$/, '')
  if (!t) return null
  const withScheme = /^https?:\/\//i.test(t) ? t : `http://${t}`
  try {
    const u = new URL(withScheme)
    if (!u.port) return null
    return `${u.protocol}//${u.hostname}:${u.port}`
  } catch {
    return null
  }
}

/** First launch: find Celeste on the Wi-Fi, compare three pictures, and the person presses Allow on the computer. */
export function Setup() {
  const removed = useApp((s) => s.removed)
  const [phase, setPhase] = useState<Phase>(isNative ? 'search' : 'manual')
  const [found, setFound] = useState<Target[]>([])
  const [target, setTarget] = useState<Target | null>(null)
  const [emoji, setEmoji] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const result = useRef<PhonePairing | null>(null)
  const abort = useRef<AbortController | null>(null)

  const search = async () => {
    setPhase('search')
    setError(null)
    const list = await discover(5000)
    const targets = list.map((f) => ({ name: computerName(f.name), base: `http://${f.host}:${f.port}` }))
    setFound(targets)
    setPhase(targets.length ? 'list' : 'manual')
    if (targets.length) buzz(10)
  }

  useEffect(() => {
    if (isNative) void search()
    return () => abort.current?.abort()
  }, [])

  const connect = async (t: Target) => {
    setTarget(t)
    setEmoji([])
    setError(null)
    setPhase('pairing')
    abort.current = new AbortController()
    try {
      result.current = await pair(t.base, await deviceName(), (e) => {
        setEmoji(e)
        buzz(12)
      }, { signal: abort.current.signal })
      buzz(20)
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.')
      setPhase(found.length ? 'list' : 'manual')
    }
  }

  const connectTyped = async () => {
    const base = baseFrom(address)
    if (!base) {
      setError('Type the address and port Celeste shows in Settings, Phone, like 192.168.1.5:41234.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const h = await hello(base)
      await connect({ name: h.name, base })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Celeste did not answer at that address.')
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'done' && target) {
    const cols = ['#f45f9d', '#c06ae0', '#8f8aff', '#31d0aa', '#f6c85f', '#55c7ff', '#f5487f', '#b45af0']
    return (
      <div className="pair">
        <Arc />
        <div className="spacer above" style={{ flex: 0.7 }} />
        <div className="above" style={{ position: 'relative' }}>
          <div className="okcircle">
            <Check size={48} strokeWidth={2} className="draw" />
          </div>
          <div className="burst">
            {cols.map((c, i) => (
              <i key={c} style={{ ['--r' as string]: `${i * 45 + 20}deg`, ['--c' as string]: c }} />
            ))}
          </div>
        </div>
        <div className="overline above rise" style={{ ['--i' as string]: 2, marginTop: 10 }}>
          Paired with {target.name}
        </div>
        <h1 className="h-xl above rise" style={{ ['--i' as string]: 3 }}>
          You’re <span className="grad">connected.</span>
        </h1>
        <p className="muted above rise" style={{ ['--i' as string]: 4, margin: 0 }}>
          Chat with Celeste from here, and answer what it asks.
        </p>
        <div className="spacer" />
        <button className="btn primary big block shine above rise" style={{ ['--i' as string]: 5 }} onClick={() => result.current && useApp.getState().paired(result.current)}>
          Go to chats
        </button>
      </div>
    )
  }

  if (phase === 'pairing' && target) {
    return (
      <div className="pair">
        <Arc soft />
        <div className="spacer above" style={{ flex: 0.5 }} />
        <div className="link-viz above rise" style={{ ['--i' as string]: 0 }}>
          <span className="end">
            <Smartphone size={24} />
          </span>
          <svg width="96" height="20" viewBox="0 0 96 20">
            <line x1="6" y1="10" x2="90" y2="10" />
            <circle className="pulse" cx="6" cy="10" r="3.5" />
          </svg>
          <span className="end pc">
            <Monitor size={24} />
          </span>
        </div>
        {emoji.length ? (
          <>
            <h1 className="h-l above rise" style={{ ['--i' as string]: 1 }}>
              Check {target.name}
            </h1>
            <p className="muted above rise" style={{ ['--i' as string]: 2, margin: 0 }}>
              Your computer shows the same three pictures.
              <br />
              If they match, press <b>Allow</b> there.
            </p>
            <div className="emoji above">
              {emoji.map((e, i) => (
                <span key={i}>{e}</span>
              ))}
            </div>
            <span className="above">
              <Shimmer>Waiting for {target.name}</Shimmer>
            </span>
          </>
        ) : (
          <h1 className="h-l above">
            <Shimmer>Connecting to {target.name}</Shimmer>
          </h1>
        )}
        <div className="spacer" />
        <button
          className="btn text above"
          onClick={() => {
            abort.current?.abort()
            setPhase(found.length ? 'list' : 'manual')
          }}
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="pair">
      <Arc />
      <div className="spacer above" style={{ flex: phase === 'manual' ? 0.3 : 1 }} />
      <div className="glowlogo above" style={{ marginBottom: 24 }}>
        {phase === 'search' && (
          <>
            <span className="rings" />
            <span className="rings b" />
            <span className="rings c" />
          </>
        )}
        <Logo className={`logo-xl${phase === 'search' ? ' float' : ''}`} />
      </div>
      {removed && phase !== 'search' && <p className="error-text above">This phone was removed on the computer. Connect it again.</p>}

      {phase === 'search' && (
        <>
          <div className="overline above">Celeste for Android</div>
          <h1 className="h-l above">
            <Shimmer>Looking for Celeste</Shimmer>
          </h1>
          <p className="muted above" style={{ margin: 0 }}>
            On your Wi-Fi network
          </p>
          <div className="spacer" />
          <p className="small faint above" style={{ margin: 0 }}>
            Keep Celeste open on your computer, with Settings, Phone switched on.
          </p>
        </>
      )}

      {phase === 'list' && (
        <>
          <div className="overline above" {...rise(0)}>
            On your Wi-Fi
          </div>
          <h1 className="h-l above" {...rise(1)}>
            {found.length === 1 ? 'Found your computer' : 'Choose your computer'}
          </h1>
          {found.map((t, i) => (
            <button key={t.base} className="card found above" style={{ animationDelay: `${i * 60}ms` }} onClick={() => void connect(t)}>
              <span className="ibox accent">
                <Monitor size={20} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 16 }}>{t.name}</div>
                <div className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Wifi size={12} /> Celeste on this Wi-Fi
                </div>
              </div>
            </button>
          ))}
          {error && <p className="error-text above">{error}</p>}
          <div className="spacer" />
          {found.length === 1 && (
            <button className="btn primary big block shine above" onClick={() => void connect(found[0] as Target)}>
              Connect
            </button>
          )}
          <button className="btn text above" onClick={() => setPhase('manual')}>
            Type the address instead
          </button>
        </>
      )}

      {phase === 'manual' && (
        <>
          <div className="overline above">Connect to your computer</div>
          <h1 className="h-l above">{isNative ? 'Celeste wasn’t found' : 'Type the address'}</h1>
          <p className="muted above" style={{ margin: 0 }}>
            {isNative ? 'Check that the computer is on the same Wi-Fi, or type the address Celeste shows in Settings, Phone.' : 'The address Celeste shows in Settings, Phone.'}
          </p>
          <input
            className="field above"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="192.168.1.5:41234"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void connectTyped()}
          />
          {error && <p className="error-text above">{error}</p>}
          <div className="spacer" />
          <button className="btn primary big block above" disabled={busy || !address.trim()} onClick={() => void connectTyped()}>
            Connect
          </button>
          {isNative && (
            <button className="btn text above" onClick={() => void search()}>
              Look again
            </button>
          )}
        </>
      )}
    </div>
  )
}
