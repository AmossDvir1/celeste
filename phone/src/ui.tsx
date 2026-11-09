import type { CSSProperties, ReactNode } from 'react'
import logoUrl from '@/assets/logo/celeste-mark.svg'

export const LOGO = logoUrl

export function Logo({ className, style }: { className?: string; style?: CSSProperties }) {
  return <img src={logoUrl} alt="" className={className} style={style} />
}

/** Gradients and blurs for the glow arc, defined once for the whole app. */
export function GlowDefs() {
  const stop = (offset: string, color: string, opacity?: number) => <stop offset={offset} style={{ stopColor: `var(${color})`, ...(opacity !== undefined ? { stopOpacity: opacity } : {}) }} />
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="g-core" gradientUnits="userSpaceOnUse" x1="110" y1="440" x2="460" y2="30">
          {stop('0', '--glow-core-1', 0)}
          {stop('.14', '--glow-core-2', 0.6)}
          {stop('.32', '--glow-core-3')}
          {stop('.5', '--glow-core-4')}
          {stop('.68', '--glow-core-5')}
          {stop('.84', '--glow-core-6')}
          {stop('1', '--glow-core-7')}
        </linearGradient>
        <linearGradient id="g-near" gradientUnits="userSpaceOnUse" x1="110" y1="440" x2="460" y2="30">
          {stop('0', '--glow-haze-1', 0)}
          {stop('.2', '--glow-haze-2', 0.5)}
          {stop('.45', '--glow-haze-3')}
          {stop('.65', '--glow-haze-4')}
          {stop('.85', '--glow-haze-6')}
          {stop('1', '--glow-haze-7', 0.8)}
        </linearGradient>
        <linearGradient id="g-wide" gradientUnits="userSpaceOnUse" x1="110" y1="440" x2="460" y2="30">
          {stop('0', '--glow-wide-1', 0.5)}
          {stop('.3', '--glow-wide-2')}
          {stop('.6', '--glow-wide-3')}
          {stop('.85', '--glow-wide-4')}
          {stop('1', '--glow-wide-5')}
        </linearGradient>
        <radialGradient id="g-lift" cx="330" cy="40" r="300" gradientUnits="userSpaceOnUse">
          {stop('0', '--glow-lift')}
          {stop('1', '--glow-lift', 0)}
        </radialGradient>
        <filter id="f-wide" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <filter id="f-near" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
        <filter id="f-bloom" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
    </svg>
  )
}

const ARC = 'M111 445 A330 330 0 0 1 459 31'
const STARS: [number, number, number, number][] = [
  [262, 76, 1.4, 0],
  [304, 128, 1.1, 1.1],
  [222, 150, 1.3, 2],
  [336, 58, 1, 0.6],
  [190, 98, 1, 1.7],
  [282, 190, 0.9, 2.6]
]

/** The desktop's glow arc, small: the edge of a planet from the lower left to the top right. */
export function Arc({ soft }: { soft?: boolean }) {
  return (
    <svg className={`arc${soft ? ' soft' : ''}`} viewBox="0 0 360 430" preserveAspectRatio="xMaxYMin slice" aria-hidden="true">
      <rect width="360" height="430" fill="url(#g-lift)" style={{ opacity: 'var(--glow-lift-opacity)' }} />
      <circle cx="430" cy="360" r="330" style={{ fill: 'var(--glow-planet)', opacity: 'var(--glow-planet-opacity)' }} />
      <path className="wide" d={ARC} fill="none" stroke="url(#g-wide)" strokeWidth="80" filter="url(#f-wide)" />
      <path className="near" d={ARC} fill="none" stroke="url(#g-near)" strokeWidth="22" filter="url(#f-near)" />
      <g className="core">
        <path d={ARC} fill="none" stroke="url(#g-core)" strokeWidth="9" opacity=".5" filter="url(#f-bloom)" />
        <path d={ARC} fill="none" stroke="url(#g-core)" strokeWidth="1.8" strokeLinecap="round" />
      </g>
      <path className="comet" d={ARC} fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" filter="url(#f-bloom)" />
      {STARS.map(([x, y, r, d]) => (
        <circle key={`${x}-${y}`} className="star" cx={x} cy={y} r={r} style={{ animationDelay: `${d}s` }} />
      ))}
    </svg>
  )
}

/** Staggered entrance: the n-th thing on a screen arrives a moment after the one before. */
export const rise = (i: number): { 'data-rise': boolean; style: CSSProperties } => ({ 'data-rise': true, style: { ['--i' as string]: i } as CSSProperties })

export function Shimmer({ children }: { children: ReactNode }) {
  return <span className="shimmer">{children}</span>
}

export function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function when(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function buzz(ms = 8): void {
  try {
    if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) navigator.vibrate?.(ms)
  } catch {
    // No vibration here.
  }
}
