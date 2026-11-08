import { readdirSync, readSync, openSync, closeSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { FileEntry, FileListing, FilePreview } from '@shared/api'

/*
 * What the file tree can see of a project: the folders and files inside the folder the session works in, and nothing else.
 * A path from the window is only ever a path inside that folder: it may not go up (`..`), may not start from a drive or the
 * root, may not enter a `.git` folder, and may not lead out through a link, whatever the link points at.
 */

/** A folder lists at most this many things; the rest are counted. */
export const MAX_ENTRIES = 2000
/** A file larger than this is not previewed. */
export const MAX_PREVIEW_BYTES = 1024 * 1024

/** Not shown at all: the project's own git data is not something to browse or edit by hand from here. */
const HIDDEN = new Set(['.git'])

const SEPARATORS = /[\\/]+/

/** The real place a project path is, or undefined when it is not there. Throws for a path that is not allowed. */
export function resolveInside(root: string, path: string): string | undefined {
  if (typeof path !== 'string' || path.length > 1000 || path.includes('\0')) throw new Error('Invalid path')
  const parts = path.split(SEPARATORS).filter((p) => p !== '' && p !== '.')
  for (const part of parts) {
    if (part === '..' || /^[a-z]:$/i.test(part)) throw new Error('That path is outside the project.')
    if (HIDDEN.has(part.toLowerCase())) throw new Error('That folder is not shown.')
  }
  let real: string
  let target: string
  try {
    real = realpathSync.native(root)
    target = realpathSync.native(join(real, ...parts))
  } catch {
    return undefined
  }
  // A link inside the project that leads somewhere else is not a way out.
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  const within = same(target, real) || (process.platform === 'win32' ? target.toLowerCase().startsWith(real.toLowerCase() + sep) : target.startsWith(real + sep))
  if (!within) throw new Error('That path is outside the project.')
  return target
}

const byName = (a: FileEntry, b: FileEntry) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1)

/** What is in a folder of the project: folders first, then files, by name. */
export function listFolder(root: string, path: string): FileListing {
  const dir = resolveInside(root, path)
  if (!dir) throw new Error('That folder is not there any more.')
  let names: import('node:fs').Dirent[]
  try {
    if (!statSync(dir).isDirectory()) throw new Error('That is not a folder.')
    names = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw err instanceof Error && err.message === 'That is not a folder.' ? err : new Error('That folder cannot be read.')
  }
  const entries: FileEntry[] = []
  for (const dirent of names) {
    if (HIDDEN.has(dirent.name.toLowerCase())) continue
    const full = join(dir, dirent.name)
    try {
      // A link is followed, but only if where it leads is inside the project.
      if (dirent.isSymbolicLink()) resolveInside(root, join(path, dirent.name))
      const st = statSync(full)
      if (st.isDirectory()) entries.push({ name: dirent.name, kind: 'dir' })
      else if (st.isFile()) entries.push({ name: dirent.name, kind: 'file', size: st.size })
    } catch {
      // A broken link, a link out of the project, or something that vanished: not listed.
    }
  }
  entries.sort(byName)
  return { entries: entries.slice(0, MAX_ENTRIES), more: Math.max(0, entries.length - MAX_ENTRIES) }
}

/** A file of the project for a preview: its text, or why there is none. */
export function readPreview(root: string, path: string): FilePreview {
  const file = resolveInside(root, path)
  if (!file) return { kind: 'missing' }
  let size: number
  try {
    const st = statSync(file)
    if (!st.isFile()) return { kind: 'missing' }
    size = st.size
  } catch {
    return { kind: 'missing' }
  }
  if (size > MAX_PREVIEW_BYTES) return { kind: 'large', size }
  const buffer = Buffer.alloc(size)
  let fd: number | undefined
  let got = 0
  try {
    fd = openSync(file, 'r')
    while (got < size) {
      const n = readSync(fd, buffer, got, size - got, got)
      if (n === 0) break
      got += n
    }
  } catch {
    return { kind: 'missing' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  // Text has no zero bytes. Looking at the start is enough to tell, and is what git does.
  const bytes = buffer.subarray(0, got)
  if (bytes.subarray(0, 8192).includes(0)) return { kind: 'binary', size }
  const text = bytes.toString('utf8')
  return { kind: 'text', text, size, lines: text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0) }
}
