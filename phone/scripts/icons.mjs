// Makes the Android icons from the one logo source (src/renderer/assets/logo/celeste-mark.svg), in the style of the
// desktop app's icon (scripts/make-icons.mjs): a deep navy tile with a violet glow and the mark.
//   mipmap-*/ic_launcher.png, ic_launcher_round.png      older Android
//   mipmap-*/ic_launcher_foreground.png, _background.png adaptive icons (Android 8+)
//   drawable/ic_stat_celeste.xml                         the white notification icon
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const here = resolve(import.meta.dirname, '..')
const res = resolve(here, 'android/app/src/main/res')
const mark = readFileSync(resolve(here, '../src/renderer/assets/logo/celeste-mark.svg'), 'utf8')
const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

const BG = `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101734"/><stop offset="1" stop-color="#070B18"/></linearGradient>
<radialGradient id="glow" cx="0.78" cy="0.12" r="0.75"><stop offset="0" stop-color="#8F3B76" stop-opacity=".55"/><stop offset=".5" stop-color="#553772" stop-opacity=".18"/><stop offset="1" stop-color="#553772" stop-opacity="0"/></radialGradient>`

const S = 1024
const markAt = (fraction) => {
  const scale = (S * fraction) / 256
  const off = (S - 256 * scale) / 2
  return `<g transform="translate(${off.toFixed(1)} ${off.toFixed(1)}) scale(${scale.toFixed(4)})">${inner}</g>`
}
const svg = (body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${BG}${defs}</defs>${body}</svg>`
const tile = (clip) =>
  svg(`<g clip-path="url(#c)"><rect width="${S}" height="${S}" fill="url(#bg)"/><rect width="${S}" height="${S}" fill="url(#glow)"/></g>${markAt(0.74)}`, `<clipPath id="c">${clip}</clipPath>`)

const legacy = tile(`<rect width="${S}" height="${S}" rx="228" ry="228"/>`)
const round = tile(`<circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}"/>`)
// Adaptive icons: the system masks a 108 dp square to its own shape and shows the middle 72 dp, so the mark stays inside.
const background = svg(`<rect width="${S}" height="${S}" fill="url(#bg)"/><rect width="${S}" height="${S}" fill="url(#glow)"/>`)
const foreground = svg(markAt(0.5))

const png = (source, size) => new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng()
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [d, k] of Object.entries(densities)) {
  const dir = resolve(res, `mipmap-${d}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'ic_launcher.png'), png(legacy, 48 * k))
  writeFileSync(resolve(dir, 'ic_launcher_round.png'), png(round, 48 * k))
  writeFileSync(resolve(dir, 'ic_launcher_foreground.png'), png(foreground, 108 * k))
  writeFileSync(resolve(dir, 'ic_launcher_background.png'), png(background, 108 * k))
}
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_stat_celeste"/>
</adaptive-icon>
`
writeFileSync(resolve(res, 'mipmap-anydpi-v26/ic_launcher.xml'), adaptive)
writeFileSync(resolve(res, 'mipmap-anydpi-v26/ic_launcher_round.xml'), adaptive)

// The notification icon is the crescent alone, in white, as Android wants.
const crescent = mark.match(/<path fill="url\(#cm-crescent\)" d="([^"]+)"/)?.[1]
if (!crescent) throw new Error('The crescent path was not found in the logo.')
writeFileSync(
  resolve(res, 'drawable/ic_stat_celeste.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by phone/scripts/icons.mjs from the logo's crescent. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="256" android:viewportHeight="256">
    <group android:scaleX="1.25" android:scaleY="1.25" android:pivotX="128" android:pivotY="128">
        <path android:fillColor="#FFFFFFFF" android:pathData="${crescent}"/>
    </group>
</vector>
`
)

// Capacitor's own placeholder art goes.
for (const f of ['drawable-v24/ic_launcher_foreground.xml', 'drawable/ic_launcher_background.xml', 'values/ic_launcher_background.xml']) rmSync(resolve(res, f), { force: true })
for (const d of ['drawable', 'drawable-land-hdpi', 'drawable-land-mdpi', 'drawable-land-xhdpi', 'drawable-land-xxhdpi', 'drawable-land-xxxhdpi', 'drawable-port-hdpi', 'drawable-port-mdpi', 'drawable-port-xhdpi', 'drawable-port-xxhdpi', 'drawable-port-xxxhdpi']) {
  rmSync(resolve(res, d, 'splash.png'), { force: true })
}
console.log('Icons written to', res)
