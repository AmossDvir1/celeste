import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { root } from './app.mjs'

/**
 * The packages the main process and Core load at run time: what package.json lists as dependencies, and what those need in turn, found
 * the way Node finds them. (The interface's libraries are bundled into it and are not needed.)
 *
 * The vendors' own programs are left out: Copilot's (about 180 MB) and Claude Code's (about 330 MB) are downloaded by the app the first
 * time that vendor is connected, checked against the checksum npm publishes.
 */
export const NOT_SHIPPED = /^@github\/copilot-sdk-(darwin|linux|linuxmusl|win32)-|^@anthropic-ai\/claude-agent-sdk-(darwin|linux|win32)-/

export function runtimePackages() {
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
    found.set(dir, name)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) visit(dep, dir)
  }
  const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const dep of Object.keys(own.dependencies ?? {})) visit(dep, root)
  return [...found.keys()]
}
