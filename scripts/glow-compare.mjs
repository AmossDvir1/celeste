// Renders the Chat home at the picture's size and compares the glow arc with design/Inner chat design.jpeg.
// The picture is a JPEG with its own grain, so "exact" is not measurable: the targets are what a visual check
// of the side-by-side image confirms as indistinguishable (arc within ~1 px, colors within ~5/255).
// Run: npm run glow:compare   (builds first). Writes scripts/.output/glow-side.png for a visual check.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import { launch, root } from './lib/app.mjs'

const W = 1261
const H = 668
// The circle measured from the picture (see src/renderer/glow/GlowArc.tsx).
const CX = 1229.8
const CY = 540.9
const R = 475.5

const outDir = resolve(root, 'scripts/.output')
mkdirSync(outDir, { recursive: true })

const ref = jpeg.decode(readFileSync(resolve(root, 'design/Inner chat design.jpeg')), { useTArray: true })
if (ref.width !== W || ref.height !== H) throw new Error(`reference is ${ref.width}x${ref.height}`)

const { page, close } = await launch({ width: W, height: H, query: 'bare=chat', theme: 'dark' })
const shot = PNG.sync.read(await page.screenshot())
await close()
if (shot.width !== W || shot.height !== H) throw new Error(`screenshot is ${shot.width}x${shot.height}`)

const px = (img, x, y) => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}
const mean3 = (img, x, y) => {
  const acc = [0, 0, 0]
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) px(img, x + dx, y + dy).forEach((v, k) => (acc[k] += v / 9))
  return acc
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
const at = (deg, d) => {
  const a = (deg * Math.PI) / 180
  return [CX + (R + d) * Math.cos(a), CY + (R + d) * Math.sin(a)]
}

// 1. Arc position: the luminance-weighted center of the line at each angle, in both images.
// (A plain "brightest pixel" is noisy where the line is dim, so this weights the whole profile.)
const centerOffset = (img, deg) => {
  const prof = []
  for (let d = -14; d <= 14; d++) {
    const [x, y] = at(deg, d)
    prof.push([d, lum(mean3(img, x, y))])
  }
  const base = Math.min(...prof.map((p) => p[1]))
  let sw = 0
  let sd = 0
  for (const [d, l] of prof) {
    const w = Math.max(0, l - base)
    sw += w
    sd += w * d
  }
  return sd / sw
}
const dys = []
const posRows = []
for (let deg = 220; deg <= 270; deg += 5) {
  const a = centerOffset(ref, deg)
  const b = centerOffset(shot, deg)
  dys.push(Math.abs(a - b))
  posRows.push(`${deg}: picture ${a.toFixed(1)}  ours ${b.toFixed(1)}`)
}
const posErr = dys.reduce((s, v) => s + v, 0) / dys.length
console.log('\nLine center offset from the measured circle (px)')
console.log('  ' + posRows.join('\n  '))

// 2. Core color and brightness along the arc.
console.log('\nCore along the arc (peak within 8 px of the circle)')
console.log('angle  picture  ours     diff(R,G,B)')
let coreErr = 0
let coreN = 0
for (let deg = 210; deg <= 270; deg += 5) {
  const pick = (img) => {
    let best = null
    for (let d = -8; d <= 8; d++) {
      const [x, y] = at(deg, d)
      const c = mean3(img, x, y)
      if (!best || lum(c) > lum(best)) best = c
    }
    return best
  }
  const a = pick(ref)
  const b = pick(shot)
  const diff = a.map((v, k) => b[k] - v)
  coreErr += diff.reduce((s, v) => s + Math.abs(v), 0) / 3
  coreN++
  console.log(`${String(deg).padStart(4)}   ${hex(a)}  ${hex(b)}  ${diff.map((v) => (v >= 0 ? '+' : '') + Math.round(v)).join(',')}`)
}

// 3. Radial falloff (average over angle bands).
const OFFS = [-150, -80, -45, -22, -8, 0, 8, 22, 45, 80, 150, 260]
let radErr = 0
let radN = 0
console.log('\nRadial falloff, 244-256 degrees (offset from the circle: picture | ours)')
for (const [a0, a1] of [[222, 232], [244, 256], [258, 268]]) {
  for (const d of OFFS) {
    const acc = (img) => {
      const s = [0, 0, 0]
      let n = 0
      for (let deg = a0; deg <= a1; deg++) {
        const [x, y] = at(deg, d)
        if (x < 3 || y < 3 || x > W - 4 || y > H - 4) continue
        mean3(img, x, y).forEach((v, k) => (s[k] += v))
        n++
      }
      return n === 0 ? null : s.map((v) => v / n)
    }
    const a = acc(ref)
    const b = acc(shot)
    if (!a || !b) continue
    radErr += a.reduce((s, v, k) => s + Math.abs(b[k] - v), 0) / 3
    radN++
    if (a0 === 244) console.log(`${String(d).padStart(5)}  ${hex(a)} | ${hex(b)}`)
  }
}

// Probe points away from the line (picture | ours), to find where the haze and lift differ.
if (process.argv.includes('--probes')) {
  console.log('\nProbes (x,y): picture | ours')
  for (const [x, y] of [[780, 20], [900, 40], [1000, 15], [1100, 10], [1230, 12], [800, 140], [880, 120], [950, 200], [1060, 250], [1180, 300], [1240, 200], [1000, 330], [1150, 340], [850, 330], [1240, 340]]) {
    console.log(`  (${x},${y})  ${hex(mean3(ref, x, y))} | ${hex(mean3(shot, x, y))}`)
  }
}

// Layout: where the headline, subtitle and composer sit, in both images.
const inkBox = (img, test, x0, y0, x1, y1) => {
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (test(px(img, x, y))) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return maxX < 0 ? null : `x ${minX}-${maxX}  y ${minY}-${maxY}`
}
const edgesDown = (img, x, y0, y1) => {
  const rows = []
  for (let y = y0 + 1; y < y1; y++) {
    const a = px(img, x, y - 1)
    const b = px(img, x, y)
    if (Math.abs(lum(b) - lum(a)) > 9) rows.push(y)
  }
  return rows.join(',')
}
console.log('\nLayout (picture | ours)')
const white = (c) => lum(c) > 200
const muted = (c) => lum(c) > 120 && lum(c) <= 200 && c[2] > c[0]
console.log('  headline (white)  ' + inkBox(ref, white, 150, 150, 900, 330) + '  |  ' + inkBox(shot, white, 150, 150, 900, 330))
console.log('  subtitle (muted)  ' + inkBox(ref, muted, 150, 262, 900, 330) + '  |  ' + inkBox(shot, muted, 150, 262, 900, 330))
console.log('  composer edges at x=700 (rows)  ' + edgesDown(ref, 700, 330, 640) + '  |  ' + edgesDown(shot, 700, 330, 640))
console.log('  composer edges at y=450 (cols)  ' + (() => { const o = []; for (let x = 150; x < 1120; x++) { if (Math.abs(lum(px(ref, x, 450)) - lum(px(ref, x - 1, 450))) > 9) o.push(x) } return o.join(',') })() + '  |  ' + (() => { const o = []; for (let x = 150; x < 1120; x++) { if (Math.abs(lum(px(shot, x, 450)) - lum(px(shot, x - 1, 450))) > 9) o.push(x) } return o.join(',') })())

// 4. Whole arc region (no UI there in the picture), mean absolute error per channel.
let regionErr = 0
let regionN = 0
for (let y = 0; y < 360; y += 2) {
  for (let x = 770; x < W; x += 2) {
    const a = px(ref, x, y)
    const b = px(shot, x, y)
    regionErr += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3
    regionN++
  }
}
regionErr /= regionN

// Side-by-side: picture | ours | difference x4.
const side = new PNG({ width: W * 3, height: H })
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const a = px(ref, x, y)
    const b = px(shot, x, y)
    const put = (ox, c) => {
      const i = (y * side.width + x + ox) * 4
      side.data[i] = c[0]
      side.data[i + 1] = c[1]
      side.data[i + 2] = c[2]
      side.data[i + 3] = 255
    }
    put(0, a)
    put(W, b)
    put(W * 2, [Math.min(255, Math.abs(a[0] - b[0]) * 4), Math.min(255, Math.abs(a[1] - b[1]) * 4), Math.min(255, Math.abs(a[2] - b[2]) * 4)])
  }
}
writeFileSync(resolve(outDir, 'glow-side.png'), PNG.sync.write(side))
writeFileSync(resolve(outDir, 'glow-ours.png'), PNG.sync.write(shot))

console.log('\nSummary')
console.log(`  arc position error   ${posErr.toFixed(2)} px   (target <= 2)`)
console.log(`  core color error     ${(coreErr / coreN).toFixed(1)} / 255 (target <= 12)`)
console.log(`  radial falloff error ${(radErr / radN).toFixed(1)} / 255 (target <= 5)`)
console.log(`  arc region error     ${regionErr.toFixed(2)} / 255 (target <= 5)`)
console.log('  side-by-side: scripts/.output/glow-side.png')
const ok = posErr <= 2 && coreErr / coreN <= 12 && radErr / radN <= 5 && regionErr <= 5
console.log(ok ? '\nPASS' : '\nNOT YET: tune the ramps in tokens.css and the profile in GlowArc.tsx')
process.exit(ok ? 0 : 1)
