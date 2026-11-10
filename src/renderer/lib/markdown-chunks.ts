/*
 * A long reply is drawn in pieces. While it streams, only the last piece changes: the pieces before it are the same text as
 * a moment ago, so they are not read again. (Reading a whole long answer for every few characters is slow.)
 *
 * A cut is made only where it cannot change how the text is drawn: at a blank line, outside a code block, and before a line that
 * is a plain paragraph, a heading or a code block. Never before a list item, a quote, a table row or anything indented, because
 * those belong with what is above them (a list with blank lines between its items is still one list).
 */

/** Pieces shorter than this are not cut, so a reply is never made of many tiny ones. */
const MIN_PIECE = 700

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CONTINUES = /^(\s{2,}|\t|[-*+](\s|$)|\d{1,9}[.)](\s|$)|>|\||<|\[[^\]]+\]:)/
const REFERENCE = /^ {0,3}\[[^\]]+\]:\s*\S/m

/** The text cut into pieces that can be drawn separately. A text that cannot be cut safely comes back whole. */
export function splitMarkdown(text: string): string[] {
  if (text.length < MIN_PIECE * 2 || REFERENCE.test(text)) return [text]
  const lines = text.split('\n')
  const pieces: string[] = []
  let start = 0
  let size = 0
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const f = FENCE.exec(line)
    if (f) {
      const mark = (f[1] as string)[0] as string
      if (fence === null) fence = mark
      else if (fence === mark) fence = null
    }
    size += line.length + 1
    if (fence !== null || line.trim() !== '' || size < MIN_PIECE) continue
    // A blank line outside a code block. The next line decides, and it must have arrived whole (the text ends with it, or goes on).
    let next = i + 1
    while (next < lines.length && (lines[next] as string).trim() === '') next++
    if (next >= lines.length - 1) break // nothing after it yet, or only the line that is still arriving
    if (CONTINUES.test(lines[next] as string)) continue
    pieces.push(lines.slice(start, i).join('\n'))
    start = next
    i = next - 1
    size = 0
  }
  pieces.push(lines.slice(start).join('\n'))
  return pieces.filter((p) => p !== '')
}
