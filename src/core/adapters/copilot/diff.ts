import type { DiffHunk, FileDiff } from '@shared/agent'

/** A path as the timeline shows it: relative to the session's folder when it is inside it, whole otherwise. */
export function displayPath(path: string, cwd?: string): string {
  const p = path.replace(/\\/g, '/')
  if (!cwd) return p
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const windows = /^[a-z]:/i.test(base)
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (p.length > base.length && p[base.length] === '/' && same(p.slice(0, base.length), base)) return p.slice(base.length + 1)
  return p
}

/** Reads the unified diff Copilot attaches to a write request into the hunks the diff view draws. */
export function parseUnifiedDiff(text: string, path: string): FileDiff {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  let status: FileDiff['status'] = 'modified'

  for (const line of text.split('\n')) {
    if (line.startsWith('new file mode') || line.startsWith('create file mode')) status = 'added'
    else if (line.startsWith('deleted file mode')) status = 'deleted'

    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[2])
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
      added++
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
      removed++
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return { path, status, added, removed, hunks }
}
