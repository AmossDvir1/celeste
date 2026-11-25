import type { Seat } from '@shared/moons'
import type { Characters } from './characters'
import { TAU, clamp, ease, lerp, phaseOf, seg } from './motion'
import type { MoonColor, MoonTheme } from './palette'
import { skyPalette } from './palette'
import { drawFlow, drawPlainMoon } from './plain'
import type { SkyView } from './sky-model'
import type { DrawMoon, MoonState } from './types'

/*
 * Drawing the sky on its canvas, ported from drawSky of the approved prototype: the stars and the horizon glow, the orbit that turns so that the lit
 * moon is in front, the beam and the light that flows between a moon and its scene, the light that crosses on a hand-over, the talk layout (the two face
 * each other), the layout of both together, and of two at once. Redraws only: the state that eases lives in `SkyDraw`, the rest comes in with each frame.
 */

export interface SkyDraw {
  /** The orbit's angle and where it is going. Each hand-over to the other moon turns it half a turn, so the lit one is in front. */
  ang: number
  want: number
  wantSeat: Seat
  rise: number
  cx: number
  rx: number
  conj: number
  /** How much of each moon is lit, and how bright it is. */
  p: [number, number]
  lit: [number, number]
}

export const newSkyDraw = (): SkyDraw => ({ ang: 0, want: 0, wantSeat: 0, rise: 0, cx: 140, rx: 86, conj: 0, p: [0.13, 0.13], lit: [0.2, 0.2] })

export interface Rect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface Frame {
  c: CanvasRenderingContext2D
  W: number
  H: number
  /** Seconds, for the motion. */
  t: number
  /** Seconds since the last frame. */
  dt: number
  view: SkyView
  /** The sky is up (or opening); false while it closes. */
  up: boolean
  talk: { on: boolean; speaker: 0 | 1 | null; typing: 0 | 1 | null }
  cols: [MoonColor, MoonColor]
  theme: MoonTheme
  calm: boolean
  chars: Characters | null
  /** The scenes' cards, relative to the sky, as they are now (they slide). Null where there is none. */
  rects: [Rect | null, Rect | null]
  /** A hand-over seen while the sky was shown: the seats and the seconds since it began. Null when none is crossing. */
  hand: { from: Seat; to: Seat; age: number } | null
  /** What both found, for the comparison. */
  both: number
}

const FONT = "'Outfit Variable', Outfit, 'Segoe UI', sans-serif"
const STARS = Array.from({ length: 46 }, (_, i): [number, number, number, number] => [Math.sin(i * 91.7) * 0.5 + 0.5, Math.sin(i * 47.3 + 2) * 0.5 + 0.5, 0.5 + (i % 4) * 0.28, i])
const BEAMING: MoonState[] = ['read', 'edit', 'lens', 'run', 'think']

/** Where two moons overlap: what both have. */
function shared(c: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, r: number, al: number, cols: [MoonColor, MoonColor]) {
  c.save()
  for (const q of [a, b]) {
    c.beginPath()
    c.arc(q.x, q.y, r, 0, TAU)
    c.clip()
  }
  c.globalAlpha = al
  const g = c.createLinearGradient(a.x, 0, b.x, 0)
  g.addColorStop(0, cols[0].mid)
  g.addColorStop(1, cols[1].mid)
  c.fillStyle = g
  c.fillRect(Math.min(a.x, b.x) - r, a.y - r, r * 4, r * 2)
  c.restore()
  c.save()
  c.globalAlpha = al
  c.strokeStyle = 'rgba(255,255,255,.85)'
  c.lineWidth = 1.3
  for (const [p, q] of [[a, b], [b, a]] as const) {
    const d = Math.hypot(q.x - p.x, q.y - p.y) / 2
    const w = Math.acos(clamp(d / r, -1, 1))
    const m = q.x > p.x ? 0 : Math.PI
    c.beginPath()
    c.arc(p.x, p.y, r, m - w, m + w)
    c.stroke()
  }
  c.restore()
}

export function drawSky(S: SkyDraw, f: Frame): void {
  const { c, W, H, t, dt, view, calm, theme, chars, cols } = f
  const pal = skyPalette(theme)
  const phone = W < 640
  const ch = !!chars
  const two = view.mode === 'two'
  const both = view.mode === 'both'
  const pair = two || both
  const tk = f.talk.on
  const k = 1 - Math.exp(-dt * (calm ? 40 : 4.2))

  // The orbit turns so that the lit one is in front: half a turn each time the light goes to the other moon.
  const litSeat: Seat = view.lit === 'both' ? S.wantSeat : view.lit
  if (!pair && !tk && litSeat !== S.wantSeat) {
    S.want += Math.PI
    S.wantSeat = litSeat
  }
  if (Math.abs(S.ang - S.want) > 3 * Math.PI) S.ang = S.want
  S.ang += (S.want - S.ang) * (1 - Math.exp(-dt * (calm ? 40 : 3)))
  S.rise += ((f.up ? 1 : 0) - S.rise) * k
  S.cx += ((phone || two ? W / 2 : ch ? 140 : 128) - S.cx) * k
  S.conj += ((view.conj ? 1 : 0) - S.conj) * (1 - Math.exp(-dt * (calm ? 40 : 2.2)))
  const rxTarget = two ? (ch ? lerp(64, 52, S.conj) : lerp(58, 25, S.conj)) : ch ? (both ? 56 : 86) : 74
  S.rx += (rxTarget - S.rx) * (two ? 1 : k)
  const cy0 = ch ? (phone ? 84 : 112) : phone ? 54 : 92
  const cy = cy0 + (1 - S.rise) * 210
  const ry = two ? 3 : phone ? 15 : ch ? 30 : 26

  // The sky: stars, and the glow of the horizon in both colors.
  for (const s of STARS) {
    const tw = calm ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.8 + s[3] * 2.1)
    c.beginPath()
    c.arc(s[0] * W, s[1] * H * 0.86, s[2], 0, TAU)
    c.fillStyle = `rgba(${pal.star},${0.1 + 0.3 * tw})`
    c.fill()
  }
  const hz = c.createRadialGradient(W / 2, H + 120, 40, W / 2, H + 120, W * 0.62)
  hz.addColorStop(0, `rgba(${cols[0].g},.2)`)
  hz.addColorStop(0.55, `rgba(${cols[1].g},.09)`)
  hz.addColorStop(1, `rgba(${cols[1].g},0)`)
  c.fillStyle = hz
  c.fillRect(0, 0, W, H)

  // The states: in the talk layout one speaks and the other listens.
  const st: MoonState[] = [0, 1].map((n) => (tk ? (f.talk.speaker === n || f.talk.typing === n ? 'talk' : 'listen') : f.view.seats[n as Seat].state))
  for (const n of [0, 1]) {
    const s = st[n]!
    const target = phaseOf(s === 'idle' && !ch ? 'done' : s, t + n, calm)
    const L = s === 'listen' ? 0.42 : s === 'rest' ? 0.16 : s === 'done' ? 0.8 : s === 'idle' ? 0.6 : 1
    S.p[n] = (S.p[n] as number) + (target - (S.p[n] as number)) * k
    S.lit[n] = (S.lit[n] as number) + (L - (S.lit[n] as number)) * k
  }

  const drift = calm || two ? 0 : Math.sin(t * 0.5) * 0.1
  const base = Math.PI * 0.32
  const pos = [0, 1].map((n) => {
    if (tk) return { x: n ? W - (phone ? 56 : 92) : phone ? 56 : 92, y: (phone ? H - 78 : cy + 34) + (1 - S.rise) * 60, z: 0, n }
    const th = base + S.ang + n * Math.PI + drift
    if (pair) return { x: S.cx + (n ? 1 : -1) * S.rx, y: cy, z: 0, n }
    return { x: S.cx + S.rx * Math.cos(th), y: cy + ry * Math.sin(th) * 1.15, z: Math.sin(th), n }
  })

  if (!pair && !tk) {
    c.lineWidth = 1
    c.strokeStyle = `rgba(${pal.orbit},.2)`
    c.beginPath()
    c.ellipse(S.cx, cy, S.rx, ry * 1.15, 0, 0, TAU)
    c.stroke()
  }

  // Beams and flow: light comes in when a moon reads and goes out when it writes or runs something.
  const beam = (n: number, r: Rect | null) => {
    const state = st[n]!
    if (tk || !r || !BEAMING.includes(state) || !view.scenes[two ? n : 0]) return
    const o = pos[n]!
    const g = cols[n]!.g
    let pts: [number, number][]
    let tx: number
    let ty: number
    if (phone) {
      const m = (r.left + r.right) / 2
      pts = [[lerp(r.left, r.right, 0.18), r.top], [lerp(r.left, r.right, 0.82), r.top]]
      tx = m
      ty = r.top
    } else {
      const X = o.x < r.left ? r.left : r.right
      pts = [[X, r.top + 16], [X, r.bottom - 16]]
      tx = X
      ty = (r.top + r.bottom) / 2
    }
    const gr = c.createLinearGradient(o.x, o.y, tx, ty)
    gr.addColorStop(0, `rgba(${g},.34)`)
    gr.addColorStop(1, `rgba(${g},.04)`)
    c.fillStyle = gr
    c.beginPath()
    c.moveTo(o.x, o.y)
    c.lineTo(pts[0]![0], pts[0]![1])
    c.lineTo(pts[1]![0], pts[1]![1])
    c.closePath()
    c.fill()
    if (state !== 'think') drawFlow(c, o.x, o.y, tx, ty, state === 'edit' || state === 'run' ? 1 : -1, t, g, calm)
  }
  if (two) {
    beam(0, f.rects[0])
    beam(1, f.rects[1])
  } else if (view.lit !== 'both') beam(view.lit, f.rects[0])

  const R0 = ch ? (phone ? 27 : 35) : phone ? 23 : 30
  const crossing = f.hand && !calm ? f.hand : null
  const moon = (o: { x: number; y: number; z: number; n: number }) => {
    const n = o.n as Seat
    const sc = tk ? 1.08 : two ? (ch ? lerp(0.86, 0.94, S.conj) : lerp(0.86, 1.3, S.conj)) : pair ? 0.95 : 1 + o.z * 0.26
    let s: MoonState = st[n]!
    // The one that hands over lifts the light for a moment, as in the prototype; the plain moon has no such pose.
    if (crossing && ch && n === crossing.from && crossing.age < 0.5 && !tk) s = 'hand'
    if (!ch && s === 'agree') s = 'done'
    let flip = false
    if (tk) flip = n === 1
    else if (pair && two && !view.conj) flip = n === 0
    else if (pair) flip = n === 1
    const dm: DrawMoon = {
      x: o.x,
      y: o.y,
      r: R0 * sc,
      role: view.seats[n].role,
      color: cols[n],
      state: s,
      phase: S.p[n] as number,
      lit: S.lit[n] as number,
      t,
      dt: Math.max(dt, 1 / 120),
      look: s === 'rest' ? 0 : 1,
      flip,
      key: `sky${n}`,
      calm,
      theme,
      seed: n * 1.7
    }
    if (chars) chars.draw(c, dm)
    else drawPlainMoon(c, dm)
  }
  const ord = [...pos].sort((a, d) => a.z - d.z)
  moon(ord[0]!)

  // The light crossing over on a hand-over.
  if (crossing && !tk) {
    const f0 = pos[crossing.from]!
    const g0 = pos[crossing.to]!
    const a = ch ? { x: f0.x, y: f0.y - R0 * (1 + f0.z * 0.26) * 1.5 } : f0
    const b = ch ? { x: g0.x, y: g0.y - R0 * 0.6 } : g0
    const q = ease(seg(crossing.age, 0.25, 1.35))
    if (q > 0 && q < 1) {
      const at = (u: number): [number, number] => {
        const mx = (a.x + b.x) / 2
        const my = Math.min(a.y, b.y) - 62
        return [(1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * mx + u * u * b.x, (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * my + u * u * b.y]
      }
      for (let j = 22; j >= 0; j--) {
        const u = clamp(q - j * 0.016)
        const [x, y] = at(u)
        c.beginPath()
        c.arc(x, y, Math.max(0.6, 5 - j * 0.2), 0, TAU)
        c.fillStyle = `rgba(${cols[q > 0.5 ? crossing.to : crossing.from].g},${(1 - j / 23) * 0.5})`
        c.fill()
      }
      const [x, y] = at(q)
      c.beginPath()
      c.arc(x, y, 4, 0, TAU)
      c.fillStyle = '#fff'
      c.fill()
    }
  }
  moon(ord[1]!)

  // Two reviews compared: what both found glows between them.
  if (two && ch && S.conj > 0.4) {
    const q = seg(S.conj, 0.5, 0.95)
    const y = cy - R0 * 1.15
    const gl = c.createRadialGradient(S.cx, y, 4, S.cx, y, 62)
    gl.addColorStop(0, `rgba(255,255,255,${0.55 * q})`)
    gl.addColorStop(0.4, `rgba(${cols[0].g},${0.35 * q})`)
    gl.addColorStop(1, `rgba(${cols[0].g},0)`)
    c.fillStyle = gl
    c.beginPath()
    c.arc(S.cx, y, 62, 0, TAU)
    c.fill()
    c.globalAlpha = q
    c.fillStyle = '#fff'
    c.beginPath()
    c.arc(S.cx, y, 30, 0, TAU)
    c.fill()
    c.fillStyle = '#23143f'
    c.textAlign = 'center'
    c.font = `600 22px ${FONT}`
    c.fillText(String(f.both), S.cx, y + 3)
    c.font = `500 10px ${FONT}`
    c.fillText('both found', S.cx, y + 15)
    c.globalAlpha = 1
  }
  if (two && !ch && S.conj > 0.5) {
    shared(c, pos[0]!, pos[1]!, R0 * lerp(0.86, 1.3, S.conj), seg(S.conj, 0.5, 0.9), cols)
    c.globalAlpha = seg(S.conj, 0.6, 0.95)
    c.fillStyle = '#fff'
    c.textAlign = 'center'
    c.font = `500 25px ${FONT}`
    c.shadowColor = 'rgba(0,0,0,.55)'
    c.shadowBlur = 8
    c.fillText(String(f.both), S.cx, cy + 5)
    c.font = `400 11.5px ${FONT}`
    c.fillText('both found', S.cx, cy + 20)
    c.shadowBlur = 0
    c.globalAlpha = 1
  }
}
