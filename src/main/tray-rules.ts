/*
 * The rules for the tray, as plain functions so they are tested without Electron. docs/TRAY_AND_COMPACT_PLAN.md, Part 1.
 */

export interface CloseState {
  platform: NodeJS.Platform
  /** The person's choice in Settings, General. */
  closeToTray: boolean
  /** Celeste is on its way out (Quit, an update, the computer shutting down): a window must really close. */
  quitting: boolean
  /** The tray icon exists, so there is a way back in. */
  trayReady: boolean
}

/**
 * Whether closing the window should hide it and leave Celeste running. Windows only: the Mac keeps an app open without a window
 * already, and a Linux tray is often not there at all, so a hidden window could not be found again.
 */
export function hidesOnClose(s: CloseState): boolean {
  return s.platform === 'win32' && s.closeToTray && !s.quitting && s.trayReady
}

/** The words on the tray icon when the pointer rests on it. */
export function tooltip(working: number, waiting: number, schedulesPaused = false): string {
  const parts = [
    ...(working > 0 ? [`${working} working`] : []),
    ...(waiting > 0 ? [`${waiting} ${waiting === 1 ? 'needs' : 'need'} you`] : []),
    ...(schedulesPaused ? ['schedules paused'] : [])
  ]
  return parts.length ? `Celeste: ${parts.join(', ')}` : 'Celeste'
}

/** The words of the tray menu's item for pausing the schedules, or null while there are none (and none are paused) to pause. */
export function pauseItem(count: number, paused: boolean): string | null {
  if (paused) return 'Resume all schedules'
  return count > 0 ? 'Pause all schedules' : null
}

/**
 * Whether Celeste, started with the computer (`--background`), leaves its window hidden. Only when there is a tray icon to bring it back
 * from: a hidden window nobody can find again would look like Celeste not running.
 */
export function startsHidden(s: { background: boolean; platform: NodeJS.Platform; trayReady: boolean }): boolean {
  return s.background && s.platform === 'win32' && s.trayReady
}

/** The question before quitting from the tray, or null when nothing is going on and Celeste simply quits. */
export function quitQuestion(working: number, waiting: number): string | null {
  const n = working + waiting
  if (n === 0) return null
  return `${n === 1 ? 'One chat, workflow or command is' : `${n} chats, workflows and commands are`} still going. If you quit now, ${n === 1 ? 'it stops' : 'they stop'}.`
}

/** Whether to show a notification for something that needs the person: not while they are looking at Celeste. */
export function shouldNotify(win: { visible: boolean; minimized: boolean; focused: boolean } | null): boolean {
  return !win || !win.visible || win.minimized || !win.focused
}

/** Paints a small dot in the bottom right corner of a square BGRA picture (what `nativeImage.toBitmap` gives), to say something needs you. */
export function paintDot(bitmap: Buffer, size: number, colour: { r: number; g: number; b: number } = { r: 244, g: 95, b: 157 }): Buffer {
  const out = Buffer.from(bitmap)
  const radius = Math.max(3, Math.round(size * 0.22))
  const cx = size - radius - 1
  const cy = size - radius - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d > radius) continue
      const at = (y * size + x) * 4
      out[at] = colour.b
      out[at + 1] = colour.g
      out[at + 2] = colour.r
      out[at + 3] = 255
    }
  }
  return out
}
