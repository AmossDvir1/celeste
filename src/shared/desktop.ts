/*
 * Desktop control: what the assistant may ask this computer's mouse and keyboard to do, and the rules that are the same everywhere
 * (see docs/DESKTOP_CONTROL_PLAN.md). Pure, so Core, the main process and the tests all use the same words.
 */

/** Where on the screenshot, in the screenshot's own pixels. */
export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type MouseButton = 'left' | 'right' | 'middle'

export type DesktopAction =
  | { type: 'move'; at: Point }
  | { type: 'click'; at: Point; button: MouseButton; count: 1 | 2 }
  | { type: 'drag'; from: Point; to: Point }
  | { type: 'scroll'; at: Point; dx: number; dy: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string }

/** A picture of the screen, scaled down. `width` and `height` are the picture's pixels: the coordinates the assistant gives are in them. */
export interface DesktopShot {
  mime: 'image/jpeg' | 'image/png'
  /** Base64. */
  data: string
  width: number
  height: number
}

/** `moved` is set when the action was held back because the person moved the mouse since the last action. */
export type DesktopResult = { ok: true } | { ok: false; reason: string; moved?: true }

/** What the assistant may see and use: the whole main screen, one program's windows, or one window (and the dialogs it opens). */
export type DesktopScope = { kind: 'screen' } | { kind: 'app'; app: string } | { kind: 'window'; id: number; title: string; app: string }

/** A window on the screen, as the assistant is told about it. `id` is what `desktop_focus_window` takes. `app` is the program's name in lower case, without ".exe". */
export interface WindowInfo {
  id: number
  title: string
  app: string
  focused: boolean
}

/** What is under an action: the name of the button or field it would press, and whether the field takes a password. */
export interface Inspection {
  label?: string
  password?: boolean
}

/** What the control bar shows while control is on. It is also how Core tells the main process the rules of the grant. */
export interface DesktopBarState {
  sessionId: string
  /** When control ends if nothing extends it, in milliseconds since 1970. */
  until: number
  /** The last few things done, newest last. */
  lines: string[]
  scope: DesktopScope
  /** Programs (or parts of a window title) that are never touched, from Settings. */
  never: string[]
  /** Why control is waiting for the person (they moved the mouse, an approval is open), or null. */
  paused: string | null
}

export const DESKTOP_LIMITS = {
  /** How long a grant lasts when the person does not change it on the card. */
  grantMs: 20 * 60_000,
  /** The most the slider on the card gives. */
  maxGrantMs: 120 * 60_000,
  /** "Until I stop it": the longest it lasts, so a grant that is forgotten still ends (and it ends after idleMs of nothing anyway). */
  longGrantMs: 12 * 60 * 60_000,
  /** What the bar's +15 min button adds. */
  extendMs: 15 * 60_000,
  /** A grant with no action for this long ends. */
  idleMs: 5 * 60_000,
  /** The most actions in one grant. */
  maxActions: 500,
  /** The least time between two actions, so a loop cannot run away. */
  minGapMs: 250,
  maxTextLength: 2000,
  maxWaitSeconds: 10,
  /** The longer side of a screenshot. Models aim poorly at very large pictures. */
  shotLongSide: 1500,
  barLines: 3
} as const

/** The slider on the card that asks: how long one yes lasts, in minutes. It starts at the default. */
export const DESKTOP_SLIDER = { min: 5, max: DESKTOP_LIMITS.maxGrantMs / 60_000, step: 5, value: DESKTOP_LIMITS.grantMs / 60_000, until: DESKTOP_LIMITS.longGrantMs / 60_000 } as const

/** "20 minutes", "1 hour", "2 hours", "until you stop it". */
export function describeDuration(ms: number): string {
  if (ms >= DESKTOP_LIMITS.longGrantMs) return 'until you stop it'
  const minutes = Math.round(ms / 60_000)
  return minutes === 60 ? '1 hour' : minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`
}

/** Why control is waiting, as the control bar says it. The first has a Continue button; the second ends by itself when the question is answered. */
export const PAUSED_MOUSE = 'You moved the mouse. Press Continue to let the assistant carry on, or Stop.'
export const PAUSED_APPROVAL = 'Waiting for you to answer a question in Celeste. Nothing happens until you do.'

/** The key that ends control at once, from anywhere. Celeste registers it; the assistant cannot press it (it is refused as a key). */
export const DESKTOP_HOTKEY = 'Control+Alt+Esc'

/* ---------- keys ---------- */

const MODIFIERS: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  win: 'win',
  windows: 'win',
  super: 'win',
  meta: 'win',
  cmd: 'win',
  command: 'win'
}

const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pagedown: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  ' ': 'space',
  spacebar: 'space',
  bksp: 'backspace'
}

const NAMED_KEYS = new Set([
  'enter', 'tab', 'space', 'backspace', 'delete', 'escape', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'insert'
])

export type ParsedKeys = { ok: true; mods: string[]; key: string } | { ok: false; reason: string }

/**
 * "Ctrl+Shift+T" or "enter" as the modifiers and the one key. Names are lower case: letters, digits, f1 to f24, and the named keys
 * (enter, tab, space, backspace, delete, escape, home, end, pageup, pagedown, the arrows, insert). A modifier alone is not a key.
 */
export function parseKeys(input: string): ParsedKeys {
  const parts = input
    .trim()
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
  // "ctrl++" and "+" mean the plus key.
  const names: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string
    if (p === '' && i === parts.length - 1 && parts.length > 1) names.push('+')
    else if (p !== '') names.push(p)
  }
  if (names.length === 0) return { ok: false, reason: 'No key was given.' }
  const raw = names[names.length - 1] as string
  const key = KEY_ALIASES[raw] ?? raw
  const mods: string[] = []
  for (const m of names.slice(0, -1)) {
    const mod = MODIFIERS[m]
    if (!mod) return { ok: false, reason: `“${m}” is not a modifier. Use ctrl, alt, shift or win, then the key: “ctrl+c”.` }
    if (!mods.includes(mod)) mods.push(mod)
  }
  const known = NAMED_KEYS.has(key) || /^[a-z0-9]$/.test(key) || /^f([1-9]|1\d|2[0-4])$/.test(key) || key === '+'
  if (!known) {
    if (MODIFIERS[key]) return { ok: false, reason: `“${raw}” on its own is not a key to press. Press it together with another: “ctrl+c”.` }
    return { ok: false, reason: `“${raw}” is not a key I know. Use a letter, a digit, f1 to f24, enter, tab, space, backspace, delete, escape, home, end, pageup, pagedown, an arrow, or insert.` }
  }
  return { ok: true, mods, key }
}

/** Why a key combination is never sent, or null. These end the person's session or are Celeste's own stop. */
export function blockedKeys(parsed: Extract<ParsedKeys, { ok: true }>): string | null {
  const { mods, key } = parsed
  const has = (m: string) => mods.includes(m)
  if (has('win') && key === 'l') return 'Win+L locks the computer, and nothing can be controlled while it is locked.'
  if (has('ctrl') && has('alt') && key === 'delete') return 'Ctrl+Alt+Delete belongs to Windows and cannot be sent.'
  if (has('ctrl') && has('alt') && key === 'escape') return 'Ctrl+Alt+Esc is the key that stops desktop control, and only the person may press it.'
  return null
}

/* ---------- what it is called in the conversation ---------- */

const where = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`

/** One line for the conversation and the control bar. Typed text is cut short. */
export function describeAction(a: DesktopAction): string {
  switch (a.type) {
    case 'move':
      return `Move the mouse to ${where(a.at)}`
    case 'click':
      return `${a.count === 2 ? 'Double-click' : a.button === 'left' ? 'Click' : a.button === 'right' ? 'Right-click' : 'Middle-click'} at ${where(a.at)}`
    case 'drag':
      return `Drag from ${where(a.from)} to ${where(a.to)}`
    case 'scroll':
      return `Scroll ${a.dy !== 0 ? (a.dy > 0 ? 'down' : 'up') : a.dx > 0 ? 'right' : 'left'} at ${where(a.at)}`
    case 'type':
      return `Type “${a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text}”`.replace(/\r?\n/g, '↵')
    case 'key':
      return `Press ${a.keys}`
  }
}

/* ---------- scope, the never list, and what needs a second yes ---------- */

/** "C:\Program Files\KeePass\KeePass.exe" as "keepass". */
export function appName(exePath: string): string {
  const base = exePath.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.exe$/i, '').toLowerCase()
}

const normApp = (s: string) => s.trim().toLowerCase().replace(/\.exe$/, '')

/** Whether a window is one of the programs or titles the person put on the never list. */
export function neverMatches(never: string[], w: { app: string; title: string }): boolean {
  const title = w.title.toLowerCase()
  return never.some((entry) => {
    const e = normApp(entry)
    return e !== '' && (w.app === e || title.includes(e))
  })
}

/** One line for the card, the bar and the conversation. */
export function describeScope(scope: DesktopScope): string {
  switch (scope.kind) {
    case 'screen':
      return 'the whole main screen'
    case 'app':
      return `only the windows of ${scope.app}`
    case 'window':
      return `only the window “${scope.title.length > 60 ? `${scope.title.slice(0, 60)}…` : scope.title}” (${scope.app})`
  }
}

/**
 * The scope the assistant asked for, matched against the windows that are open now (newest first, as the system lists them, and without
 * Celeste's own and the never list's). It is not told which windows exist when none matches: their titles can be private.
 */
export function chooseScope(request: { app?: string; window?: string }, windows: WindowInfo[]): { ok: true; scope: DesktopScope } | { ok: false; reason: string } {
  const app = request.app?.trim()
  const title = request.window?.trim()
  if (app && title) return { ok: false, reason: 'Give either an app or a window, not both.' }
  if (title) {
    const t = title.toLowerCase()
    const w = windows.find((x) => x.title.toLowerCase().includes(t))
    if (!w) return { ok: false, reason: `No open window has “${title}” in its title. Open the app first, or ask for the whole screen if the task really needs it.` }
    return { ok: true, scope: { kind: 'window', id: w.id, title: w.title, app: w.app } }
  }
  if (app) {
    const a = normApp(app)
    const w = windows.find((x) => x.app === a) ?? windows.find((x) => x.app.startsWith(a))
    if (!w) return { ok: false, reason: `No open window belongs to a program called “${app}”. Open the app first, or ask for the whole screen if the task really needs it.` }
    return { ok: true, scope: { kind: 'app', app: w.app } }
  }
  return { ok: true, scope: { kind: 'screen' } }
}

/** Whether a window, by its program and title, is inside the scope. Owned windows (a dialog the program opened) are the same program. */
export function inScope(scope: DesktopScope, w: { id: number; app: string; ownerId: number }): boolean {
  switch (scope.kind) {
    case 'screen':
      return true
    case 'app':
      return w.app === scope.app
    case 'window':
      return w.id === scope.id || w.ownerId === scope.id
  }
}

const CONSEQUENTIAL =
  /\b(send|buy|purchase|pay|checkout|order|delete|remove|erase|discard|uninstall|install|format|reset|empty|confirm|submit|sign|transfer|post|publish|share|accept|agree|allow|grant|authori[sz]e|approve)\b/i

/** Whether the name of a button or field is one whose press has a result that cannot be taken back. A net, not a guarantee. */
export function isConsequential(label: string | undefined): boolean {
  return !!label && label.length <= 200 && CONSEQUENTIAL.test(label)
}

/** Keys that press what has the keyboard (so what has it is checked against the list above). */
export function pressesFocused(keys: string): boolean {
  const p = parseKeys(keys)
  return p.ok && (p.key === 'enter' || p.key === 'space') && !p.mods.includes('alt') && !p.mods.includes('win')
}

/* ---------- Celeste's own windows ---------- */

export function insideRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
}

/** What the main process knows when it is asked to act: where Celeste's own windows are, in screen pixels, and whether one has the keyboard. */
export interface GuardContext {
  celesteRects: Rect[]
  celesteHasFocus: boolean
  /**
   * Whether a window of another program is the one on top at this screen point. Celeste's windows are left out of screenshots, so a point
   * can look like another program's while Celeste is really in front; a point inside a Celeste window's bounds is only allowed when
   * this says another program covers it. Left out: any point inside a Celeste window's bounds is refused.
   */
  coveredByOther?: (p: Point) => boolean
}

/** The points on the screen that an action touches (the ends of a drag, the place of a click). Typing and keys have none. */
export function pointsOf(a: DesktopAction): Point[] {
  switch (a.type) {
    case 'move':
    case 'click':
    case 'scroll':
      return [a.at]
    case 'drag':
      return [a.from, a.to]
    default:
      return []
  }
}

/**
 * Why an action is refused because of Celeste's own windows, or null. An agent that can click anywhere could otherwise click Allow on
 * Celeste's own approval card, and a click sent through the system looks like a real one. `screenPoints` are the action's points in
 * screen pixels (see `pointsOf`, after converting from the screenshot).
 */
export function refuseForCeleste(a: DesktopAction, screenPoints: Point[], ctx: GuardContext): string | null {
  for (const p of screenPoints) {
    if (ctx.celesteRects.some((r) => insideRect(p, r)) && !ctx.coveredByOther?.(p)) return 'That point is inside a Celeste window. Celeste’s own windows are off limits, so nothing can be approved or stopped from here.'
  }
  if ((a.type === 'type' || a.type === 'key') && ctx.celesteHasFocus) return 'A Celeste window is in front, and it cannot be typed into. Click on the window you want to type in first.'
  return null
}
