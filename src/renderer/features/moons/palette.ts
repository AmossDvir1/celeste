import type { MoonRole } from '@shared/moons'

/** The colors of the moons and of the sky they hang in, from the approved prototype, in both themes. */

/** hi, mid and lo are CSS colors; g is 'r,g,b' for building rgba() strings. */
export interface MoonColor {
  hi: string
  mid: string
  lo: string
  g: string
}

export type MoonTheme = 'dark' | 'light'

type Row = [hi: string, mid: string, lo: string, g: string]

/** The second of the same role takes the "2" color, so two moons of one role can still be told apart. */
const COL: Record<MoonTheme, Record<MoonRole, [Row, Row]>> = {
  dark: {
    planner: [['#d8f1ff', '#4fb6ff', '#1c4a86', '79,182,255'], ['#e0e6ff', '#7c8cff', '#303c96', '124,140,255']],
    builder: [['#ffd6e2', '#f5487f', '#7a2350', '245,72,127'], ['#ffe9c9', '#ff9f4a', '#8a4312', '255,159,74']],
    reviewer: [['#efe7ff', '#9b7bff', '#3d2f86', '155,123,255'], ['#ffe0f6', '#f06fd0', '#7c2a72', '240,111,208']],
    tester: [['#d4fff0', '#31d0aa', '#0f5f50', '49,208,170'], ['#eaffc9', '#9ad84f', '#3f6a12', '154,216,79']]
  },
  light: {
    planner: [['#dcefff', '#2f8fe6', '#1a5da8', '47,143,230'], ['#e6eaff', '#5f70ee', '#3442b0', '95,112,238']],
    builder: [['#ffe3ec', '#f5487f', '#b52c60', '245,72,127'], ['#fff0db', '#e8862c', '#a4550f', '232,134,44']],
    reviewer: [['#f3eeff', '#8565f2', '#5636c9', '122,92,240'], ['#ffe6f7', '#d24fb2', '#8f2a7c', '210,79,178']],
    tester: [['#d8fff2', '#17a884', '#0b6b56', '23,168,132'], ['#f2ffd9', '#6fae22', '#42700e', '111,174,34']]
  }
}

export function roleColor(role: MoonRole, second: boolean, theme: MoonTheme): MoonColor {
  const [hi, mid, lo, g] = COL[theme][role][second ? 1 : 0]
  return { hi, mid, lo, g }
}

/** The sky behind the moons. halo is how strong the glow around a moon is; star, orbit and eclipse are for the plain moon and the scenes. */
export interface SkyPalette {
  halo: number
  /** The dark side of a moon. */
  night: string
  rim: string
  /** 'r,g,b' */
  star: string
  /** 'r,g,b', the dots that travel between a moon and what it works on. */
  orbit: string
  /** The dark disc of a moon that waits for the person. */
  eclipse: string
}

const SKY: Record<MoonTheme, SkyPalette> = {
  dark: { halo: 0.5, night: '#171029', rim: 'rgba(255,255,255,.14)', star: '205,182,245', orbit: '174,184,209', eclipse: '#150d26' },
  light: { halo: 0.34, night: '#cfc4ea', rim: 'rgba(60,40,120,.2)', star: '143,111,208', orbit: '90,80,150', eclipse: '#3a2a62' }
}

export function skyPalette(theme: MoonTheme): SkyPalette {
  return SKY[theme]
}
