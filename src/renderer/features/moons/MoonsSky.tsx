import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ShimmerText } from '@/components/ShimmerText'
import { cn } from '@/lib/cn'
import { useSessions } from '@/stores/sessions'
import type { Session } from '@/stores/types'
import { useCharacters } from './instance'
import { seatLook, useMoonTheme } from './look'
import './moons.css'
import { SceneBody, type SceneActions } from './scenes'
import { drawSky, newSkyDraw, type Rect } from './sky-draw'
import { mapRoom, skyLayout } from './sky-layout'
import { skyOf, type SkyView } from './sky-model'
import { TalkPlayer, type Said, type TalkView } from './talk'

/*
 * The stage above the composer in a Two Moons chat: the moons, the scene of what is happening, the agents' talk, the caption and the track.
 * Height 0 when nothing is going on. One animation-frame loop runs only while the sky is up and the window is visible, and it only redraws:
 * React is touched when the sky's view changes meaningfully (it is compared by a key), never every frame.
 */

type Vars = CSSProperties & Record<`--${string}`, string | number>
type Bubble = { id: string; seat: 0 | 1; text: string; file?: string; line?: number; code?: string }

const talkSig = (v: TalkView): string => `${v.items.map((i) => `${i.id}:${i.state}`).join(',')}|${v.speaker}|${v.typing}|${v.over}`

function useCalm(): boolean {
  const [calm, setCalm] = useState(() => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false))
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const q = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setCalm(q.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return calm
}

function useWindowHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    const on = () => setHeight(window.innerHeight)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return height
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/** The agents' conversation in the sky. It scrolls, and follows the newest bubble. */
function TalkBox({ bubbles, on, style, cols }: { bubbles: (Bubble & { typing: boolean })[]; on: boolean; style: CSSProperties; cols: readonly { mid: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const n = bubbles.length
  const last = bubbles[n - 1]
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [n, last?.id, last?.typing])
  return (
    <div ref={ref} className={cn('moons-talk', on && 'on')} style={style} aria-hidden="true">
      {bubbles.map((b, i) => (
        <div key={b.id} className={cn('moons-bb', b.seat ? 'r' : 'l', i < n - 4 && 'old')} style={{ '--c': cols[b.seat]!.mid } as Vars}>
          {b.typing ? (
            <div className="moons-dots">
              <i />
              <i />
              <i />
            </div>
          ) : (
            <>
              {(b.code || b.file) && (
                <span className="moons-qt">
                  {b.file && <small>{b.line !== undefined ? `${b.file}, line ${b.line}` : b.file}</small>}
                  {b.code}
                </span>
              )}
              {b.text}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

export function MoonsSky({ session, child, compact }: { session: Session; child: Session | undefined; compact?: boolean }) {
  const theme = useMoonTheme()
  const chars = useCharacters()
  const calm = useCalm()
  const visible = useVisible()
  const windowHeight = useWindowHeight()
  const respondApproval = useSessions((s) => s.respondApproval)
  const open = useSessions((s) => s.open)

  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const slotA = useRef<HTMLDivElement>(null)
  const slotB = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  // When the chat became idle while this was shown: the moment after a run that ended well starts then.
  const [idleSince, setIdleSince] = useState<number | null>(null)
  const prevStatus = useRef(session.status)
  useEffect(() => {
    if (prevStatus.current !== 'idle' && session.status === 'idle') setIdleSince(Date.now())
    else if (session.status !== 'idle') setIdleSince(null)
    prevStatus.current = session.status
  }, [session.status])

  const [tick, setTick] = useState(0)
  const raw = useMemo(() => {
    try {
      return skyOf(session, child, Date.now(), { idleSince })
    } catch (error) {
      console.warn('The sky could not be worked out.', error)
      return null
    }
    // `tick` makes the model look again when a moment of its own ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, child, idleSince, tick])
  const until = raw?.until ?? null
  useEffect(() => {
    if (until === null) return
    const id = setTimeout(() => setTick((x) => x + 1), Math.max(0, until - Date.now()) + 20)
    return () => clearTimeout(id)
  }, [until, raw?.key])

  // The view that React sees changes only when its key does.
  const stable = useRef<SkyView | null>(null)
  if ((raw?.key ?? null) !== (stable.current?.key ?? null)) stable.current = raw
  const view = stable.current
  const last = useRef<SkyView | null>(null)
  if (view) last.current = view
  const shownView = view ?? last.current

  // What the agents said to each other, played like a conversation.
  const player = useRef(new TalkPlayer())
  const [talk, setTalk] = useState<TalkView>(() => player.current.view(Date.now()))
  const talkKey = useRef(talkSig(talk))
  const setTalkView = (v: TalkView) => {
    const sig = talkSig(v)
    if (sig === talkKey.current) return
    talkKey.current = sig
    setTalk(v)
  }
  const said = useMemo(() => {
    const list: (Said & Bubble)[] = []
    for (const it of session.items) {
      if (it.kind !== 'moonsTalk') continue
      for (const m of it.messages) if (m.to !== 'person') list.push({ id: m.id, seat: m.seat, text: m.text, at: m.at, ...(m.file ? { file: m.file } : {}), ...(m.line !== undefined ? { line: m.line } : {}), ...(m.code ? { code: m.code } : {}) })
    }
    return list
  }, [session.items])
  useEffect(() => {
    player.current.feed(said, Date.now())
    setTalkView(player.current.view(Date.now()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [said])

  // A hand-over that is new since the sky was shown: the light crosses over.
  const handSeen = useRef<string | null | undefined>(undefined)
  const hand = useRef<{ from: 0 | 1; to: 0 | 1; at: number } | null>(null)
  useEffect(() => {
    let item: Extract<Session['items'][number], { kind: 'moonsHand' }> | undefined
    for (let i = session.items.length - 1; i >= 0; i--) {
      const it = session.items[i]!
      if (it.kind === 'moonsHand') {
        item = it
        break
      }
    }
    const id = item?.id ?? null
    if (handSeen.current === undefined) handSeen.current = id
    else if (id !== handSeen.current) {
      handSeen.current = id
      if (item) hand.current = { from: item.from, to: item.to, at: performance.now() / 1000 }
    }
  }, [session.items])

  const waiting = !!shownView && shownView.seats.some((s) => s.state === 'wait')
  // The talk plays on the stage only while the run is live: once it ends, the same messages are in the timeline box and must not replay here.
  const running = session.moonsTurn != null
  const talkOn = running && !talk.over && !waiting
  // Talk that is still playing keeps the sky up only when there is something to draw behind it: a chat opened again right after a restart has
  // recent messages to tell and no view of its own, and an empty box of sky would stand over the thread.
  const up = !!view || (running && !talk.over && !!shownView)
  // The sky keeps being drawn for a moment after it is told to close, while it folds away.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (up) {
      setShown(true)
      return
    }
    const id = setTimeout(() => setShown(false), calm ? 0 : 800)
    return () => clearTimeout(id)
  }, [up, calm])

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)))
    ro.observe(el)
    setWidth(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [compact, shown])

  const pattern = session.moons?.pattern
  const cols = useMemo(() => {
    if (!pattern) return null
    return [seatLook(pattern, 0, theme).color, seatLook(pattern, 1, theme).color] as const
  }, [pattern, theme])

  const layout = useMemo(() => skyLayout(width || 820, windowHeight), [width, windowHeight])
  const { phone, H, pad, card } = layout

  // The loop: draws the canvas, and watches the talk for changes that React should show. Nothing runs while the sky is down or the window is hidden.
  const live = useRef({ view: shownView, talkOn, up, theme, calm, chars, cols, width, layout, talk })
  live.current = { view: shownView, talkOn, up, theme, calm, chars, cols, width, layout, talk }
  useEffect(() => {
    if (compact || !shown || !visible) return
    const S = newSkyDraw()
    let prev = performance.now()
    let drawn = -Infinity
    const t0 = prev
    let id = 0
    const frame = (nowMs: number) => {
      id = requestAnimationFrame(frame)
      const L = live.current
      // A run can take minutes, so it is drawn 30 times a second, not 60. With less motion nothing drifts between frames, and ten show every change.
      if (nowMs - drawn < (L.calm ? 100 : 30)) return
      drawn = nowMs
      const dt = Math.min(0.1, (nowMs - prev) / 1000 || 0)
      prev = nowMs
      const cv = canvasRef.current
      const root = rootRef.current
      const tv = player.current.view(Date.now())
      setTalkView(tv)
      if (!cv || !root || !L.view || !L.cols || L.width < 8) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.round(L.width * dpr)
      const h = Math.round(L.layout.H * dpr)
      if (cv.width !== w || cv.height !== h) {
        cv.width = w
        cv.height = h
      }
      const c = cv.getContext('2d')
      if (!c) return
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      c.clearRect(0, 0, L.width, L.layout.H)
      const top = root.getBoundingClientRect().top
      const rectOf = (el: HTMLElement | null): Rect | null => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        const left = r.left - root.getBoundingClientRect().left
        return { left, right: left + r.width, top: r.top - top, bottom: r.bottom - top }
      }
      const h0 = hand.current
      const age = h0 ? performance.now() / 1000 - h0.at : 0
      const comp = L.view.scenes.find((s) => s?.kind === 'compare')
      try {
        drawSky(S, {
          c,
          W: L.width,
          H: L.layout.H,
          layout: L.layout,
          t: (nowMs - t0) / 1000,
          dt,
          view: L.view,
          up: L.up,
          talk: { on: !tv.over && L.talkOn, speaker: tv.speaker, typing: tv.typing },
          cols: [L.cols[0], L.cols[1]],
          theme: L.theme,
          calm: L.calm,
          chars: L.chars,
          rects: [rectOf(slotA.current), rectOf(slotB.current)],
          hand: h0 && age < 1.6 ? { from: h0.from, to: h0.to, age } : null,
          both: comp?.kind === 'compare' ? comp.both : 0
        })
      } catch (error) {
        console.warn('The sky could not be drawn.', error)
      }
    }
    id = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, shown, visible])

  if (!pattern || !cols) return null
  const names = [seatLook(pattern, 0, theme).name, seatLook(pattern, 1, theme).name]
  const caption = talkOn ? `${names[0]} and ${names[1]} are talking` : (shownView?.caption ?? '')
  const still = !talkOn && !!shownView?.still

  if (compact) {
    if (!view && talk.over) return null
    const litSeat = view?.lit ?? 'both'
    return (
      <div className="moons-line" role="status">
        <span className="moons-line-dots" aria-hidden="true">
          {[0, 1].map((n) => (
            <i key={n} className={litSeat === 'both' || litSeat === n ? 'lit' : ''} style={{ '--c': cols[n]!.mid } as Vars} />
          ))}
        </span>
        <ShimmerText active={!still} className={cn('min-w-0 truncate', still && 'text-ink')}>
          {caption}
        </ShimmerText>
      </div>
    )
  }

  const mode = shownView?.mode ?? 'one'
  const two = mode === 'two'
  const litSeat = shownView && shownView.lit !== 'both' ? shownView.lit : 0
  const hide = talkOn
  // Where the scenes sit: beside the moons, or one on each side of them. The second slides in from the right when it is needed.
  const gap = phone ? 5 : 150
  const room = mapRoom(two ? width / 2 - card.side - gap : width - card.left - pad)
  const slotAStyle: Vars = {
    top: card.top,
    height: card.height,
    left: two ? card.side : card.left,
    right: two ? `calc(50% + ${gap}px)` : pad,
    opacity: hide ? 0 : 1,
    pointerEvents: hide ? 'none' : undefined,
    '--c': cols[two ? 0 : litSeat]!.mid
  }
  const slotBStyle: Vars = {
    top: card.top,
    height: card.height,
    left: two ? `calc(50% + ${gap}px)` : '100%',
    right: two ? card.side : '-60%',
    opacity: two && !hide ? 1 : 0,
    pointerEvents: two && !hide ? undefined : 'none',
    '--c': cols[1]!.mid
  }
  const actions: SceneActions = { onAnswer: (id, requestId, allow) => respondApproval(id, requestId, allow), onOpen: (id) => open(id) }
  const sceneA = shownView?.scenes[0] ?? null
  const sceneB = two ? (shownView?.scenes[1] ?? null) : null

  const bubbles: (Bubble & { typing: boolean })[] = []
  const known = new Map(said.map((m) => [m.id, m]))
  for (const it of talk.items) {
    const m = known.get(it.id)
    if (m && it.state !== 'hidden') bubbles.push({ ...m, typing: it.state === 'typing' })
  }

  const trackColor = cols[shownView?.mode === 'one' ? litSeat : 0]!.mid
  return (
    <div ref={rootRef} className={cn('moons-sky', calm && 'moons-calm')} style={{ height: up ? H : 0 }}>
      {shown && shownView && (
        <>
          <canvas ref={canvasRef} className="moons-canvas" style={{ height: H }} aria-hidden="true" />
          <TalkBox
            bubbles={bubbles}
            on={talkOn}
            style={{ left: layout.talk.left, right: layout.talk.right, top: layout.talk.top, bottom: layout.talk.bottom }}
            cols={cols}
          />
          <div ref={slotA} className="moons-scene" style={slotAStyle}>
            {sceneA && (
              <div className="moons-sc">
                <SceneBody scene={sceneA} name={names[two ? 0 : litSeat]!} seat={two ? 0 : litSeat} room={room} actions={actions} />
              </div>
            )}
          </div>
          <div ref={slotB} className="moons-scene" style={slotBStyle}>
            {sceneB && (
              <div className="moons-sc">
                <SceneBody scene={sceneB} name={names[1]!} seat={1} room={room} actions={actions} />
              </div>
            )}
          </div>
          <div className="moons-cap" style={{ left: pad, right: pad }}>
            <span role="status" className="moons-cap-label">
              <ShimmerText active={!still} className={still ? 'text-ink' : undefined}>
                {caption}
              </ShimmerText>
            </span>
            {!phone && (
              <ol className="moons-track" style={{ '--c': trackColor } as Vars} aria-label="Steps">
                {shownView.track.map((name, k) => (
                  <li key={name} className={k === shownView.step ? 'on' : k < shownView.step ? 'was' : ''}>
                    <i />
                    {name}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  )
}
