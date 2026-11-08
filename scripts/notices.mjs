// Writes THIRD_PARTY_NOTICES.md: every open-source package that is in the installer or in the interface's bundle, with its licence.
//   npm run notices        (run again when dependencies change; --check says whether it is current on this computer)
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Libraries that the interface bundles (so they are devDependencies) but that are in every installer all the same.
const BUNDLED = ['react', 'react-dom', 'radix-ui', 'lucide-react', 'zustand', 'react-markdown', 'remark-gfm', '@fontsource-variable/outfit', '@fontsource-variable/jetbrains-mono', '@xterm/xterm', '@xterm/addon-fit', '@xyflow/react']
// The vendors' own programs are downloaded by the person's computer from the vendors' registry; they are not part of what is shipped.
const NOT_SHIPPED = /^@github\/copilot-sdk-(darwin|linux|linuxmusl|win32)-|^@anthropic-ai\/claude-agent-sdk-(darwin|linux|win32)-/

const found = new Map()
const lookup = (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === dirname(dir)) return null
  }
}
const visit = (name, from) => {
  if (NOT_SHIPPED.test(name)) return
  const dir = lookup(name, from)
  if (!dir || found.has(dir)) return
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  found.set(dir, pkg)
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) visit(dep, dir)
}
for (const name of [...Object.keys(own.dependencies ?? {}), ...BUNDLED]) visit(name, root)

const licenseOf = (pkg) => {
  const l = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((x) => x.type).join(' OR ') : undefined)
  return typeof l === 'object' && l ? l.type : (l ?? 'UNKNOWN')
}
const textOf = (dir) => {
  const names = readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f))
  const pick = names.find((f) => /^licen[sc]e/i.test(f)) ?? names[0]
  return pick ? readFileSync(join(dir, pick), 'utf8').replace(/\r\n/g, '\n').trim() : ''
}

const entries = [...found].map(([dir, pkg]) => ({ name: pkg.name, version: pkg.version, license: licenseOf(pkg), repo: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url, text: textOf(dir) })).filter((e) => e.name !== own.name)
entries.sort((a, b) => a.name.localeCompare(b.name))

// One copy of each distinct licence text, with the packages it covers.
const groups = new Map()
for (const e of entries) {
  const key = createHash('sha256').update(e.text || `none:${e.license}`).digest('hex')
  const g = groups.get(key) ?? { text: e.text, license: e.license, packages: [] }
  g.packages.push(e)
  groups.set(key, g)
}

const out = []
out.push('# Third-party notices', '')
out.push('Celeste is licensed under the Apache License 2.0 (see `LICENSE`). It includes the open-source software below, each under its own licence. This file is made by `npm run notices` from the packages that are in the installer or in the interface bundle.', '')
out.push('**Electron** (MIT) and **Chromium** (BSD-style and other licences) are part of every installer: their licence files are in the application folder as `LICENSE.electron.txt` and `LICENSES.chromium.html`.', '')
out.push('**Vendors’ programs** (Claude Code, GitHub Copilot) are not part of Celeste. Celeste downloads them from npm when you connect that vendor, and they stay under the vendor’s own terms.', '')
out.push('**Fonts:** Outfit and JetBrains Mono, SIL Open Font License 1.1.', '')
out.push(`## Packages (${entries.length})`, '')
for (const e of entries) out.push(`- ${e.name} ${e.version} — ${e.license}`)
out.push('', '## Licence texts', '')
for (const g of [...groups.values()].sort((a, b) => b.packages.length - a.packages.length)) {
  out.push(`### ${g.license}`, '', `Applies to: ${g.packages.map((p) => `${p.name}@${p.version}`).join(', ')}`, '')
  out.push(g.text ? ['```text', g.text, '```'].join('\n') : '_These packages state their licence in package.json but ship no licence file._', '')
}
const text = `${out.join('\n')}\n`
if (process.argv.includes('--check')) {
  const current = existsSync(join(root, 'THIRD_PARTY_NOTICES.md')) ? readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== text) {
    console.error('THIRD_PARTY_NOTICES.md is out of date. Run `npm run notices` and commit it.')
    process.exit(1)
  }
  console.log(`THIRD_PARTY_NOTICES.md is current (${entries.length} packages).`)
} else {
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), text)
  const unknown = entries.filter((e) => e.license === 'UNKNOWN')
  console.log(`Wrote THIRD_PARTY_NOTICES.md: ${entries.length} packages, ${groups.size} licence texts${unknown.length ? `; no licence found for ${unknown.map((u) => u.name).join(', ')}` : ''}.`)
}
