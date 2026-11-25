import type { MoonState } from './types'

/** Small pure helpers for the moons' motion, kept apart from any canvas so they can be tested and shared. */

export const TAU = Math.PI * 2

export const clamp = (x: number, a = 0, b = 1): number => Math.min(b, Math.max(a, x))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
/** Slow at both ends. */
export const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
/** Fast first, then settles. */
export const out = (t: number): number => 1 - Math.pow(1 - t, 3)
/** Where p is between a and b, as 0 to 1. */
export const seg = (p: number, a: number, b: number): number => clamp((p - a) / (b - a))

/** How much of the moon is lit for a state, 0 to 1. Calm motion takes away the wobble but keeps the level, because the level tells the state. */
export function phaseOf(state: MoonState, t: number, calm: boolean): number {
  const live = calm ? 0 : 1
  switch (state) {
    case 'rest': return 0.13
    case 'talk': return 0.94
    case 'listen': return 0.6
    case 'idle': return 0.8
    case 'think': return 0.42 + live * 0.13 * Math.sin(t * 1.3)
    case 'read': return 0.55 + live * 0.2 * Math.sin(t * 2)
    case 'edit': return 0.93
    case 'run': return 0.8
    case 'lens': return 0.82
    case 'found': return 1
    case 'hand': return 0.6
    case 'wait': return 0.5
    case 'done': return 1
    case 'agree': return 1
    default: return 0.13
  }
}
