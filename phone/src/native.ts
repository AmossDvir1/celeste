// What the app asks of Android: finding Celeste on the Wi-Fi, the phone's name, staying connected in the background,
// notifications with Approve and Deny, and the Back button. Each has a stand-in so the app also runs in a desktop browser
// (npm run dev), where nothing is found and the address is typed.

import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { sessionKeyBytes, toB64 } from '@shared/phone'
import type { PhonePairing } from '@shared/phone-client'

export interface FoundComputer {
  /** As announced: "Celeste on DANA-PC". */
  name: string
  host: string
  port: number
  /** The computer's Celeste id, to find the same one again after its address changes. */
  id?: string
}

/** What Android keeps of the pairing so its background parts can reach the computer: on the Wi-Fi, and through the relay. */
interface LineOpts {
  base: string
  phoneId: string
  computer: string
  key: string
  relayUrl?: string
  relayRoom?: string
}

const relayOf = (p: PhonePairing) => (p.relay ? { relayUrl: p.relay.url, relayRoom: p.relay.room } : {})

interface CelesteNativePlugin {
  /** Looks for `_celeste._tcp` on the Wi-Fi for `ms` milliseconds. */
  discover(opts: { ms: number }): Promise<{ found: FoundComputer[] }>
  /** The name the person gave the phone ("Galaxy S24"), else its model. */
  deviceName(): Promise<{ name: string }>
  /** Starts the background line: its own encrypted stream from the computer, for notifications with the app closed. */
  startService(opts: LineOpts): Promise<void>
  stopService(opts: { forget?: boolean }): Promise<void>
  setLine(opts: LineOpts): Promise<void>
  handleRequest(opts: { request: string }): Promise<void>
  abilities(): Promise<AbilityState>
  setAbility(opts: { ability: string; on: boolean }): Promise<void>
  apps(): Promise<{ apps: PhoneApp[] }>
  setNever(opts: { pkg: string; on: boolean }): Promise<void>
  openNotificationAccess(): Promise<void>
  openAppInfo(): Promise<void>
  openAccessibility(): Promise<void>
  clipboardInfo(): Promise<{ files: number }>
  clipboardFiles(): Promise<{ files: { name: string; mime: string; data: string }[] }>
}

/** Which phone abilities the person switched on, and whether Android's Notification access is on for Celeste. */
export interface AbilityState {
  notifications: boolean
  open: boolean
  alarm: boolean
  location: boolean
  /** Photos and files the person picks. */
  files: boolean
  calendar: boolean
  /** Texts and calls: the messaging or phone app opens ready, and the person presses Send or Call. */
  messages: boolean
  control: boolean
  notificationAccess: boolean
  /** Celeste phone control is switched on in Android's Accessibility settings. */
  controlAccess: boolean
  /** Ask again before buttons like Send, Pay or Delete (off by default: one grant covers the task). */
  controlConfirm: boolean
  /** How many apps the person added to the never list. */
  never: number
}

/** An app on the phone, for the never list. `fixed`: always off-limits (password managers, Android's installer). */
export interface PhoneApp {
  pkg: string
  name: string
  never: boolean
  fixed: boolean
}

const Native = registerPlugin<CelesteNativePlugin>('CelesteNative', {
  web: {
    discover: async () => ({ found: [] }),
    deviceName: async () => ({ name: 'Browser' }),
    startService: async () => undefined,
    stopService: async () => undefined,
    setLine: async () => undefined,
    handleRequest: async () => undefined,
    abilities: async () => ({ notifications: false, open: false, alarm: false, location: false, files: false, calendar: false, messages: false, control: false, notificationAccess: false, controlAccess: false, controlConfirm: false, never: 0 }),
    apps: async () => ({ apps: [] }),
    setNever: async () => undefined,
    setAbility: async () => undefined,
    openNotificationAccess: async () => undefined,
    openAppInfo: async () => undefined,
    openAccessibility: async () => undefined,
    clipboardInfo: async () => ({ files: 0 }),
    clipboardFiles: async () => ({ files: [] })
  } as unknown as CelesteNativePlugin
})

export const isNative = Capacitor.isNativePlatform()

export async function discover(ms = 5000): Promise<FoundComputer[]> {
  try {
    const { found } = await Native.discover({ ms })
    // One entry per computer, even when it is announced on two networks.
    const seen = new Set<string>()
    return found.filter((f) => {
      const k = f.id ?? `${f.host}:${f.port}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  } catch {
    return []
  }
}

export async function deviceName(): Promise<string> {
  try {
    return (await Native.deviceName()).name || 'Android phone'
  } catch {
    return 'Android phone'
  }
}

/**
 * Starts or stops the background line. It gets the pairing's shared key (never the private key), kept in the app's own
 * storage. `forget` removes that too.
 */
export async function keepRunning(on: boolean, pairing: PhonePairing | null, forget = false): Promise<void> {
  try {
    if (on && pairing) {
      const key = await sessionKeyBytes(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
      await Native.startService({ base: pairing.base, phoneId: pairing.phoneId, computer: pairing.computer.name, key: toB64(key), ...relayOf(pairing) })
    } else await Native.stopService({ forget })
  } catch {
    // Not on Android, or Android refused: the app still works while it is open.
  }
}

/** Gives Android the line's details, so a phone ability can answer the computer even with the app closed. */
export async function shareLine(pairing: PhonePairing): Promise<void> {
  try {
    const key = await sessionKeyBytes(pairing.keys.priv, pairing.computer.key, pairing.computer.key, pairing.keys.pub)
    await Native.setLine({ base: pairing.base, phoneId: pairing.phoneId, computer: pairing.computer.name, key: toB64(key), ...relayOf(pairing) })
  } catch {
    // Not on Android.
  }
}

/** The computer asks the phone to do something: Android shows the person the card (once, however it arrived). */
export async function handlePhoneRequest(request: unknown): Promise<void> {
  try {
    await Native.handleRequest({ request: JSON.stringify(request) })
  } catch {
    // Not on Android: nothing can be done here, and the computer times the request out.
  }
}

export const abilities = {
  get: (): Promise<AbilityState> =>
    Native.abilities().catch(() => ({ notifications: false, open: false, alarm: false, location: false, files: false, calendar: false, messages: false, control: false, notificationAccess: false, controlAccess: false, controlConfirm: false, never: 0 })),
  set: (ability: string, on: boolean): Promise<void> => Native.setAbility({ ability, on }).catch(() => undefined),
  apps: (): Promise<PhoneApp[]> => Native.apps().then((r) => r.apps, () => []),
  setNever: (pkg: string, on: boolean): Promise<void> => Native.setNever({ pkg, on }),
  openNotificationAccess: (): Promise<void> => Native.openNotificationAccess().catch(() => undefined),
  openAppInfo: (): Promise<void> => Native.openAppInfo().catch(() => undefined),
  openAccessibility: (): Promise<void> => Native.openAccessibility().catch(() => undefined)
}

/** Files (a copied picture, a copied file) on the clipboard: Android's WebView does not hand them to a paste. */
export const clipboard = {
  /** How many files the clipboard holds now (0 off Android). */
  count: (): Promise<number> => Native.clipboardInfo().then((r) => r.files, () => 0),
  /** Reads them, as the person pressed Paste. */
  async files(): Promise<File[]> {
    const { files } = await Native.clipboardFiles()
    return files.map((f) => {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
      return new File([bytes], f.name, { type: f.mime })
    })
  }
}

/** A card that asks the person something: a phone ability, phone control, or a second yes. */
export interface PhoneCard {
  id: string
  title: string
  text: string
}

export const cards = {
  /** Calls `listener` with the open cards now and whenever they change. Returns how to stop listening. */
  watch(listener: (list: PhoneCard[]) => void): () => void {
    let off: (() => void) | null = null
    let stopped = false
    void (Native as unknown as { cards(): Promise<{ cards: PhoneCard[] }> })
      .cards()
      .then((r) => !stopped && listener(r.cards))
      .catch(() => undefined)
    void (Native as unknown as { addListener(e: string, f: (d: { cards: PhoneCard[] }) => void): Promise<{ remove(): void }> })
      .addListener('cards', (d) => listener(d.cards))
      .then((h) => {
        if (stopped) h.remove()
        else off = () => h.remove()
      })
      .catch(() => undefined)
    return () => {
      stopped = true
      off?.()
    }
  },
  answer: (id: string, yes: boolean): Promise<void> => (Native as unknown as { answerCard(o: { id: string; yes: boolean }): Promise<void> }).answerCard({ id, yes }).catch(() => undefined),
  /** Stop was pressed in the chat on the computer. */
  cancel: (push: unknown): Promise<void> => (Native as unknown as { cancelRequests(o: { push: string }): Promise<void> }).cancelRequests({ push: JSON.stringify(push) }).catch(() => undefined)
}

/** Notification ids are 32-bit numbers; requests have string ids. */
function idFor(key: string): number {
  let h = 7
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return Math.abs(h) || 1
}

export type NotifyExtra = { sessionId: string; requestId?: string; kind: 'approval' | 'ask' | 'done' }

export async function setupNotifications(onAction: (action: string, extra: NotifyExtra) => void): Promise<void> {
  try {
    await LocalNotifications.registerActionTypes({
      types: [{ id: 'approval', actions: [{ id: 'deny', title: 'Deny', destructive: true }, { id: 'allow', title: 'Approve' }] }]
    })
    await LocalNotifications.addListener('localNotificationActionPerformed', (a) => onAction(a.actionId, a.notification.extra as NotifyExtra))
  } catch {
    // No notifications here.
  }
}

export async function notificationsAllowed(ask: boolean): Promise<boolean> {
  try {
    const now = await LocalNotifications.checkPermissions()
    if (now.display === 'granted') return true
    if (!ask) return false
    return (await LocalNotifications.requestPermissions()).display === 'granted'
  } catch {
    return false
  }
}

export async function notify(key: string, title: string, body: string, extra: NotifyExtra): Promise<void> {
  try {
    await LocalNotifications.schedule({
      // Shown now, not at a time: never "exact", which would send the person to Android's Alarms & reminders page.
      notifications: [{ id: idFor(key), title, body, extra, ...(extra.kind === 'approval' ? { actionTypeId: 'approval' } : {}), autoCancel: true, isExactNotification: false }]
    })
  } catch {
    // Not allowed: the chat list still shows what needs the person.
  }
}

export async function clearNotification(key: string): Promise<void> {
  try {
    await LocalNotifications.cancel({ notifications: [{ id: idFor(key) }] })
  } catch {
    // Nothing to clear.
  }
}

/** Android's Back: `handler` returns true when it went back somewhere; otherwise the app goes to the background. */
export function onBack(handler: () => boolean): void {
  if (!isNative) return
  void App.addListener('backButton', () => {
    if (!handler()) void App.minimizeApp()
  })
}

export function onResume(handler: () => void): void {
  if (!isNative) return
  void App.addListener('resume', handler)
}

/** Secrets of the app (the pairing), kept by Android encrypted with a key in the Android Keystore. */
export const secure = {
  get: async (name: string): Promise<string | null> =>
    (await (Native as unknown as { secureGet(o: { name: string }): Promise<{ value?: string }> }).secureGet({ name })).value ?? null,
  set: (name: string, value: string | null): Promise<void> =>
    (Native as unknown as { secureSet(o: { name: string; value?: string }): Promise<void> }).secureSet({ name, ...(value !== null ? { value } : {}) })
}

/** This app's version, as Android has it (the one in phone/package.json); null in a browser. */
export async function appVersion(): Promise<string | null> {
  if (!isNative) return null
  try {
    return (await App.getInfo()).version
  } catch {
    return null
  }
}

/**
 * Text or a link another app shared to Celeste: `handler` gets it once, whether it was shared before the app loaded or
 * while it is open. The phone keeps it until it is taken, so it is never handled twice.
 */
export function onShared(handler: (text: string) => void): void {
  if (!isNative) return
  const n = Native as unknown as { takeShared(): Promise<{ text?: string }>; addListener(e: string, f: () => void): Promise<unknown> }
  const take = () =>
    void n
      .takeShared()
      .then((r) => r.text && handler(r.text))
      .catch(() => undefined)
  take()
  void n.addListener('shared', take).catch(() => undefined)
}
