/*
 * Where the compact window goes and how big it is, as plain functions so they are tested without Electron.
 * docs/TRAY_AND_COMPACT_PLAN.md, Part 2.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const COMPACT = {
  /** About the size of the side window in the owner's picture. */
  width: 520,
  maxHeight: 700,
  /** A share of the work area's height. */
  heightShare: 0.7,
  minWidth: 360,
  minHeight: 480,
  margin: 12,
  /** The height of the top bar in compact view, which the native window buttons are drawn to match. */
  barHeight: 44
} as const

/** The usual size of the window, and its smallest. */
export const FULL = { minWidth: 1040, minHeight: 640, barHeight: 56 } as const

/** How the window changes shape: the page fades out, the window moves and resizes, the page fades in (all in milliseconds). */
export const MORPH = { fadeOut: 90, move: 220, frame: 16 } as const

/** Slow at both ends, quick in the middle. `t` runs from 0 to 1. */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** The window between two places, `t` of the way (0 is `a`, 1 is `b`), in whole pixels because that is all a window can take. */
export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  const at = (from: number, to: number) => Math.round(from + (to - from) * t)
  return { x: at(a.x, b.x), y: at(a.y, b.y), width: at(a.width, b.width), height: at(a.height, b.height) }
}

/** The usual size of the full window, centred in a usable area: for when no earlier size is known. */
export function centred(area: Rect, width = 1440, height = 920): Rect {
  const w = Math.min(width, area.width)
  const h = Math.min(height, area.height)
  return { x: Math.round(area.x + (area.width - w) / 2), y: Math.round(area.y + (area.height - h) / 2), width: w, height: h }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The size of the compact window on a screen whose usable area (without the taskbar) is `area`. */
export function compactSize(area: Rect): { width: number; height: number } {
  const room = (n: number) => Math.max(1, n - 2 * COMPACT.margin)
  const width = Math.min(COMPACT.width, room(area.width))
  const height = Math.min(clamp(Math.round(area.height * COMPACT.heightShare), COMPACT.minHeight, COMPACT.maxHeight), room(area.height))
  return { width, height }
}

/** The first place the compact window takes: the bottom right corner of the usable area, a little in from the edges. */
export function compactBounds(area: Rect): Rect {
  const { width, height } = compactSize(area)
  return { x: area.x + area.width - width - COMPACT.margin, y: area.y + area.height - height - COMPACT.margin, width, height }
}

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

/**
 * A remembered position, brought back onto a screen that is there now: the one it overlaps most (a monitor may have been unplugged),
 * no bigger than that screen, and wholly inside it. With no screen under it, the bottom right of the first one.
 */
export function fitOnScreen(saved: Rect, areas: Rect[]): Rect {
  const first = areas[0]
  if (!first) return saved
  let best = first
  let most = -1
  for (const a of areas) {
    const o = overlap(saved, a)
    if (o > most) {
      most = o
      best = a
    }
  }
  if (most <= 0) return compactBounds(first)
  const width = Math.min(saved.width, best.width)
  const height = Math.min(saved.height, best.height)
  return { width, height, x: clamp(saved.x, best.x, best.x + best.width - width), y: clamp(saved.y, best.y, best.y + best.height - height) }
}
