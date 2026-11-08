import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProducedFile } from '@shared/produced'

/*
 * Chat sessions work in a private folder of their own. What the agent wrote there during a turn is found by comparing the folder
 * before the message and after the answer, so it works the same for every vendor and also catches files made by a command.
 */

/** What a file looked like: size and modification time. A different one means the file was written. */
export type Manifest = Map<string, string>

const SKIP = new Set(['node_modules', '__pycache__', '.git'])
const MAX_VISITED = 3000
const MAX_DEPTH = 6

/** Every file under the folder, by path relative to it (forward slashes). Hidden files and folders are left out. */
export function scanFolder(root: string): Manifest {
  const found: Manifest = new Map()
  let visited = 0
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++visited > MAX_VISITED) return
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(join(dir, entry.name), rel, depth + 1)
      } else if (entry.isFile()) {
        try {
          const s = statSync(join(dir, entry.name))
          found.set(rel, `${s.size}:${Math.round(s.mtimeMs)}`)
        } catch {
          /* gone already */
        }
      }
    }
  }
  walk(root, '', 0)
  return found
}

/** The files that are new or were written since `before`, newest information first, at most `limit` of them. */
export function producedSince(before: Manifest, after: Manifest, limit = 12): { files: ProducedFile[]; more: number } {
  const all: ProducedFile[] = []
  for (const [path, stamp] of after) {
    const was = before.get(path)
    if (was === stamp) continue
    all.push({ path, size: Number(stamp.split(':')[0]), status: was === undefined ? 'added' : 'modified' })
  }
  // New files before changed ones, then by name, so the list does not depend on the order the disk gave them.
  all.sort((a, b) => (a.status === b.status ? a.path.localeCompare(b.path) : a.status === 'added' ? -1 : 1))
  return { files: all.slice(0, limit), more: Math.max(0, all.length - limit) }
}
