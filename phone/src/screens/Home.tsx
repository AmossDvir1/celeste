import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlarmClock, AppWindow, Bell, CalendarDays, ChevronRight, Hand, Code2, Images, Laptop, MapPin, MessageSquare, Monitor, Moon, Pencil, Phone, Pin, PinOff, Play, Plus, Search, ShieldOff, Smartphone, Sun, Trash2, Unplug, Wifi, Workflow } from 'lucide-react'
import type { Session } from '@/stores/types'
import { abilities, appVersion, notificationsAllowed, type AbilityState } from '../native'
import type { PhoneWorkflow } from '@shared/phone'
import { NeverAppsSheet } from '../NeverApps'
import { RunSheet, StartSheet } from '../WorkflowSheets'
import { askNotifications, useApp, type Tab } from '../store'
import { Arc, Logo, Shimmer, buzz, greeting, rise, when } from '../ui'
import { DeleteSheet } from './Chat'

export function Home({ tab }: { tab: Tab }) {
  const linkState = useApp((s) => s.linkState)
  const computer = useApp((s) => s.pairing?.computer.name ?? 'your computer')
  const sessions = useApp((s) => s.sessions)
  const go = useApp((s) => s.go)
  const content = useRef<HTMLDivElement>(null)
  const arc = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [compact, setCompact] = useState(false)
  const waiting = useMemo(() => Object.values(sessions).filter((s) => s.status === 'waiting').length, [sessions])
  const busy = useMemo(() => Object.values(sessions).some((s) => s.status === 'working'), [sessions])
  const title = { chats: 'Chats', workflows: 'Workflows', phone: 'This phone' }[tab]
  const online = linkState === 'connected'

  return (
    <>
      {!online && <Offline computer={computer} state={linkState} />}
      <div className="bg-arc" ref={arc}>
        <Arc soft />
      </div>
      <div className={`appbar${scrolled ? ' scrolled' : ''}`}>
        <Logo className="logo" />
        <h1>{title}</h1>
        <button className="chip" onClick={() => go({ name: 'home', tab: 'phone' }, 'tab')}>
          <span className={`dot live${online ? '' : linkState === 'connecting' ? ' wait' : ' off'}`} />
          {computer}
        </button>
      </div>
      <div
        className="content"
        ref={content}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop
          // The glow stays put while the list moves over it, and dims a little as it goes.
          if (arc.current) arc.current.style.opacity = String(Math.max(0.3, 1 - top / 320))
          setScrolled(top > 58)
          setCompact(top > 120)
        }}
      >
        {tab === 'chats' && <Chats />}
        {tab === 'workflows' && <Runs />}
        {tab === 'phone' && <ThisPhone />}
      </div>
      {tab === 'chats' && (
        <button className={`fab${compact ? ' compact' : ''}`} disabled={!online} style={online ? undefined : { opacity: 0.5 }} onClick={() => go({ name: 'new' })}>
          <Plus size={22} />
          <span>New chat</span>
        </button>
      )}
      <nav className="navbar">
        {(
          [
            ['chats', MessageSquare, 'Chats'],
            ['workflows', Workflow, 'Workflows'],
            ['phone', Smartphone, 'This phone']
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            className={tab === id ? 'on' : ''}
            onClick={() => {
              if (tab === id) content.current?.scrollTo({ top: 0, behavior: 'smooth' })
              else go({ name: 'home', tab: id }, 'tab')
            }}
          >
            <span className="ind">
              <Icon size={21} />
            </span>
            {label}
            {id === 'chats' && waiting > 0 && <span className="badge">{waiting}</span>}
            {id === 'chats' && waiting === 0 && busy && tab !== 'chats' && <span className="tabdot" title="Working" />}
          </button>
        ))}
      </nav>
    </>
  )
}

function Offline({ computer, state }: { computer: string; state: string }) {
  // With a relay the computer is reached from anywhere: what can be wrong is the computer or the internet, not the Wi-Fi.
  const anywhere = useApp((s) => !!s.pairing?.relay)
  return (
    <div className="strip off">
      <Wifi size={18} />
      <span className="grow">{state === 'connecting' ? <Shimmer>Connecting to {computer}</Shimmer> : `Can’t reach ${computer}. ${anywhere ? 'Is it on, with Celeste open and the internet working?' : 'Is it on, and on this Wi-Fi?'}`}</span>
      {state !== 'connecting' && (
        <button className="btn text sm" onClick={() => useApp.getState().connect()}>
          Retry
        </button>
      )}
    </div>
  )
}

const DAY = 24 * 60 * 60 * 1000
const HOLD_MS = 450
const MOVE_PX = 10
const reduceMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function Chats() {
  const sessions = useApp((s) => s.sessions)
  const boot = useApp((s) => s.boot)
  const openChat = useApp((s) => s.openChat)
  const pin = useApp((s) => s.pin)
  const remove = useApp((s) => s.remove)
  const menu = useApp((s) => s.listMenu)
  const setListMenu = useApp((s) => s.setListMenu)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<Session | null>(null)
  const [deleting, setDeleting] = useState<Session | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const glide = useRef<Map<string, number> | null>(null)
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return Object.values(sessions)
      .filter((s) => !q || s.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, query])
  const pinned = useMemo(() => list.filter((s) => s.pinnedAt != null).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)), [list])
  const rest = list.filter((s) => s.pinnedAt == null)
  const waiting = list.filter((s) => s.status === 'waiting')
  const today = new Date().setHours(0, 0, 0, 0)
  const groups: [string, Session[]][] = [
    ['Today', rest.filter((s) => s.updatedAt >= today)],
    ['This week', rest.filter((s) => s.updatedAt < today && s.updatedAt >= today - 6 * DAY)],
    ['Earlier', rest.filter((s) => s.updatedAt < today - 6 * DAY)]
  ]
  const menuSession = menu ? sessions[menu.id] : undefined
  let n = 5

  useEffect(() => {
    if (menu && !menuSession) setListMenu(null)
  }, [menu, menuSession, setListMenu])

  // Rows glide to their new place: note where they are now, then animate from there after the list re-renders.
  useLayoutEffect(() => {
    const before = glide.current
    if (!before || !listRef.current) return
    glide.current = null
    listRef.current.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
      const was = before.get(el.dataset.sessionId ?? '')
      if (was == null) return
      const dy = was - el.getBoundingClientRect().top
      if (Math.abs(dy) >= 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' })
    })
  })

  const open = (el: HTMLElement, id: string) => {
    const t = el.querySelector<HTMLElement>('.title')
    if (t) t.style.viewTransitionName = 'chat-title'
    void openChat(id)
  }

  const togglePin = (s: Session) => {
    if (!reduceMotion() && listRef.current) {
      const at = new Map<string, number>()
      listRef.current.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => at.set(el.dataset.sessionId ?? '', el.getBoundingClientRect().top))
      glide.current = at
    }
    // pin() applies its change synchronously; the menu closes after, so the glide is consumed by the pin's render.
    void pin(s.id, s.pinnedAt == null)
    setListMenu(null)
  }

  const row = (s: Session, isPinned: boolean) => <ChatRow key={s.id} s={s} pinned={isPinned} i={n++} onOpen={open} onHold={(x, y) => setListMenu({ id: s.id, x, y })} />
  const items: ReactNode[] = []
  if (pinned.length) {
    items.push(
      <div key="h-pinned" className="group pinned-h">
        Pinned
      </div>
    )
    pinned.forEach((s) => items.push(row(s, true)))
  }
  groups.forEach(([label, group]) => {
    if (!group.length) return
    items.push(
      <div key={`h-${label}`} className="group">
        {label}
      </div>
    )
    group.forEach((s) => items.push(row(s, false)))
  })

  return (
    <>
      <div className="hero">
        <div className="overline above" {...rise(0)}>
          Celeste on {boot?.computer ?? useApp.getState().pairing?.computer.name}
        </div>
        <h1 className="greet above" {...rise(1)}>
          {greeting()}, <span className="grad">{boot?.userName || 'there'}.</span>
        </h1>
        <p className="subline above" {...rise(2)}>
          What would you like to work on?
        </p>
      </div>
      <label className="search" {...rise(3)}>
        <Search size={18} />
        <input placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {waiting.length > 0 && !query && (
        <button className="needs" {...rise(4)} onClick={(e) => open(e.currentTarget, (waiting[0] as Session).id)}>
          <span className="dot pink live" />
          <div style={{ flex: 1, position: 'relative' }}>
            <div className="t">
              {waiting.length} {waiting.length === 1 ? 'chat needs' : 'chats need'} you
            </div>
            <div className="small muted">Approvals and questions from Celeste</div>
          </div>
          <ChevronRight size={18} />
        </button>
      )}
      {list.length === 0 && <div className="empty">{query ? 'No chats match.' : boot ? 'No chats yet. Start one with New chat.' : <Shimmer>Loading your chats</Shimmer>}</div>}
      <div ref={listRef}>{items}</div>
      {menu && menuSession && createPortal(<ChatMenu at={menu} pinned={menuSession.pinnedAt != null} onClose={() => setListMenu(null)} onPin={() => togglePin(menuSession)} onRename={() => { setListMenu(null); setRenaming(menuSession) }} onDelete={() => { setListMenu(null); setDeleting(menuSession) }} />, document.querySelector('.app') ?? document.body)}
      {renaming && <RenameSheet key={renaming.id} session={renaming} onClose={() => setRenaming(null)} />}
      {deleting &&
        createPortal(
          <DeleteSheet
            title={deleting.title || 'New chat'}
            onCancel={() => setDeleting(null)}
            onDelete={() => {
              void remove(deleting.id)
              setDeleting(null)
            }}
          />,
          document.querySelector('.app') ?? document.body
        )}
      <div style={{ height: 96 }} />
    </>
  )
}

/** A chat row. A long press opens the menu at the finger; a short tap opens the chat. */
function ChatRow({ s, pinned, i, onOpen, onHold }: { s: Session; pinned: boolean; i: number; onOpen: (el: HTMLElement, id: string) => void; onHold: (x: number, y: number) => void }) {
  const [entered, setEntered] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const held = useRef(false)
  const cancel = () => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    start.current = null
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <button
      data-session-id={s.id}
      className={`chatitem${entered ? '' : ' rise'}`}
      style={{ ['--i' as string]: Math.min(i, 14) }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setEntered(true)
      }}
      onPointerDown={(e) => {
        cancel()
        held.current = false
        start.current = { x: e.clientX, y: e.clientY }
        const x = e.clientX
        const y = e.clientY
        timer.current = window.setTimeout(() => {
          timer.current = undefined
          start.current = null
          held.current = true
          onHold(x, y)
        }, HOLD_MS)
      }}
      onPointerMove={(e) => {
        const p = start.current
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_PX) cancel()
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (held.current) {
          held.current = false
          return
        }
        onOpen(e.currentTarget, s.id)
      }}
    >
      <span className={`avatar${s.status === 'waiting' ? ' needs-av' : ''}`}>{s.mode === 'develop' ? <Code2 size={18} /> : <MessageSquare size={18} />}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="top">
          {pinned && <Pin size={12} className="pin-ic" role="img" aria-label="Pinned" />}
          <span className="title">{s.title || 'New chat'}</span>
          <span className="time">{when(s.updatedAt)}</span>
        </div>
        <Preview s={s} />
      </div>
      {s.status === 'working' && <WorkingDot />}
      {s.status === 'waiting' && <span className="wdot still" aria-hidden />}
    </button>
  )
}

/** The menu a long press opens, anchored under or over the finger and kept on screen. */
function ChatMenu({ at, pinned, onClose, onPin, onRename, onDelete }: { at: { x: number; y: number }; pinned: boolean; onClose: () => void; onPin: () => void; onRename: () => void; onDelete: () => void }) {
  const app = document.querySelector('.app')?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  const W = 224
  const M = 12
  const left = Math.min(Math.max(at.x - app.left - W / 2, M), app.width - W - M)
  const below = at.y - app.top < app.height / 2
  const place = below ? { top: at.y - app.top + 8 } : { bottom: app.height - (at.y - app.top) + 8 }
  const drag = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      className="lpmenu-layer"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.lpmenu')) return
        drag.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerMove={(e) => {
        const p = drag.current
        if (!p) return
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_PX) {
          drag.current = null
          onClose()
        }
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className={`lpmenu ${below ? 'below' : 'above'}`} role="menu" style={{ left, width: W, ...place }} onClick={(e) => e.stopPropagation()}>
        <button role="menuitem" onClick={onPin}>
          {pinned ? <PinOff size={18} /> : <Pin size={18} />}
          <span>{pinned ? 'Unpin' : 'Pin'}</span>
        </button>
        <button role="menuitem" onClick={onRename}>
          <Pencil size={18} />
          <span>Rename</span>
        </button>
        <button role="menuitem" className="danger" onClick={onDelete}>
          <Trash2 size={18} />
          <span>Delete</span>
        </button>
      </div>
    </div>
  )
}

/** Renames a chat in a sheet; Save is off until the name has text. */
function RenameSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const rename = useApp((s) => s.rename)
  const [value, setValue] = useState(session.title)
  const clean = value.trim()
  const save = () => {
    if (clean && clean !== session.title.trim()) void rename(session.id, clean)
    onClose()
  }
  return createPortal(
    <div className="card-layer">
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="Rename chat">
        <div className="handle" />
        <h1 className="h-l" style={{ fontSize: 20 }}>
          Rename chat
        </h1>
        <input className="field" style={{ marginTop: 16 }} autoFocus maxLength={200} value={value} aria-label="Chat name" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && clean) save() }} />
        <div className="btnrow" style={{ marginTop: 16 }}>
          <button className="btn tonal" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!clean} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.querySelector('.app') ?? document.body
  )
}

function WorkingDot() {
  return (
    <span className="wdot" role="img" aria-label="Working">
      <i />
    </span>
  )
}

function Preview({ s }: { s: Session }) {
  if (s.status === 'waiting')
    return (
      <div className="prev needs-t">
        <span className="dot pink" style={{ width: 7, height: 7 }} />
        Needs you
      </div>
    )
  if (s.status === 'working')
    return (
      <div className="prev accent-t">
        <Shimmer>Working…</Shimmer>
      </div>
    )
  const where = s.mode === 'develop' ? (s.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? 'Develop') + (s.branch ? ` · ${s.branch}` : '') : 'Chat'
  return <div className="prev">{where}</div>
}

function Runs() {
  const runs = useApp((s) => s.runs)
  const loadRuns = useApp((s) => s.loadRuns)
  const link = useApp((s) => s.link)
  const online = useApp((s) => s.linkState === 'connected')
  const computer = useApp((s) => s.pairing?.computer.name ?? 'your computer')
  const [workflows, setWorkflows] = useState<PhoneWorkflow[] | null>(null)
  const [starting, setStarting] = useState<PhoneWorkflow | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    void loadRuns()
  }, [loadRuns])
  useEffect(() => {
    if (!link || !online) return
    void link.call<PhoneWorkflow[]>('phone.workflows').then(setWorkflows, () => setWorkflows([]))
  }, [link, online])
  const label = { running: 'Running', waiting: 'Waiting for you: tap to answer', completed: 'Done', failed: 'Failed', cancelled: 'Stopped' }
  return (
    <>
      <div className="hero">
        <div className="overline above" {...rise(0)}>
          Run on {computer}
        </div>
        <h1 className="bigtitle above" {...rise(1)}>
          Workflows
        </h1>
      </div>
      {workflows && workflows.length > 0 && (
        <>
          <div className="section-title" {...rise(2)}>
            Your workflows
          </div>
          <div className="card" data-rise style={{ margin: '0 16px 6px', ['--i' as string]: 2 }}>
            {workflows.map((w) => (
              <button key={w.id} className="row tap" style={{ width: '100%', textAlign: 'left' }} disabled={!online} onClick={() => setStarting(w)}>
                <span className="ibox">
                  <Workflow size={18} />
                </span>
                <div className="grow">
                  <div className="t">{w.name}</div>
                  {w.description && <div className="s">{w.description}</div>}
                </div>
                <Play size={18} className="faint" />
              </button>
            ))}
          </div>
        </>
      )}
      <div className="section-title" {...rise(3)}>
        Runs
      </div>
      {runs.length === 0 ? (
        <div className="empty" {...rise(3)}>
          Runs of your workflows show here as they happen. Start one above, on the computer, or ask Celeste in a chat.
        </div>
      ) : (
        <div className="card" data-rise style={{ margin: '0 16px', ['--i' as string]: 3 }}>
          {runs.map((r) => (
            <button key={r.id} className="row tap" style={{ width: '100%', textAlign: 'left' }} onClick={() => setOpen(r.id)}>
              <span className={`ibox${r.status === 'waiting' ? ' accent' : ''}`}>
                <Workflow size={18} />
              </span>
              <div className="grow">
                <div className="t">{r.workflowName}</div>
                <div className="s">{r.status === 'running' ? <Shimmer>Running</Shimmer> : label[r.status]} · {when(r.startedAt)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {starting && <StartSheet workflow={starting} onClose={() => setStarting(null)} onStarted={(run) => setOpen(run.id)} />}
      {open && <RunSheet runId={open} onClose={() => setOpen(null)} />}
      <div style={{ height: 24 }} />
    </>
  )
}

/**
 * What the assistant may ask this phone to do. Each switch only makes the ability available: every single request still
 * shows a card here, and nothing happens without Allow. Notifications also need Android's own Notification access.
 */
function AbilitiesCard() {
  const [state, setState] = useState<AbilityState | null>(null)
  const [never, setNever] = useState(false)
  const refresh = () => void abilities.get().then(setState)
  useEffect(() => {
    refresh()
    // Back from Android's settings: look again.
    const again = () => !document.hidden && refresh()
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [])
  if (!state) return null
  const rows: [keyof Omit<AbilityState, 'notificationAccess' | 'controlAccess' | 'never'>, typeof Bell, string, string][] = [
    ['notifications', Bell, 'Notifications', 'Read them, reply to messages, and clear them'],
    ['open', AppWindow, 'Open apps and links', ''],
    ['alarm', AlarmClock, 'Alarms and timers', 'In your clock app'],
    ['location', MapPin, 'Location', 'Where this phone is, once each time'],
    ['files', Images, 'Photos and files', 'Only the ones you pick'],
    ['calendar', CalendarDays, 'Calendar', 'Read your events, and add new ones'],
    ['messages', Phone, 'Texts and calls', 'Written in for you; you press Send or Call'],
    ['control', Hand, 'Phone control', 'See the screen, tap and type, for up to 15 minutes when you allow it']
  ]
  const needsAccess = state.notifications && !state.notificationAccess
  const needsControl = state.control && !state.controlAccess
  return (
    <>
      <div className="section-title" {...rise(3)}>
        What Celeste may do here
      </div>
      <p className="small muted" data-rise style={{ margin: '-4px 20px 10px', ['--i' as string]: 3 }}>
        Each time, it asks you on this phone first.
      </p>
      <div className="card" data-rise style={{ margin: '0 16px', ['--i' as string]: 4 }}>
        {rows.map(([key, Icon, title, sub]) => (
          <button
            key={key}
            className="row tap"
            style={{ width: '100%', textAlign: 'left' }}
            onClick={async () => {
              const on = !state[key]
              buzz(5)
              // Its cards are notifications when the app is not open: Android asks the person once.
              if (on) void askNotifications()
              await abilities.set(key, on)
              setState({ ...state, [key]: on })
              if (key === 'notifications' && on && !state.notificationAccess) void abilities.openNotificationAccess()
              if (key === 'control' && on && !state.controlAccess) void abilities.openAccessibility()
            }}
          >
            <span className="ibox">
              <Icon size={18} />
            </span>
            <div className="grow">
              <div className="t">
                {title}
                {(key === 'notifications' && needsAccess) || (key === 'control' && needsControl) ? <span className="pill-warn">1 setting</span> : null}
              </div>
              {sub && <div className="s">{sub}</div>}
            </div>
            <span className={`switch${state[key] ? ' on' : ''}`} />
          </button>
        ))}
        {state.control && (
          <button
            key="control_confirm"
            className="row tap"
            style={{ width: '100%', textAlign: 'left' }}
            onClick={async () => {
              const on = !state.controlConfirm
              buzz(5)
              await abilities.set('control_confirm', on)
              setState({ ...state, controlConfirm: on })
            }}
          >
            <span className="ibox">
              <Hand size={18} />
            </span>
            <div className="grow">
              <div className="t">Ask again before Send, Pay or Delete</div>
              <div className="s">Off: one Allow covers the whole task</div>
            </div>
            <span className={`switch${state.controlConfirm ? ' on' : ''}`} />
          </button>
        )}
      </div>
      {(state.notifications || state.control) && (
        <button className="card row tap" style={{ width: 'calc(100% - 32px)', textAlign: 'left', margin: '10px 16px 0' }} onClick={() => setNever(true)}>
          <span className="ibox">
            <ShieldOff size={18} />
          </span>
          <div className="grow">
            <div className="t">Apps Celeste never uses</div>
            <div className="s">{state.never ? `${state.never} of yours, plus password managers` : 'Password managers and authenticators. Add your own'}</div>
          </div>
          <ChevronRight size={18} className="faint" />
        </button>
      )}
      {never && (
        <NeverAppsSheet
          onClose={(count) => {
            setNever(false)
            setState((s) => (s ? { ...s, never: count } : s))
          }}
        />
      )}
      {needsControl && (
        <div className="card" style={{ margin: '10px 16px 0', padding: '14px 16px' }}>
          <div className="t" style={{ fontWeight: 600 }}>
            One Android setting for phone control
          </div>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>
            In Accessibility, open Celeste phone control (under Downloaded or Installed apps) and switch it on. It does nothing until you allow it
            here for a task. If Android says the setting is restricted, open App info, tap ⋮ at the top, then Allow restricted settings.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" onClick={() => void abilities.openAccessibility()}>
              Accessibility
            </button>
            <button className="btn tonal sm" onClick={() => void abilities.openAppInfo()}>
              App info
            </button>
          </div>
        </div>
      )}
      {needsAccess && (
        <div className="card" style={{ margin: '10px 16px 0', padding: '14px 16px' }}>
          <div className="t" style={{ fontWeight: 600 }}>
            One Android setting
          </div>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>
            Switch on Celeste in Notification access. If Android says the setting is restricted, open App info, tap ⋮ at the top, then Allow
            restricted settings, and come back.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" onClick={() => void abilities.openNotificationAccess()}>
              Notification access
            </button>
            <button className="btn tonal sm" onClick={() => void abilities.openAppInfo()}>
              App info
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/** 1.10.0 is newer than 1.9.2: compares the numbers, part by part. */
export function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/**
 * The computer's Celeste is newer than this app: the new app is on its install page (the same page the QR opened), and
 * installs over this one, keeping the pairing.
 */
function UpdateNote() {
  const boot = useApp((s) => s.boot)
  const base = useApp((s) => s.pairing?.base)
  const [mine, setMine] = useState<string | null>(null)
  useEffect(() => {
    void appVersion().then(setMine)
  }, [])
  if (!boot || !mine || !base || !newer(boot.version, mine)) return null
  return (
    <div className="card" data-rise style={{ margin: '10px 16px 0', padding: '14px 16px', ['--i' as string]: 2 }}>
      <div className="t" style={{ fontWeight: 600 }}>
        A newer app is ready
      </div>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>
        Celeste on the computer is {boot.version}; this app is {mine}. Install the new one from the computer: it goes over this one and stays
        connected.
      </p>
      <a className="btn primary sm" href={`${base}/`} target="_blank" rel="noreferrer">
        Get it from the computer
      </a>
    </div>
  )
}

function ThisPhone() {
  const pairing = useApp((s) => s.pairing)
  const boot = useApp((s) => s.boot)
  const linkState = useApp((s) => s.linkState)
  const route = useApp((s) => (s.linkState === 'connected' ? (s.link?.route ?? null) : null))
  const prefs = useApp((s) => s.prefs)
  const setPrefs = useApp((s) => s.setPrefs)
  const [sure, setSure] = useState(false)
  const [notifyOk, setNotifyOk] = useState<boolean | null>(null)
  useEffect(() => {
    void notificationsAllowed(false).then(setNotifyOk)
  }, [])
  if (!pairing) return null
  const online = linkState === 'connected'
  return (
    <>
      <div className="hero">
        <div className="overline above" {...rise(0)}>
          Celeste for Android
        </div>
        <h1 className="bigtitle above" {...rise(1)}>
          This phone
        </h1>
      </div>
      <div className="card row" data-rise style={{ margin: '0 16px', ['--i' as string]: 2 }}>
        <span className="ibox accent" style={{ width: 50, height: 50, borderRadius: 15 }}>
          <Monitor size={24} />
        </span>
        <div className="grow">
          <div style={{ fontWeight: 600, fontSize: 17 }}>{pairing.computer.name}</div>
          <div className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span className={`dot live${online ? '' : ' off'}`} />
            {online ? `Connected · Celeste ${boot?.version ?? pairing.computer.version}` : linkState === 'connecting' ? 'Connecting…' : 'Not connected'}
          </div>
        </div>
      </div>
      <UpdateNote />

      <AbilitiesCard />

      <div className="section-title" {...rise(3)}>
        While the app is closed
      </div>
      <div className="card" data-rise style={{ margin: '0 16px', ['--i' as string]: 4 }}>
        <button
          className="row tap"
          style={{ width: '100%', textAlign: 'left' }}
          onClick={async () => {
            const on = !prefs.notify
            if (on && !(await askNotifications())) {
              setNotifyOk(false)
              useApp.getState().say('Allow notifications for Celeste in Android’s settings.')
              return
            }
            setNotifyOk(on ? true : notifyOk)
            setPrefs({ notify: on })
            buzz(5)
          }}
        >
          <span className="ibox">
            <Bell size={18} />
          </span>
          <div className="grow">
            <div className="t">Notifications</div>
            <div className="s">{notifyOk === false && prefs.notify ? 'Android has them turned off for Celeste' : 'Approvals and questions, with Approve and Deny'}</div>
          </div>
          <span className={`switch${prefs.notify ? ' on' : ''}`} />
        </button>
        <button
          className="row tap"
          style={{ width: '100%', textAlign: 'left' }}
          onClick={() => {
            if (!prefs.stay) void askNotifications()
            setPrefs({ stay: !prefs.stay })
            buzz(5)
          }}
        >
          <span className="ibox">
            <Wifi size={18} />
          </span>
          <div className="grow">
            <div className="t">Stay connected</div>
            <div className="s">Keeps a quiet notification, so approvals reach you with the app closed</div>
          </div>
          <span className={`switch${prefs.stay ? ' on' : ''}`} />
        </button>
      </div>

      <div className="section-title">Appearance</div>
      <div className="seg" style={{ margin: '0 16px' }}>
        {(
          [
            ['system', Smartphone, 'System'],
            ['dark', Moon, 'Dark'],
            ['light', Sun, 'Light']
          ] as const
        ).map(([t, Icon, label]) => (
          <button key={t} className={prefs.theme === t ? 'on' : ''} onClick={() => setPrefs({ theme: t })}>
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <div className="section-title">Computer</div>
      <div className="card" style={{ margin: '0 16px' }}>
        <div className="row">
          <span className="ibox">
            <Laptop size={18} />
          </span>
          <div className="grow">
            <div className="t">{pairing.computer.name}</div>
            <div className="s">{route === 'direct' ? 'Away from home, directly' : route === 'relay' ? 'Away from home, through the relay' : pairing.base.replace(/^https?:\/\//, '')}</div>
          </div>
        </div>
        <button className="row tap" style={{ width: '100%', textAlign: 'left', color: 'var(--c-danger)' }} onClick={() => (sure ? useApp.getState().forget() : setSure(true))}>
          <span className="ibox" style={{ color: 'var(--c-danger)' }}>
            <Unplug size={18} />
          </span>
          <div className="grow t">{sure ? 'Tap again to disconnect this phone' : 'Disconnect this phone'}</div>
        </button>
      </div>
      <p className="small faint" style={{ margin: '14px 20px 28px' }}>
        Everything between this phone and {pairing.computer.name} is encrypted end to end, with nothing in between. Away from home the phone can’t reach the computer yet.
      </p>
    </>
  )
}
