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

export type DesktopResult = { ok: true } | { ok: false; reason: string }

/** What the control bar shows while control is on. */
export interface DesktopBarState {
  sessionId: string
  /** When control ends if nothing extends it, in milliseconds since 1970. */
  until: number
  /** The last few things done, newest last. */
  lines: string[]
}

export const DESKTOP_LIMITS = {
  /** How long a grant lasts. */
  grantMs: 15 * 60_000,
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

/* ---------- Celeste's own windows ---------- */

export function insideRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
}

/** What the main process knows when it is asked to act: where Celeste's own windows are, in screen pixels, and whether one has the keyboard. */
export interface GuardContext {
  celesteRects: Rect[]
  celesteHasFocus: boolean
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
    if (ctx.celesteRects.some((r) => insideRect(p, r))) return 'That point is inside a Celeste window. Celeste’s own windows are off limits, so nothing can be approved or stopped from here.'
  }
  if ((a.type === 'type' || a.type === 'key') && ctx.celesteHasFocus) return 'A Celeste window is in front, and it cannot be typed into. Click on the window you want to type in first.'
  return null
}
