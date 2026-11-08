// Lays out exactly what goes into an installer in release/stage: the built app, the run-time libraries and nothing else. The installer
// is then made from that folder (electron-builder, see electron-builder.yml). Staging it ourselves keeps the vendors' large optional
// programs, and every library of another computer's kind, out of the installer, and makes what ships a short list we can read.
//   node scripts/stage.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { root } from './lib/app.mjs'
import { runtimePackages } from './lib/runtime-packages.mjs'

const stage = join(root, 'release', 'stage')
if (!existsSync(join(root, 'out', 'main', 'index.js'))) throw new Error('Build first: run `npm run build`.')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const trimmed = { name: own.name, version: own.version, description: own.description, author: own.author, license: own.license, homepage: own.homepage, repository: own.repository, main: own.main, dependencies: own.dependencies }
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(trimmed, null, 2)}\n`)
cpSync(join(root, 'out'), join(stage, 'out'), { recursive: true })

const packages = runtimePackages()
for (const dir of packages) cpSync(dir, join(stage, relative(root, dir)), { recursive: true })

// The packager looks at what each library lists as optional (a program for every kind of computer, for instance) and fails on one that is not
// there. Only the ones that are here are kept in the list, so it finds what is here and nothing else.
const present = (name, from) => {
  for (let dir = from; ; dir = join(dir, '..')) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
    if (dir === join(dir, '..') || dir === stage) return false
  }
}
for (const dir of packages) {
  const file = join(stage, relative(root, dir), 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (!pkg.optionalDependencies) continue
  const kept = Object.fromEntries(Object.entries(pkg.optionalDependencies).filter(([name]) => present(name, join(stage, relative(root, dir)))))
  pkg.optionalDependencies = Object.keys(kept).length ? kept : undefined
  writeFileSync(file, JSON.stringify(pkg, null, 2))
}

const size = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)
console.log(`Staged version ${own.version}: ${packages.length} libraries, ${(size(stage) / 1024 / 1024).toFixed(0)} MB, in ${relative(root, stage)}`)
