import { cn } from '@/lib/cn'

/*
 * The curved glow line from design/Inner chat design.jpeg, rebuilt from measurements.
 *
 * Measured on the 1261 x 668 picture: the arc is a true circle (0.83 px average error across 201 samples)
 * with center (1229.8, 540.9) and radius 475.5. It is anchored to the top-right corner of its container and
 * scales with the container's height, so it is exact at the reference size and proportional elsewhere.
 *
 * Layers, back to front: background lift, planet interior, wide cool haze (strong toward the lower-left),
 * near pink haze (strongest near the top), bloom, thin bright core, stars.
 * All colors come from tokens.css so the light theme can soften them.
 * `npm run glow:compare` renders this against the picture and reports the error.
 */

const W = 1261
const H = 668
const CX = 1229.8
const CY = 540.9
const R = 475.5
const PAD = 400

const X0 = 740
const X1 = 1261
const xo = (x: number) => ((x - X0) / (X1 - X0)).toFixed(4)

/** Positions along the arc where the color ramps are anchored (lower-left end to top-right end). */
const RAMP_X = [819, 894, 958, 1029, 1107, 1188, 1230]

/** Brightness of the line and its near haze along the arc: dim at both ends, strongest near the top. */
const NEAR_INTENSITY: [number, number][] = [
  [740, 0], [780, 0.12], [819, 0.3], [866, 0.44], [926, 0.62], [993, 0.79],
  [1067, 0.92], [1147, 1], [1188, 0.88], [1230, 0.76], [1261, 0.7]
]
/** The wide haze is strong at the lower-left and eases off toward the top. */
const WIDE_INTENSITY: [number, number][] = [
  [740, 0.35], [780, 0.7], [819, 0.95], [894, 1], [958, 1], [1029, 0.92], [1107, 0.85], [1188, 0.85], [1261, 0.85]
]

/** Falloff by distance in px from the circle (negative = inside). */
const NEAR: [number, number][] = [
  [-40, 0], [-22, 0.05], [-14, 0.14], [-8, 0.24], [-4, 0.32], [0, 0.38], [4, 0.38], [8, 0.36], [14, 0.3],
  [22, 0.2], [32, 0.11], [45, 0.05], [60, 0.015], [80, 0]
]
const WIDE: [number, number][] = [
  [-260, 0], [-150, 0.05], [-110, 0.08], [-80, 0.1], [-60, 0.12], [-45, 0.14], [-32, 0.15], [-22, 0.16],
  [0, 0.17], [14, 0.175], [32, 0.18], [45, 0.18], [60, 0.165], [80, 0.14], [110, 0.1], [150, 0.06],
  [200, 0.025], [260, 0.008], [330, 0]
]
const ALPHA_RADIUS = R + 330

const pt = (deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)]
}
const [ax, ay] = pt(204)
const [bx, by] = pt(279)
const ARC_PATH = `M${ax.toFixed(1)} ${ay.toFixed(1)} A${R} ${R} 0 0 1 ${bx.toFixed(1)} ${by.toFixed(1)}`

const STARS: [number, number, number][] = [
  [1091.5, 131.5, 1.3],
  [1123, 168, 1.2],
  [1045.5, 207, 1.4],
  [1178, 104, 0.9],
  [1004, 262, 0.9]
]

function Ramp({ prefix, opacityAtEnds }: { prefix: 'core' | 'haze' | 'wide'; opacityAtEnds?: boolean }) {
  return (
    <>
      {opacityAtEnds && <stop offset={xo(760)} stopColor={`var(--glow-${prefix}-1)`} stopOpacity={0} />}
      {RAMP_X.map((x, i) => (
        <stop
          key={x}
          offset={xo(x)}
          stopColor={`var(--glow-${prefix}-${i + 1})`}
          stopOpacity={opacityAtEnds && i === 0 ? 0.55 : 1}
        />
      ))}
    </>
  )
}

function AlphaRadial({ id, profile }: { id: string; profile: [number, number][] }) {
  return (
    <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={CX} cy={CY} r={ALPHA_RADIUS}>
      {profile.map(([d, a]) => (
        <stop key={d} offset={((R + d) / ALPHA_RADIUS).toFixed(4)} stopColor="#fff" stopOpacity={a} />
      ))}
    </radialGradient>
  )
}

function IntensityLinear({ id, stops }: { id: string; stops: [number, number][] }) {
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={X0} y1="0" x2={X1} y2="0">
      {stops.map(([x, a]) => (
        <stop key={x} offset={xo(x)} stopColor="#fff" stopOpacity={a} />
      ))}
    </linearGradient>
  )
}

const FULL = { x: -PAD, y: -PAD, width: W + PAD * 2, height: H + PAD * 2 }

function MaskRect({ id, fill }: { id: string; fill: string }) {
  return (
    <mask id={id} maskUnits="userSpaceOnUse" {...FULL}>
      <rect {...FULL} fill={fill} />
    </mask>
  )
}

/** A color ramp, shaped by a radial falloff, scaled by an intensity along the arc. */
function HazeLayer({ alpha, intensity, color, opacityVar }: { alpha: string; intensity: string; color: string; opacityVar: string }) {
  return (
    <g mask={`url(#${alpha}-mask)`} style={{ opacity: `var(${opacityVar})` }}>
      <g mask={`url(#${intensity}-mask)`}>
        <rect {...FULL} fill={`url(#${color})`} />
      </g>
    </g>
  )
}

export function GlowArc({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMaxYMin meet"
        className="absolute top-0 right-0 h-full"
        style={{ aspectRatio: `${W} / ${H}`, width: 'auto', overflow: 'visible' }}
      >
        <defs>
          <radialGradient id="glow-lift" gradientUnits="userSpaceOnUse" cx="1100" cy="110" r="950">
            <stop offset="0" stopColor="var(--glow-lift)" />
            <stop offset="1" stopColor="var(--glow-lift)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="glow-planet" gradientUnits="userSpaceOnUse" cx={CX} cy={CY} r={R}>
            <stop offset="0" stopColor="var(--glow-planet)" style={{ stopOpacity: 'var(--glow-planet-deep)' }} />
            <stop offset={((R - 170) / R).toFixed(3)} stopColor="var(--glow-planet)" style={{ stopOpacity: 'var(--glow-planet-deep)' }} />
            <stop offset="1" stopColor="var(--glow-planet)" stopOpacity="1" />
          </radialGradient>

          <AlphaRadial id="glow-near-alpha" profile={NEAR} />
          <AlphaRadial id="glow-wide-alpha" profile={WIDE} />
          <IntensityLinear id="glow-near-int" stops={NEAR_INTENSITY} />
          <IntensityLinear id="glow-wide-int" stops={WIDE_INTENSITY} />
          <MaskRect id="glow-near-alpha-mask" fill="url(#glow-near-alpha)" />
          <MaskRect id="glow-wide-alpha-mask" fill="url(#glow-wide-alpha)" />
          <MaskRect id="glow-near-int-mask" fill="url(#glow-near-int)" />
          <MaskRect id="glow-wide-int-mask" fill="url(#glow-wide-int)" />

          <linearGradient id="glow-near-color" gradientUnits="userSpaceOnUse" x1={X0} y1="0" x2={X1} y2="0">
            <Ramp prefix="haze" />
          </linearGradient>
          <linearGradient id="glow-wide-color" gradientUnits="userSpaceOnUse" x1={X0} y1="0" x2={X1} y2="0">
            <Ramp prefix="wide" />
          </linearGradient>
          <linearGradient id="glow-core-color" gradientUnits="userSpaceOnUse" x1={X0} y1="0" x2={X1} y2="0">
            <Ramp prefix="core" opacityAtEnds />
          </linearGradient>

          <filter id="glow-bloom" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <filter id="glow-soft" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="0.7" />
          </filter>
        </defs>

        <rect {...FULL} fill="url(#glow-lift)" style={{ opacity: 'var(--glow-lift-opacity)' }} />
        <circle cx={CX} cy={CY} r={R} fill="url(#glow-planet)" style={{ opacity: 'var(--glow-planet-opacity)' }} />

        <HazeLayer alpha="glow-wide-alpha" intensity="glow-wide-int" color="glow-wide-color" opacityVar="--glow-wide-opacity" />
        <HazeLayer alpha="glow-near-alpha" intensity="glow-near-int" color="glow-near-color" opacityVar="--glow-haze-opacity" />

        <g style={{ opacity: 'var(--glow-core-opacity)' }}>
          <path d={ARC_PATH} fill="none" stroke="url(#glow-core-color)" strokeWidth="16" opacity="0.5" filter="url(#glow-bloom)" />
          <path d={ARC_PATH} fill="none" stroke="url(#glow-core-color)" strokeWidth="2.1" strokeLinecap="round" filter="url(#glow-soft)" />
        </g>

        {STARS.map(([x, y, r]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="var(--glow-star)" style={{ opacity: 'var(--glow-star-opacity)' }} />
        ))}
      </svg>
    </div>
  )
}
