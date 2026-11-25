import { TAU, clamp, lerp } from './motion'
import type { MoonColor } from './palette'
import { skyPalette } from './palette'
import type { DrawMoon } from './types'

/*
 * The plain moons, drawn on a 2D canvas with no WebGL: a lit disc with a phase, and a mark for the role
 * (bands for the builder, a ring for the reviewer, joined dots for the planner, arcs for the tester).
 * They are the fallback when the characters cannot be made, and they are what the characters fall back to if the GPU fails.
 */

/** The lit part of the moon, from the phase: a half disc and an ellipse that grows or shrinks it, drawn three times so the edge is soft. */
function moonLit(c: CanvasRenderingContext2D, r: number, phase: number, col: MoonColor) {
  const g = c.createRadialGradient(r * 0.42, -r * 0.28, r * 0.05, r * 0.1, 0, r * 1.15)
  g.addColorStop(0, col.hi)
  g.addColorStop(0.5, col.mid)
  g.addColorStop(1, col.lo)
  c.fillStyle = g
  for (const j of [-0.05, 0, 0.05]) {
    const ph = clamp(phase + j, 0.02, 1)
    const k = 1 - 2 * ph
    c.globalAlpha = j ? 0.38 : 0.9
    c.beginPath()
    c.arc(0, 0, r, -Math.PI / 2, Math.PI / 2)
    c.ellipse(0, 0, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, k > 0)
    c.fill()
  }
  c.globalAlpha = 1
}

/** One half of the reviewer's ring: the back half is fainter, so the moon seems to sit inside it. */
function ringHalf(c: CanvasRenderingContext2D, r: number, front: boolean, col: MoonColor, a: number, spin: number) {
  c.save()
  c.rotate(-0.32 + spin)
  c.beginPath()
  c.ellipse(0, 0, r * 1.62, r * 0.46, 0, front ? 0 : Math.PI, front ? Math.PI : TAU)
  c.strokeStyle = col.mid
  c.globalAlpha = a * (front ? 1 : 0.5)
  c.lineWidth = Math.max(1.2, r * 0.085)
  c.stroke()
  c.globalAlpha = a * 0.5
  c.strokeStyle = col.hi
  c.lineWidth = Math.max(0.7, r * 0.03)
  c.stroke()
  c.restore()
}

/** The states that have no picture of their own (talk, listen, idle, agree and the rest) are drawn as a lit moon. */
export function drawPlainMoon(c: CanvasRenderingContext2D, o: DrawMoon) {
  const pal = skyPalette(o.theme)
  const col = o.color
  const { r, t, role } = o
  const st = o.state
  const live = o.calm ? 0 : 1
  c.save()
  c.translate(o.x, o.y)
  // halo
  const hr = r * (st === 'wait' ? 2.5 : 2.3 + live * 0.12 * Math.sin(t * 1.7))
  const h = c.createRadialGradient(0, 0, r * 0.7, 0, 0, hr)
  h.addColorStop(0, `rgba(${col.g},${pal.halo * o.lit})`)
  h.addColorStop(1, `rgba(${col.g},0)`)
  c.fillStyle = h
  c.beginPath()
  c.arc(0, 0, hr, 0, TAU)
  c.fill()
  // pulses: a command is running, or something was found
  if (st === 'run' || st === 'found') {
    for (let i = 0; i < 3; i++) {
      const q = o.calm ? (i + 1) / 3.4 : (t * (st === 'found' ? 1.1 : 0.55) + i / 3) % 1
      c.beginPath()
      c.arc(0, 0, r * (1.12 + q * (st === 'found' ? 1.5 : 1.15)), 0, TAU)
      c.strokeStyle = `rgba(${col.g},${0.6 * (1 - q) * o.lit})`
      c.lineWidth = st === 'found' ? 2 : 1.3
      c.stroke()
    }
  }
  const spin = st === 'lens' && live ? Math.sin(t * 1.4) * 0.22 : 0
  const ringAlpha = 0.35 + 0.65 * o.lit
  if (role === 'reviewer') ringHalf(c, r, false, col, ringAlpha, spin)
  // body
  c.beginPath()
  c.arc(0, 0, r, 0, TAU)
  c.fillStyle = pal.night
  c.fill()
  if (st === 'wait') {
    // eclipse: a dark disc with a ring of light, for a moon that waits for the person
    c.fillStyle = pal.eclipse
    c.fill()
    const q = 0.5 + 0.5 * Math.sin(t * 2.1) * live
    for (let i = 4; i > 0; i--) {
      c.beginPath()
      c.arc(0, 0, r + i * 0.4, 0, TAU)
      c.strokeStyle = `rgba(${col.g},${0.16 + 0.1 * q})`
      c.lineWidth = i * 3.4
      c.stroke()
    }
    c.beginPath()
    c.arc(0, 0, r, 0, TAU)
    c.strokeStyle = col.hi
    c.lineWidth = 1.8
    c.stroke()
    const a = -0.8
    const gx = Math.cos(a) * r
    const gy = Math.sin(a) * r
    const d = c.createRadialGradient(gx, gy, 0, gx, gy, r * 0.62)
    d.addColorStop(0, '#fff')
    d.addColorStop(0.25, `rgba(${col.g},.9)`)
    d.addColorStop(1, `rgba(${col.g},0)`)
    c.fillStyle = d
    c.beginPath()
    c.arc(gx, gy, r * 0.62, 0, TAU)
    c.fill()
  } else {
    c.save()
    c.beginPath()
    c.arc(0, 0, r, 0, TAU)
    c.clip()
    c.save()
    c.rotate(-0.12)
    moonLit(c, r, o.phase, col)
    c.restore()
    c.globalAlpha = 0.2
    if (role === 'builder') {
      for (let i = -2; i <= 2; i++) {
        c.beginPath()
        c.ellipse(0, i * r * 0.4 + r * 0.06, r * 1.1, r * 0.12, 0, 0, Math.PI)
        c.strokeStyle = '#fff'
        c.lineWidth = r * 0.06
        c.stroke()
      }
    } else {
      c.fillStyle = '#000'
      for (const [a, b, s] of [[0.3, -0.36, 0.17], [0.52, 0.2, 0.1], [0.06, 0.3, 0.13]] as const) {
        c.beginPath()
        c.arc(a * r, b * r, s * r, 0, TAU)
        c.globalAlpha = 0.13
        c.fill()
      }
    }
    c.restore()
    c.beginPath()
    c.arc(0, 0, r, 0, TAU)
    c.strokeStyle = pal.rim
    c.lineWidth = 1
    c.stroke()
  }
  if (role === 'reviewer') ringHalf(c, r, true, col, ringAlpha, spin)
  if (role === 'planner') {
    // three dots, joined by lines, that turn slowly around the moon
    const pts = [0, 1, 2].map((i): [number, number] => {
      const a = i * 2.1 + live * t * 0.35
      return [Math.cos(a) * r * 1.55, Math.sin(a) * r * 1.2]
    })
    c.strokeStyle = `rgba(${col.g},.55)`
    c.lineWidth = 1
    c.beginPath()
    pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])))
    c.stroke()
    c.fillStyle = col.hi
    for (const p of pts) {
      c.beginPath()
      c.arc(p[0], p[1], Math.max(1.8, r * 0.09), 0, TAU)
      c.fill()
    }
  }
  if (role === 'tester') {
    // two pairs of arcs on both sides, like brackets around what is being tried
    for (const s of [-1, 1]) {
      for (const k of [1.32, 1.58]) {
        c.beginPath()
        c.arc(0, 0, r * k, (s < 0 ? Math.PI : 0) - 0.5, (s < 0 ? Math.PI : 0) + 0.5)
        c.strokeStyle = `rgba(${col.g},${k > 1.5 ? 0.4 : 0.8})`
        c.lineWidth = Math.max(1.3, r * 0.07)
        c.stroke()
      }
    }
  }
  // thinking: specks wander and join
  if (st === 'think') {
    const n = 5
    const ps: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const a = i * 1.256 + live * t * 0.5
      const rr = r * (1.5 + 0.22 * Math.sin(t * live * 1.3 + i * 2))
      ps.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.8])
    }
    c.strokeStyle = `rgba(${col.g},.35)`
    c.lineWidth = 1
    for (let i = 0; i < n; i++) {
      const q = o.calm ? 1 : clamp(Math.sin(t * 1.2 + i * 1.9))
      c.globalAlpha = q
      const a = ps[i] as [number, number]
      const b = ps[(i + 1) % n] as [number, number]
      c.beginPath()
      c.moveTo(a[0], a[1])
      c.lineTo(b[0], b[1])
      c.stroke()
    }
    c.globalAlpha = 1
    c.fillStyle = col.hi
    for (const p of ps) {
      c.beginPath()
      c.arc(p[0], p[1], 1.7, 0, TAU)
      c.fill()
    }
  }
  c.restore()
}

/** Light between a moon and what it works on. dir 1: out (writing), -1: in (reading). g is the moon's 'r,g,b'. */
export function drawFlow(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, dir: 1 | -1, t: number, g: string, calm: boolean, n = 9) {
  for (let i = 0; i < n; i++) {
    let q = calm ? (i + 0.5) / n : (t * 0.62 + i / n) % 1
    if (dir < 0) q = 1 - q
    const w = Math.sin(i * 12.9) * 7 * Math.sin(q * Math.PI)
    const x = lerp(x0, x1, q)
    const y = lerp(y0, y1, q) + w
    c.beginPath()
    c.arc(x, y, 1.2 + 1.3 * Math.sin(q * Math.PI), 0, TAU)
    c.fillStyle = `rgba(${g},${0.85 * Math.sin(q * Math.PI)})`
    c.fill()
  }
}
