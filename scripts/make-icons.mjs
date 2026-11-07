// Generates the app icon set from the single logo source:
//   src/renderer/assets/logo/celeste-mark.svg  ->  resources/icon.png, resources/icon.ico, resources/icons/*.png
// When the final logo is ready, replace that SVG and run `npm run icons`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const root = resolve(import.meta.dirname, '..')
const markSvg = readFileSync(resolve(root, 'src/renderer/assets/logo/celeste-mark.svg'), 'utf8')
const inner = markSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

// Dark rounded square with a faint violet glow, as in the app icon of the brand picture.
const S = 1024
const scale = 2.95
const offset = (S - 256 * scale) / 2
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="ic-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#101734"/>
      <stop offset="1" stop-color="#070B18"/>
    </linearGradient>
    <radialGradient id="ic-glow" cx="0.78" cy="0.12" r="0.75">
      <stop offset="0" stop-color="#8F3B76" stop-opacity=".55"/>
      <stop offset=".5" stop-color="#553772" stop-opacity=".18"/>
      <stop offset="1" stop-color="#553772" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="ic-clip"><rect width="${S}" height="${S}" rx="228" ry="228"/></clipPath>
  </defs>
  <g clip-path="url(#ic-clip)">
    <rect width="${S}" height="${S}" fill="url(#ic-bg)"/>
    <rect width="${S}" height="${S}" fill="url(#ic-glow)"/>
    <rect x="2" y="2" width="${S - 4}" height="${S - 4}" rx="226" ry="226" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="4"/>
  </g>
  <g transform="translate(${offset.toFixed(1)} ${offset.toFixed(1)}) scale(${scale})">${inner}</g>
</svg>`

const render = (size) => new Resvg(icon, { fitTo: { mode: 'width', value: size } }).render().asPng()

const outDir = resolve(root, 'resources/icons')
mkdirSync(outDir, { recursive: true })
const sizes = [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024]
const pngs = new Map()
for (const size of sizes) {
  const png = render(size)
  pngs.set(size, png)
  writeFileSync(resolve(outDir, `celeste-${size}.png`), png)
}
writeFileSync(resolve(root, 'resources/icon.png'), pngs.get(512))
writeFileSync(resolve(root, 'resources/icon.ico'), await pngToIco([16, 24, 32, 48, 64, 128, 256].map((s) => pngs.get(s))))
console.log(`icons written to resources/ (${sizes.length} sizes + icon.png + icon.ico)`)
