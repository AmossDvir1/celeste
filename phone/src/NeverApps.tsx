import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Lock, Search } from 'lucide-react'
import { abilities, type PhoneApp } from './native'
import { useApp } from './store'
import { Shimmer, buzz } from './ui'

/*
 * The person's never list: apps Celeste never sees or touches (their bank, private messages). It never reads their
 * notifications, and phone control stops at their screens. Password managers, authenticators and Android's installer are
 * always on it.
 */
export function NeverAppsSheet({ onClose }: { onClose: (count: number) => void }) {
  const [apps, setApps] = useState<PhoneApp[] | null>(null)
  const [query, setQuery] = useState('')
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    void abilities.apps().then(setApps)
  }, [])
  const mine = (apps ?? []).filter((a) => a.never && !a.fixed).length
  const close = () => {
    setLeaving(true)
    setTimeout(() => onClose(mine), 200)
  }
  const q = query.trim().toLowerCase()
  const shown = (apps ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.pkg.includes(q))
  // Chosen ones first, so the list reads as "what is off-limits", then the rest by name.
  const sorted = [...shown.filter((a) => a.never && !a.fixed), ...shown.filter((a) => !a.never), ...shown.filter((a) => a.fixed)]
  const toggle = async (app: PhoneApp) => {
    if (app.fixed) return
    buzz(5)
    const on = !app.never
    setApps((list) => list?.map((a) => (a.pkg === app.pkg ? { ...a, never: on } : a)) ?? null)
    try {
      await abilities.setNever(app.pkg, on)
    } catch {
      setApps((list) => list?.map((a) => (a.pkg === app.pkg ? { ...a, never: !on } : a)) ?? null)
      useApp.getState().say('That did not save.')
    }
  }
  return createPortal(
    <div className={`card-layer${leaving ? ' out' : ''}`}>
      <div className="scrim" onClick={close} />
      <div className="sheet tall" role="dialog" aria-label="Apps Celeste never uses">
        <div className="handle" />
        <div className="overline" style={{ fontSize: 10 }}>
          Never list
        </div>
        <h1 className="h-l" style={{ fontSize: 20, margin: '2px 0 4px' }}>
          Apps Celeste never uses
        </h1>
        <p className="small muted" style={{ margin: '0 0 12px' }}>
          It won't read their notifications, and phone control stops at their screens. Add your bank, or anything private.
        </p>
        <label className="searchbox">
          <Search size={16} />
          <input placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="mlist">
          {apps === null ? (
            <div className="empty" style={{ padding: 24 }}>
              <Shimmer>Looking at your apps</Shimmer>
            </div>
          ) : sorted.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              No app matches.
            </div>
          ) : (
            sorted.map((a) => (
              <button key={a.pkg} className="mrow approw" onClick={() => void toggle(a)} disabled={a.fixed} aria-pressed={a.never}>
                <span className={`ibox letter${a.never ? ' accent' : ''}`}>{a.name.trim().charAt(0).toUpperCase() || '?'}</span>
                <span className="grow">
                  <span className="nm">{a.name}</span>
                  <span className="pk mono">{a.pkg}</span>
                </span>
                {a.fixed ? (
                  <span className="always">
                    <Lock size={13} /> Always
                  </span>
                ) : (
                  <span className={`switch${a.never ? ' on' : ''}`} />
                )}
              </button>
            ))
          )}
        </div>
        <button className="btn primary block" style={{ marginTop: 14 }} onClick={close}>
          Done
        </button>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body
  )
}
