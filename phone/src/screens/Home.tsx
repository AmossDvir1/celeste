import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { AlarmClock, AppWindow, Bell, ChevronRight, Hand, Code2, Laptop, MessageSquare, Monitor, Moon, Plus, Search, ShieldOff, Smartphone, Sun, Unplug, Wifi, Workflow } from 'lucide-react'
import type { Session } from '@/stores/types'
import { abilities, notificationsAllowed, type AbilityState } from '../native'
import { NeverAppsSheet } from '../NeverApps'
import { askNotifications, useApp, type Tab } from '../store'
import { Arc, Logo, Shimmer, buzz, greeting, rise, when } from '../ui'

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
          </button>
        ))}
      </nav>
    </>
  )
}

function Offline({ computer, state }: { computer: string; state: string }) {
  return (
    <div className="strip off">
      <Wifi size={18} />
      <span className="grow">{state === 'connecting' ? <Shimmer>Connecting to {computer}</Shimmer> : `Can’t reach ${computer}. Is it on, and on this Wi-Fi?`}</span>
      {state !== 'connecting' && (
        <button className="btn text sm" onClick={() => useApp.getState().connect()}>
          Retry
        </button>
      )}
    </div>
  )
}

const DAY = 24 * 60 * 60 * 1000

function Chats() {
  const sessions = useApp((s) => s.sessions)
  const boot = useApp((s) => s.boot)
  const openChat = useApp((s) => s.openChat)
  const [query, setQuery] = useState('')
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return Object.values(sessions)
      .filter((s) => !q || s.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, query])
  const waiting = list.filter((s) => s.status === 'waiting')
  const today = new Date().setHours(0, 0, 0, 0)
  const groups: [string, Session[]][] = [
    ['Today', list.filter((s) => s.updatedAt >= today)],
    ['This week', list.filter((s) => s.updatedAt < today && s.updatedAt >= today - 6 * DAY)],
    ['Earlier', list.filter((s) => s.updatedAt < today - 6 * DAY)]
  ]
  let n = 5

  const open = (e: MouseEvent<HTMLButtonElement>, id: string) => {
    const t = e.currentTarget.querySelector<HTMLElement>('.title')
    if (t) t.style.viewTransitionName = 'chat-title'
    void openChat(id)
  }

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
        <button className="needs" {...rise(4)} onClick={(e) => open(e, (waiting[0] as Session).id)}>
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
      {groups.map(([label, items]) =>
        items.length ? (
          <div key={label}>
            <div className="group">{label}</div>
            {items.map((s) => (
              <button key={s.id} className="chatitem rise" style={{ ['--i' as string]: Math.min(n++, 14) }} onClick={(e) => open(e, s.id)}>
                <span className={`avatar${s.status === 'waiting' ? ' needs-av' : ''}`}>{s.mode === 'develop' ? <Code2 size={18} /> : <MessageSquare size={18} />}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="top">
                    <span className="title">{s.title || 'New chat'}</span>
                    <span className="time">{when(s.updatedAt)}</span>
                  </div>
                  <Preview s={s} />
                </div>
              </button>
            ))}
          </div>
        ) : null
      )}
      <div style={{ height: 96 }} />
    </>
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
      <div className="prev">
        <Shimmer>Working</Shimmer>
      </div>
    )
  const where = s.mode === 'develop' ? (s.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? 'Develop') + (s.branch ? ` · ${s.branch}` : '') : 'Chat'
  return <div className="prev">{where}</div>
}

function Runs() {
  const runs = useApp((s) => s.runs)
  const loadRuns = useApp((s) => s.loadRuns)
  const computer = useApp((s) => s.pairing?.computer.name ?? 'your computer')
  useEffect(() => {
    void loadRuns()
  }, [loadRuns])
  const label = { running: 'Running', waiting: 'Waiting for you on the computer', completed: 'Done', failed: 'Failed', cancelled: 'Stopped' }
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
      {runs.length === 0 ? (
        <div className="empty" {...rise(2)}>
          Runs of your workflows show here as they happen. Start them on the computer, or ask Celeste in a chat.
        </div>
      ) : (
        <div className="card" data-rise style={{ margin: '0 16px', ['--i' as string]: 2 }}>
          {runs.map((r) => (
            <div key={r.id} className="row">
              <span className={`ibox${r.status === 'waiting' ? ' accent' : ''}`}>
                <Workflow size={18} />
              </span>
              <div className="grow">
                <div className="t">{r.workflowName}</div>
                <div className="s">{r.status === 'running' ? <Shimmer>Running</Shimmer> : label[r.status]} · {when(r.startedAt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
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
    ['notifications', Bell, 'Notifications', 'Read them, and reply to messages'],
    ['open', AppWindow, 'Open apps and links', ''],
    ['alarm', AlarmClock, 'Alarms and timers', 'In your clock app'],
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

function ThisPhone() {
  const pairing = useApp((s) => s.pairing)
  const boot = useApp((s) => s.boot)
  const linkState = useApp((s) => s.linkState)
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
            <div className="s">{pairing.base.replace(/^https?:\/\//, '')}</div>
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
