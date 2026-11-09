import { appName, type Inspection, type Point, type Rect } from '@shared/desktop'

/**
 * What Windows knows about the windows on the screen and about the field that has the keyboard. Everything above this speaks in these
 * records, so a fake can stand in for it in the tests. Loaded only when used, and only on Windows (user32 and dwmapi through koffi; UI
 * Automation through its COM interface, which needs no program of ours either).
 */
export interface WinRecord {
  /** The window's handle. */
  id: number
  /** The window that owns this one (a dialog's owner is the window that opened it), or itself. */
  ownerId: number
  pid: number
  title: string
  /** The program, lower case, without ".exe". */
  app: string
  /** The visible frame, in screen pixels. */
  bounds: Rect
  minimized: boolean
}

export interface WindowsApi {
  /**
   * The windows a person would see in a window switcher, topmost first. With `all`: every window that is drawn on the screen, menus and
   * pop-ups included, which is what deciding what a picture may show needs (click-through overlays are still left out).
   */
  list(all?: boolean): WinRecord[]
  /** The window that has the keyboard, or null. */
  foreground(): WinRecord | null
  /** The window under a point, or null. */
  at(p: Point): WinRecord | null
  /** One window by its handle, or null when it has gone. */
  byId(id: number): WinRecord | null
  /** Brings a window to the front (and out of the taskbar if it was minimized). Whether it is in front now. */
  focus(id: number): boolean
  /** The field that has the keyboard: whether it takes a password and what it is called. Empty when the system cannot say. */
  focusedField(): Inspection
  /** The button or field under a point: what it is called. */
  elementAt(p: Point): Inspection
}

const GA_ROOT = 2
const GA_ROOTOWNER = 3
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_TRANSPARENT = 0x20
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14

// IUIAutomation and IUIAutomationElement are COM interfaces; these are the places of the calls we make in their tables of functions.
const UIA_GET_FOCUSED_ELEMENT = 8
const UIA_ELEMENT_FROM_POINT = 7
const UIAELEMENT_NAME = 23
const UIAELEMENT_ISPASSWORD = 35
const RELEASE = 2

export function createWindowsApi(): WindowsApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi')
  const user32 = koffi.load('user32.dll')
  const dwm = koffi.load('dwmapi.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const ole32 = koffi.load('ole32.dll')
  const oleaut32 = koffi.load('oleaut32.dll')

  const RECT = koffi.struct('CLWRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
  const POINT = koffi.struct('CLWPOINT', { x: 'int32', y: 'int32' })
  const CLWEnumProc = koffi.proto('bool __stdcall CLWEnumProc(intptr hwnd, intptr lparam)')
  const EnumWindows = user32.func('bool __stdcall EnumWindows(CLWEnumProc *cb, intptr lparam)')
  const IsWindow = user32.func('bool __stdcall IsWindow(intptr h)')
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr h)')
  const IsIconic = user32.func('bool __stdcall IsIconic(intptr h)')
  const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr h, int cmd)')
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr h, _Out_ uint16 *buf, int max)')
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr h, _Out_ uint32 *pid)')
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr h, _Out_ CLWRECT *r)')
  const GetAncestor = user32.func('intptr __stdcall GetAncestor(intptr h, uint32 flags)')
  const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()')
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr h)')
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr h)')
  const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 from, uint32 to, bool attach)')
  const WindowFromPoint = user32.func('intptr __stdcall WindowFromPoint(CLWPOINT p)')
  const GetWindowLongW = user32.func('int32 __stdcall GetWindowLongW(intptr h, int idx)')
  const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')
  const DwmFrame = dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr h, uint32 attr, _Out_ CLWRECT *out, uint32 size)')
  const DwmInt = dwm.func('int32 __stdcall DwmGetWindowAttribute(intptr h, uint32 attr, _Out_ int32 *out, uint32 size)')
  const OpenProcess = kernel32.func('intptr __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr h)')
  const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr h, uint32 flags, _Out_ uint16 *buf, _Inout_ uint32 *size)')

  const text = (buf: Uint16Array, n: number) => String.fromCharCode(...buf.subarray(0, Math.max(0, n)))
  const titleOf = (h: number) => {
    const buf = new Uint16Array(512)
    return text(buf, GetWindowTextW(h, buf, 512) as number)
  }
  const exeOf = (pid: number): string => {
    const h = OpenProcess(0x1000, false, pid) as number // PROCESS_QUERY_LIMITED_INFORMATION
    if (!h) return ''
    try {
      const buf = new Uint16Array(1024)
      const size = [1024]
      return QueryFullProcessImageNameW(h, 0, buf, size) ? text(buf, size[0] as number) : ''
    } finally {
      CloseHandle(h)
    }
  }
  const frameOf = (h: number): Rect => {
    const f = { left: 0, top: 0, right: 0, bottom: 0 }
    // The visible frame, without the invisible border Windows adds round a window for resizing; the plain rectangle if it cannot say.
    if (DwmFrame(h, DWMWA_EXTENDED_FRAME_BOUNDS, f, 16) !== 0) GetWindowRect(h, f)
    return { x: f.left, y: f.top, width: f.right - f.left, height: f.bottom - f.top }
  }
  const record = (h: number): WinRecord | null => {
    if (!h || !IsWindow(h)) return null
    const pid = [0]
    GetWindowThreadProcessId(h, pid)
    const owner = (GetAncestor(h, GA_ROOTOWNER) as number) || h
    return { id: h, ownerId: owner, pid: pid[0] as number, title: titleOf(h), app: appName(exeOf(pid[0] as number)), bounds: frameOf(h), minimized: !!IsIconic(h) }
  }

  const list = (all = false): WinRecord[] => {
    const handles: number[] = []
    const cb = koffi.register((h: number) => {
      handles.push(h)
      return true
    }, koffi.pointer(CLWEnumProc))
    try {
      EnumWindows(cb, 0)
    } finally {
      koffi.unregister(cb)
    }
    const out: WinRecord[] = []
    for (const h of handles) {
      if (!IsWindowVisible(h)) continue
      const style = GetWindowLongW(h, -20) as number
      if (all ? style & WS_EX_TRANSPARENT : style & WS_EX_TOOLWINDOW) continue
      const cloaked = [0] // windows of other virtual desktops and suspended apps are "visible" but cloaked
      DwmInt(h, DWMWA_CLOAKED, cloaked, 4)
      if (cloaked[0]) continue
      const r = record(h)
      if (r && (all || r.title)) out.push(r)
    }
    return out
  }

  const topLevel = (h: number) => (h ? (GetAncestor(h, GA_ROOT) as number) || h : 0)

  // ---- UI Automation, by its COM interface.
  const GUID = koffi.struct('CLWGUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) })
  const guid = (s: string) => {
    const b = Buffer.from(s.replace(/[{}-]/g, ''), 'hex')
    return { d1: b.readUInt32BE(0), d2: b.readUInt16BE(4), d3: b.readUInt16BE(6), d4: [...b.subarray(8, 16)] }
  }
  const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *r, uint32 flags)')
  const CoCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(CLWGUID *clsid, void *outer, uint32 ctx, CLWGUID *iid, _Out_ void **ppv)')
  const SysFreeString = oleaut32.func('void __stdcall SysFreeString(void *s)')
  const PGetFocused = koffi.proto('int32 __stdcall GetFocusedElement(void *self, _Out_ void **out)')
  const PElementFromPoint = koffi.proto('int32 __stdcall ElementFromPoint(void *self, CLWPOINT p, _Out_ void **out)')
  const PGetBool = koffi.proto('int32 __stdcall GetBool(void *self, _Out_ int32 *out)')
  const PGetBstr = koffi.proto('int32 __stdcall GetBstr(void *self, _Out_ void **out)')
  const PRelease = koffi.proto('uint32 __stdcall Release(void *self)')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slot = (obj: unknown, i: number, proto: any): any => {
    const table = koffi.decode(obj, 'void *')
    return koffi.decode(koffi.decode(table, i * 8, 'void *'), proto)
  }
  let automation: unknown = null
  const uia = (): unknown => {
    if (automation) return automation
    CoInitializeEx(null, 2) // already started by the window system on this thread, which is fine
    const out: unknown[] = [null]
    const hr = CoCreateInstance(guid('ff48dba4-60ef-4201-aa87-54103eef594e'), null, 1, guid('30cbe57d-d9d0-452a-ab13-7ac5ac4825ee'), out) as number
    if (hr !== 0 || !out[0]) throw new Error('UI Automation is not available.')
    automation = out[0]
    return automation
  }
  const describe = (el: unknown): Inspection => {
    const pw = [0]
    const name: unknown[] = [null]
    const r1 = slot(el, UIAELEMENT_ISPASSWORD, PGetBool)(el, pw) as number
    const r2 = slot(el, UIAELEMENT_NAME, PGetBstr)(el, name) as number
    let label: string | undefined
    if (r2 === 0 && name[0]) {
      label = koffi.decode(name[0], 'char16_t', -1) as string
      SysFreeString(name[0])
    }
    return { password: r1 === 0 ? pw[0] !== 0 : undefined, label: label || undefined }
  }
  const withElement = (get: (a: unknown, out: unknown[]) => number): Inspection => {
    try {
      const a = uia()
      const out: unknown[] = [null]
      if (get(a, out) !== 0 || !out[0]) return {}
      try {
        return describe(out[0])
      } finally {
        slot(out[0], RELEASE, PRelease)(out[0])
      }
    } catch {
      return {}
    }
  }

  return {
    list,
    foreground: () => {
      const h = topLevel(GetForegroundWindow() as number)
      return h ? record(h) : null
    },
    at: (p) => {
      const h = topLevel(WindowFromPoint({ x: Math.round(p.x), y: Math.round(p.y) }) as number)
      return h ? record(h) : null
    },
    byId: (id) => record(id),
    focus: (id) => {
      if (!IsWindow(id)) return false
      if (IsIconic(id)) ShowWindow(id, 9) // SW_RESTORE
      // Windows only lets the program that has the keyboard hand it on, so this thread joins the one that has it for a moment.
      const front = GetForegroundWindow() as number
      const mine = GetCurrentThreadId() as number
      const theirs = front ? (GetWindowThreadProcessId(front, [0]) as number) : 0
      if (theirs && theirs !== mine) AttachThreadInput(mine, theirs, true)
      try {
        BringWindowToTop(id)
        SetForegroundWindow(id)
      } finally {
        if (theirs && theirs !== mine) AttachThreadInput(mine, theirs, false)
      }
      return topLevel(GetForegroundWindow() as number) === (GetAncestor(id, GA_ROOT) as number || id)
    },
    focusedField: () => withElement((a, out) => slot(a, UIA_GET_FOCUSED_ELEMENT, PGetFocused)(a, out) as number),
    elementAt: (p) => withElement((a, out) => slot(a, UIA_ELEMENT_FROM_POINT, PElementFromPoint)(a, { x: Math.round(p.x), y: Math.round(p.y) }, out) as number)
  }
}
