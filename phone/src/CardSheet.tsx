import { useEffect, useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { cards, type PhoneCard } from './native'
import { buzz } from './ui'

/**
 * A request from the computer that needs the person's answer (a phone ability, phone control, a second yes), shown over
 * whatever is on screen while the app is open. The same card is a notification when it is not; either answer counts.
 */
export function CardSheet() {
  const [list, setList] = useState<PhoneCard[]>([])
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    let stop = cards.watch(setList)
    // Android may drop the "cards changed" message while another screen is in front (the clock opening an alarm), so the
    // list is read again whenever the app comes back.
    const again = () => {
      if (document.hidden) return
      stop()
      stop = cards.watch(setList)
    }
    document.addEventListener('visibilitychange', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      stop()
    }
  }, [])
  const card = list[0]
  useEffect(() => {
    if (card) buzz(15)
  }, [card?.id])
  if (!card) return null
  const answer = (yes: boolean) => {
    buzz(yes ? 12 : 6)
    setLeaving(true)
    setTimeout(() => {
      setLeaving(false)
      // It goes at once here; the phone's own list follows.
      setList((l) => l.filter((c) => c.id !== card.id))
      void cards.answer(card.id, yes)
    }, 200)
  }
  const [first, ...rest] = card.text.split('\n')
  return (
    <div className={`card-layer${leaving ? ' out' : ''}`} key={card.id}>
      <div className="scrim" />
      <div className="sheet" role="dialog" aria-label={card.title}>
        <div className="handle" />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="ibox accent" style={{ width: 50, height: 50, borderRadius: 16 }}>
            <ShieldQuestion size={24} />
          </span>
          <div>
            <div className="overline" style={{ fontSize: 10 }}>
              Celeste asks
            </div>
            <h1 className="h-l" style={{ fontSize: 20 }}>
              {card.title}
            </h1>
          </div>
        </div>
        <div className="reason">{first}</div>
        {rest.length > 0 && <p className="small muted" style={{ whiteSpace: 'pre-line', margin: '10px 2px 16px' }}>{rest.join('\n')}</p>}
        <div className="btnrow" style={{ marginTop: rest.length ? 0 : 16 }}>
          <button className="btn tonal" onClick={() => answer(false)}>
            Deny
          </button>
          <button className="btn primary shine" onClick={() => answer(true)}>
            Approve
          </button>
        </div>
        {list.length > 1 && <p className="small faint center" style={{ margin: '12px 0 0' }}>{list.length - 1} more after this</p>}
      </div>
    </div>
  )
}
