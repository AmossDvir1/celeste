/** A numbered item: `1. text` or `1) text`, with its indent and the spaces after the marker. */
const ITEM = /^(\s*)(\d+)([.)])( +)/

export interface NumberingEdit {
  text: string
  caret: number
}

/**
 * Enter on a numbered item: starts the next number on a new line and renumbers the items that follow it in the same list.
 * On an item with nothing after its marker, the marker is removed instead, which ends the list. Returns null for anything else.
 */
export function continueNumbering(text: string, pos: number): NumberingEdit | null {
  const start = text.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = text.indexOf('\n', pos)
  const end = lineEnd === -1 ? text.length : lineEnd
  const line = text.slice(start, end)
  const m = ITEM.exec(line)
  // The caret must be past the marker: before it, Enter behaves as usual.
  if (!m || pos < start + m[0].length) return null

  const [marker, indent, num, delim, gap] = m
  const content = line.slice(marker.length)

  if (content.trim() === '' && pos === end) {
    return { text: text.slice(0, start) + indent + text.slice(end), caret: start + indent.length }
  }

  const n = Number(num)
  const head = text.slice(0, pos)
  const after = text.slice(pos, end).replace(/^ +/, '')

  // Items that follow in the same list (same indent and delimiter, no blank line between) move down one number each.
  const renumbered: string[] = []
  let stop = end
  for (let k = 1; stop < text.length; k++) {
    const nextStart = stop + 1
    let nextEnd = text.indexOf('\n', nextStart)
    if (nextEnd === -1) nextEnd = text.length
    const next = text.slice(nextStart, nextEnd)
    const item = ITEM.exec(next)
    if (!item || item[1] !== indent || item[3] !== delim) break
    renumbered.push(`${indent}${n + 1 + k}${delim}${item[4]}${next.slice(item[0].length)}`)
    stop = nextEnd
  }

  const newNum = String(n + 1)
  const body = `\n${indent}${newNum}${delim}${gap}${after}`
  const rest = renumbered.map((l) => `\n${l}`).join('')
  return {
    text: head + body + rest + text.slice(stop),
    caret: head.length + 1 + indent.length + newNum.length + delim.length + gap.length
  }
}
