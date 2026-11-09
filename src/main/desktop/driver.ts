import type { MouseButton, Point } from '@shared/desktop'

/**
 * The one thing that sends the mouse and keyboard. Everything above it speaks in screen pixels and in key names, so a fake can stand in
 * for it in the tests and another system can have its own (Windows first: `SendInput` through koffi, with no program of ours to sign).
 */
export interface InputDriver {
  cursor(): Point
  move(p: Point): void
  button(b: MouseButton, down: boolean): void
  /** Wheel clicks: `dy` positive scrolls down, `dx` positive scrolls right. */
  wheel(dx: number, dy: number): void
  /** Types text as the person would, one character after another (Unicode, so any language and symbols work). */
  text(text: string): Promise<void>
  /** Holds the modifiers, presses the key, lets go. Names are those of `parseKeys`. */
  keys(mods: string[], key: string): Promise<void>
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const VK: Record<string, number> = {
  enter: 0x0d,
  tab: 0x09,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  escape: 0x1b,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  ctrl: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b
}

/** Keys that need the "extended" flag, or the system sends the number-pad key of the same code. */
const EXTENDED = new Set(['delete', 'home', 'end', 'pageup', 'pagedown', 'left', 'up', 'right', 'down', 'insert', 'win'])

/** The Windows virtual-key code for a name from `parseKeys`, or undefined for one that is typed as a character instead (the plus sign). */
export function virtualKey(name: string): number | undefined {
  if (VK[name] !== undefined) return VK[name]
  if (/^[a-z]$/.test(name)) return name.charCodeAt(0) - 32 // 'a' is 0x41
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0) // '0' is 0x30
  const f = /^f(\d{1,2})$/.exec(name)
  if (f) return 0x70 + Number(f[1]) - 1
  return undefined
}

const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const KEYEVENTF_UNICODE = 0x4
const MOUSE_DOWN: Record<MouseButton, number> = { left: 0x2, right: 0x8, middle: 0x20 }
const MOUSE_UP: Record<MouseButton, number> = { left: 0x4, right: 0x10, middle: 0x40 }
const MOUSEEVENTF_WHEEL = 0x800
const MOUSEEVENTF_HWHEEL = 0x1000
const WHEEL_DELTA = 120

/** `SendInput` from user32 through koffi. Loaded only when used, and only on Windows. */
export function createWindowsDriver(): InputDriver {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi')
  const user32 = koffi.load('user32.dll')
  const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' })
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT }) })
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)')
  const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)')
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')

  const send = (list: unknown[]): void => {
    const sent = SendInput(list.length, list, koffi.sizeof(INPUT)) as number
    // Fewer than asked means the system blocked it: the other program is running as an administrator, or the desktop is locked.
    if (sent !== list.length) throw new Error('Windows did not accept the input. The program in front may be running as an administrator, which Celeste cannot control, or the screen may be locked.')
  }
  const mouse = (flags: number, data = 0) => ({ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } })
  const vk = (code: number, up: boolean, extended: boolean) => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: code, wScan: 0, dwFlags: (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0), time: 0, dwExtraInfo: 0 } }
  })
  const unit = (code: number, up: boolean) => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } }
  })

  return {
    cursor() {
      const p: Point = { x: 0, y: 0 }
      GetCursorPos(p)
      return p
    },
    move(p) {
      SetCursorPos(Math.round(p.x), Math.round(p.y))
    },
    button(b, down) {
      send([mouse(down ? MOUSE_DOWN[b] : MOUSE_UP[b])])
    },
    wheel(dx, dy) {
      const list = []
      if (dy) list.push(mouse(MOUSEEVENTF_WHEEL, -dy * WHEEL_DELTA))
      if (dx) list.push(mouse(MOUSEEVENTF_HWHEEL, dx * WHEEL_DELTA))
      if (list.length) send(list)
    },
    async text(text) {
      const units: number[] = []
      for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i))
      let chunk: unknown[] = []
      const flush = async () => {
        if (chunk.length) send(chunk)
        chunk = []
        await sleep(15)
      }
      for (const code of units) {
        // A new line is the Enter key and a tab is the Tab key: as characters, many programs ignore them.
        if (code === 0x0d) continue
        if (code === 0x0a || code === 0x09) {
          await flush()
          const key = code === 0x0a ? VK.enter : VK.tab
          send([vk(key as number, false, false), vk(key as number, true, false)])
          await sleep(15)
          continue
        }
        chunk.push(unit(code, false), unit(code, true))
        if (chunk.length >= 80) await flush()
      }
      await flush()
    },
    async keys(mods, key) {
      const main = virtualKey(key)
      if (main === undefined && key !== '+') throw new Error(`There is no key called ${key}.`)
      const down: unknown[] = []
      const up: unknown[] = []
      for (const m of mods) {
        const code = VK[m] as number
        down.push(vk(code, false, EXTENDED.has(m)))
        up.unshift(vk(code, true, EXTENDED.has(m)))
      }
      if (main === undefined) {
        // The plus sign has no key of its own that is the same on every keyboard layout, so it is typed as a character.
        down.push(unit(0x2b, false), unit(0x2b, true))
      } else {
        down.push(vk(main, false, EXTENDED.has(key)), vk(main, true, EXTENDED.has(key)))
      }
      send([...down, ...up])
      await sleep(20)
    }
  }
}
