import type { MoonRole } from '@shared/moons'
import type { MoonColor } from './palette'

/** What a moon is doing. Each one is driven by something the agent really did. */
export type MoonState = 'rest' | 'idle' | 'think' | 'read' | 'edit' | 'run' | 'lens' | 'found' | 'hand' | 'wait' | 'done' | 'agree' | 'talk' | 'listen'

/** Everything needed to draw one moon, as plain data so the plain moon and the character take the same thing. */
export interface DrawMoon {
  /** Centre and radius of the moon, in canvas pixels. */
  x: number
  y: number
  r: number
  role: MoonRole
  color: MoonColor
  state: MoonState
  /** How much of the moon is lit, 0 to 1 (see `phaseOf`). */
  phase: number
  /** How bright it is, 0 to 1: a resting moon is dim. */
  lit: number
  /** Seconds since the sky was shown, for the motion. */
  t: number
  /** Seconds since the last frame, for easing from pose to pose. */
  dt: number
  /** Which way it looks, -1 to 1 (0 straight ahead, 1 toward the other moon). */
  look: number
  /** Mirror it, for the moon on the right. */
  flip?: boolean
  /** Identifies this moon between frames: each one eases from its last pose. */
  key: string
  /** Calm motion: no drift, no particles; the poses still change. */
  calm: boolean
  theme: 'dark' | 'light'
  /** Shifts the blinking so two moons do not blink together. */
  seed?: number
}
