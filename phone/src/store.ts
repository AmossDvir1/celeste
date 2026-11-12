// The app's state: the pairing it keeps, its line to the computer, the chats it has seen, and which screen is open.
// Conversations are rebuilt from the computer's own log with the desktop's reducer, so they match what the computer shows.

import { flushSync } from 'react-dom'
import { create } from 'zustand'
import type { AskAnswers, ContextRef } from '@shared/agent'
import type { CorePush, SessionSummary, StoredEvent } from '@shared/api'
import { EMPTY_QUEUE, type QueueAction, type SendMode } from '@shared/queue'
import type { PhoneBootstrap, PhoneCancelPush, PhoneModelChoice, PhoneModels, PhoneNewSession, PhoneRequestPush, PhoneViewStartPush, PhoneViewStopPush } from '@shared/phone'
import { PhoneLink, type LinkState, type PhonePairing } from '@shared/phone-client'
import type { RunSummary } from '@shared/workflow'
import { foldEvents, resolveApproval, resolveAsk } from '@/stores/reduce'
import type { Session } from '@/stores/types'
import { cards, clearNotification, discover, handlePhoneRequest, isNative, keepRunning, notificationsAllowed, notify, screen, secure, shareLine } from './native'

export type Tab = 'chats' | 'workflows' | 'phone'
export type Screen = { name: 'setup' } | { name: 'home'; tab: Tab } | { name: 'chat'; id: string } | { name: 'new' }
export type ThemePref = 'system' | 'dark' | 'light'
export type Nav = 'forward' | 'back' | 'tab' | 'none'

interface Prefs {
  theme: ThemePref
  /** Keep the connection open with the app closed, so approvals arrive as notifications. */
  stay: boolean
  notify: boolean
}

const PAIRING_KEY = 'celeste.pairing'
const PREFS_KEY = 'celeste.prefs'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the app still works until it is closed.
  }
}

/**
 * The pairing holds the phone's private key. On Android it is kept encrypted with a key in the Android Keystore
 * (`secure`); in a desktop browser (development) in the page's own storage.
 */
function savePairing(p: PhonePairing | null): void {
  if (!isNative) return save(PAIRING_KEY, p)
  void secure.set('pairing', p ? JSON.stringify(p) : null).catch(() => save(PAIRING_KEY, p))
  if (p === null || localStorage.getItem(PAIRING_KEY) !== null) save(PAIRING_KEY, null)
}

/**
 * Reads the pairing from the Keystore-encrypted store, moving one an older app kept in the page's storage. Runs once,
 * before the app shows anything.
 */
export async function restorePairing(): Promise<void> {
  if (!isNative) return
  let raw: string | null = null
  try {
    raw = await secure.get('pairing')
    const old = localStorage.getItem(PAIRING_KEY)
    if (old !== null) {
      if (!raw) {
        await secure.set('pairing', old)
        raw = old
      }
      localStorage.removeItem(PAIRING_KEY)
    }
  } catch {
    // No secure store: the page's storage is still read below.
    raw = localStorage.getItem(PAIRING_KEY)
  }
  let pairing: PhonePairing | null = null
  try {
    pairing = raw ? (JSON.parse(raw) as PhonePairing) : null
  } catch {
    pairing = null
  }
  useApp.setState({ pairing, screen: pairing ? { name: 'home', tab: 'chats' } : { name: 'setup' } })
}

const fresh = (summary: SessionSummary): Session => ({ ...summary, items: [], activity: null, loaded: false, foldedSeq: 0, queue: EMPTY_QUEUE })

interface AppState {
  pairing: PhonePairing | null
  link: PhoneLink | null
  linkState: LinkState
  boot: PhoneBootstrap | null
  sessions: Record<string, Session>
  runs: RunSummary[]
  /** The models the computer offers, once asked. */
  models: PhoneModels | null
  /** Text another app shared to Celeste, for New chat to start with. */
  shared: string | null
  screen: Screen
  nav: Nav
  prefs: Prefs
  toast: { text: string; at: number } | null
  /** Set when the computer removed this phone. */
  removed: boolean
  /** Counts "Show phone screen" presses on the computer: each one starts sharing (main.tsx watches it). */
  shareAsked: number

  go: (screen: Screen, nav?: Nav) => void
  back: () => boolean
  say: (text: string) => void
  setPrefs: (patch: Partial<Prefs>) => void

  paired: (p: PhonePairing) => void
  forget: () => void
  connect: () => void
  refresh: () => Promise<void>
  openChat: (id: string) => Promise<void>
  /** While the assistant works, `mode` makes the message wait its turn ('queue') or stops the turn and sends it now ('stop'). */
  send: (id: string, text: string, attachments?: string[], context?: ContextRef[], mode?: SendMode) => Promise<void>
  /** Edits, removes or sends now a message waiting behind the running turn; resumes or clears a paused queue. */
  queueAction: (id: string, action: QueueAction) => Promise<void>
  newChat: (text: string, how?: PhoneNewSession, attachments?: string[]) => Promise<void>
  stop: (id: string) => Promise<void>
  loadModels: () => Promise<void>
  setModel: (id: string, choice: PhoneModelChoice) => Promise<void>
  approve: (id: string, requestId: string, allow: boolean, minutes?: number) => Promise<void>
  answer: (id: string, requestId: string, answers: AskAnswers) => Promise<void>
  loadRuns: () => Promise<void>
  applyPush: (push: CorePush | PhoneRequestPush | PhoneCancelPush | PhoneViewStopPush | PhoneViewStartPush) => void
}

let unlisten: (() => void) | null = null
let offlineSince = 0
let searching = false

export const useApp = create<AppState>((set, get) => ({
  pairing: load<PhonePairing | null>(PAIRING_KEY, null),
  link: null,
  linkState: 'connecting',
  boot: null,
  sessions: {},
  runs: [],
  models: null,
  shared: null,
  screen: load<PhonePairing | null>(PAIRING_KEY, null) ? { name: 'home', tab: 'chats' } : { name: 'setup' },
  nav: 'none',
  prefs: load<Prefs>(PREFS_KEY, { theme: 'system', stay: false, notify: true }),
  toast: null,
  removed: false,
  shareAsked: 0,

  go: (screen, nav = 'forward') => {
    // Pages slide and the chat title glides into the header, with the View Transitions API the WebView has.
    const apply = () => flushSync(() => set({ screen, nav }))
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (nav === 'none' || reduced || !document.startViewTransition) return apply()
    document.documentElement.dataset.nav = nav
    document.startViewTransition(apply)
  },

  back: () => {
    const s = get().screen
    if (s.name === 'chat' || s.name === 'new') {
      get().go({ name: 'home', tab: 'chats' }, 'back')
      return true
    }
    if (s.name === 'home' && s.tab !== 'chats') {
      get().go({ name: 'home', tab: 'chats' }, 'tab')
      return true
    }
    return false
  },

  say: (text) => {
    const at = Date.now()
    set({ toast: { text, at } })
    setTimeout(() => {
      if (get().toast?.at === at) set({ toast: null })
    }, 3000)
  },

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs })
    save(PREFS_KEY, prefs)
    if ('stay' in patch) void keepRunning(prefs.stay, get().pairing)
  },

  paired: (p) => {
    savePairing(p)
    set({ pairing: p, removed: false })
    // Approvals arrive as notifications when the app is not open: Android asks the person once.
    void notificationsAllowed(true)
    get().connect()
    get().go({ name: 'home', tab: 'chats' })
  },

  forget: () => {
    unlisten?.()
    unlisten = null
    void keepRunning(false, null, true)
    savePairing(null)
    set({ pairing: null, link: null, boot: null, sessions: {}, runs: [], models: null, screen: { name: 'setup' }, nav: 'none' })
  },

  connect: () => {
    const pairing = get().pairing
    if (!pairing) return
    unlisten?.()
    const link = new PhoneLink(pairing)
    set({ link, linkState: 'connecting' })
    unlisten = link.listen(
      (push) => get().applyPush(push),
      (state) => {
        const was = get().linkState
        set({ linkState: state })
        if (state === 'connected') {
          offlineSince = 0
          void get().refresh()
          void shareLine(get().pairing ?? pairing)
          if (get().prefs.stay) void keepRunning(true, get().pairing)
        }
        if (state === 'refused') {
          // The computer forgot this phone (removed in Settings, or reinstalled).
          unlisten?.()
          savePairing(null)
          set({ pairing: null, link: null, removed: true, screen: { name: 'setup' }, nav: 'none' })
          void keepRunning(false, null, true)
        }
        if (state === 'offline') {
          if (was === 'connected') offlineSince = Date.now()
          // The computer may have a new address: look for it on the Wi-Fi.
          void findAgain()
        }
      }
    )
  },

  refresh: async () => {
    const link = get().link
    if (!link) return
    try {
      const boot = await link.call<PhoneBootstrap>('phone.hello')
      const old = get().sessions
      const sessions: Record<string, Session> = {}
      for (const s of boot.sessions) {
        const had = old[s.id]
        sessions[s.id] = had ? { ...had, ...s, status: had.loaded ? had.status : s.status } : fresh(s)
      }
      set({ boot, sessions })
      // Where the computer is found away from home: kept with the pairing, for the next time the Wi-Fi does not reach it.
      const pairing = get().pairing
      const relay = boot.relay ?? null
      if (pairing && boot.relay !== undefined && (pairing.relay?.url !== relay?.url || pairing.relay?.room !== relay?.room)) {
        const next = { ...pairing, relay }
        link.setRelay(relay)
        savePairing(next)
        set({ pairing: next })
        // Android's background parts learn it too: they reach the computer through the relay when the Wi-Fi does not.
        void shareLine(next)
      }
      // The open conversation may have moved on while the line was down.
      const screen = get().screen
      if (screen.name === 'chat' && sessions[screen.id]?.loaded) void loadLog(screen.id)
    } catch (err) {
      get().say(err instanceof Error ? err.message : 'Could not reach the computer.')
    }
  },

  openChat: async (id) => {
    get().go({ name: 'chat', id })
    void clearNotification(id)
    if (!get().sessions[id]?.loaded) await loadLog(id)
  },

  send: async (id, text, attachments, context, mode) => {
    try {
      await get().link?.call('sessions.send', id, { text, attachments: attachments ?? [], ...(context?.length ? { context } : {}) }, mode)
    } catch (err) {
      get().say(err instanceof Error ? err.message : 'Not sent.')
      throw err
    }
  },

  queueAction: async (id, action) => {
    try {
      await get().link?.call('sessions.queue', id, action)
    } catch (err) {
      get().say(err instanceof Error ? err.message : 'That did not work.')
    }
  },

  newChat: async (text, how, attachments) => {
    const link = get().link
    if (!link) return
    try {
      const s = await link.call<SessionSummary>('phone.newChat', text, how ?? { mode: 'chat' }, attachments ?? [])
      set({ sessions: { ...get().sessions, [s.id]: fresh(s) } })
      get().go({ name: 'chat', id: s.id }, 'none')
      await loadLog(s.id)
    } catch (err) {
      get().say(err instanceof Error ? err.message : 'Could not start the chat.')
      throw err
    }
  },

  stop: async (id) => {
    try {
      await get().link?.call('sessions.interrupt', id)
    } catch (err) {
      get().say(err instanceof Error ? err.message : 'Could not stop it.')
    }
  },

  loadModels: async () => {
    try {
      const models = await get().link?.call<PhoneModels>('phone.models')
      if (models) set({ models })
    } catch {
      // The picker says there is nothing to choose from.
      if (!get().models) set({ models: { models: [], pinned: [] } })
    }
  },

  setModel: async (id, choice) => {
    const s = get().sessions[id]
    if (!s || !choice.model) return
    const before = { model: s.model, effort: s.effort }
    set({ sessions: { ...get().sessions, [id]: { ...s, model: choice.model, effort: choice.effort ?? null } } })
    try {
      await get().link?.call('phone.setModel', id, choice)
    } catch (err) {
      const now = get().sessions[id]
      if (now) set({ sessions: { ...get().sessions, [id]: { ...now, ...before } } })
      get().say(err instanceof Error ? err.message : 'The model did not change.')
    }
  },

  approve: async (id, requestId, allow, minutes) => {
    const s = get().sessions[id]
    if (s?.loaded) set({ sessions: { ...get().sessions, [id]: resolveApproval(s, requestId, allow) } })
    void clearNotification(requestId)
    try {
      await get().link?.call('sessions.respondApproval', id, requestId, { allow, ...(minutes !== undefined ? { minutes } : {}) })
    } catch (err) {
      get().say(err instanceof Error ? err.message : 'The answer did not reach the computer.')
    }
  },

  answer: async (id, requestId, answers) => {
    const s = get().sessions[id]
    if (s?.loaded) set({ sessions: { ...get().sessions, [id]: resolveAsk(s, requestId, answers) } })
    void clearNotification(requestId)
    try {
      await get().link?.call('sessions.respondAsk', id, requestId, answers)
    } catch (err) {
      get().say(err instanceof Error ? err.message : 'The answer did not reach the computer.')
    }
  },

  loadRuns: async () => {
    try {
      const runs = (await get().link?.call<RunSummary[]>('runs.list')) ?? []
      set({ runs: [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30) })
    } catch {
      // Shown as empty.
    }
  },

  applyPush: (push) => {
    const sessions = get().sessions
    switch (push.type) {
      case 'summary': {
        const had = sessions[push.session.id]
        set({ sessions: { ...sessions, [push.session.id]: had ? { ...had, ...push.session } : fresh(push.session) } })
        return
      }
      case 'removed': {
        const { [push.id]: _gone, ...rest } = sessions
        set({ sessions: rest })
        const screen = get().screen
        if (screen.name === 'chat' && screen.id === push.id) get().go({ name: 'home', tab: 'chats' }, 'back')
        return
      }
      case 'event': {
        tellPerson(push.sessionId, push.stored)
        const s = sessions[push.sessionId]
        if (!s?.loaded) return
        // The computer pushes every event it logs, numbered one after another: a jump means some were missed while the
        // line was down, so the chat is read again from the computer's log.
        if (push.stored.seq > s.foldedSeq + 1) return void loadLog(push.sessionId)
        set({ sessions: { ...sessions, [push.sessionId]: foldEvents(s, [push.stored]) } })
        return
      }
      case 'phoneRequest':
        void handlePhoneRequest(push.request)
        return
      case 'phoneCancel':
        void cards.cancel(push)
        return
      case 'phoneViewStart':
        set((s) => ({ shareAsked: s.shareAsked + 1 }))
        return
      case 'phoneViewStop':
        // Stop was pressed on the panel on the computer: stop showing this screen.
        void screen.stop()
        return
      case 'run': {
        const runs = [push.run, ...get().runs.filter((r) => r.id !== push.run.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30)
        set({ runs })
        return
      }
      default:
        return
    }
  }
}))

const loading = new Map<string, Promise<void>>()
const loadAgain = new Set<string>()

/** Reads a chat's log from the computer. Asked again while a read is under way, it reads once more after it. */
function loadLog(id: string): Promise<void> {
  const running = loading.get(id)
  if (running) {
    loadAgain.add(id)
    return running
  }
  const p = readLog(id).finally(() => {
    loading.delete(id)
    if (loadAgain.delete(id)) void loadLog(id)
  })
  loading.set(id, p)
  return p
}

async function readLog(id: string): Promise<void> {
  const link = useApp.getState().link
  if (!link) return
  try {
    const got = await link.call<{ summary: SessionSummary; events: StoredEvent[] } | null>('sessions.get', id)
    if (!got) return
    const had = useApp.getState().sessions[id]
    const base: Session = had?.loaded ? { ...had, ...got.summary } : { ...fresh(got.summary), loaded: true }
    useApp.setState({ sessions: { ...useApp.getState().sessions, [id]: foldEvents(base, got.events) } })
  } catch (err) {
    useApp.getState().say(err instanceof Error ? err.message : 'Could not open the chat.')
  }
}

/** A question or approval for the person: a notification when they are not looking at that chat. */
function tellPerson(sessionId: string, stored: StoredEvent): void {
  const st = useApp.getState()
  if (!st.prefs.notify) return
  // With Stay connected on, the background service shows them while the app is not on screen.
  if (st.prefs.stay && document.hidden) return
  const e = stored.event
  const title = st.sessions[sessionId]?.title ?? 'Celeste'
  const looking = !document.hidden && st.screen.name === 'chat' && st.screen.id === sessionId
  if (looking) return
  if (e.type === 'approval.requested') void notify(e.requestId, title, e.detail ? `${e.title}: ${e.detail}` : e.title, { sessionId, requestId: e.requestId, kind: 'approval' })
  else if (e.type === 'ask_user.requested') void notify(e.requestId, title, e.questions[0]?.question ?? 'Celeste has a question for you.', { sessionId, requestId: e.requestId, kind: 'ask' })
  else if (e.type === 'turn.completed' && document.hidden) void notify(sessionId, title, 'Celeste finished.', { sessionId, kind: 'done' })
}

/** Looks for the paired computer on the Wi-Fi again, in case it moved to another address. */
async function findAgain(): Promise<void> {
  const st = useApp.getState()
  if (searching || !st.pairing || !st.link) return
  searching = true
  try {
    const found = await discover(4000)
    const me = found.find((f) => f.id === st.pairing?.computer.id)
    const base = me ? `http://${me.host}:${me.port}` : null
    if (base && base !== st.link.base) {
      st.link.moveTo(base)
      const pairing = { ...(st.pairing as PhonePairing), base }
      savePairing(pairing)
      useApp.setState({ pairing })
      if (useApp.getState().prefs.stay) void keepRunning(true, pairing)
    }
  } finally {
    searching = false
  }
}

export const offlineFor = (): number => (offlineSince ? Date.now() - offlineSince : 0)

export async function askNotifications(): Promise<boolean> {
  return notificationsAllowed(true)
}
