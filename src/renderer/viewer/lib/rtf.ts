/** Groups of an RTF file that hold no text of the document. */
const SKIPPED = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'mmathPr', 'object'])

/**
 * The text of an RTF document, as plain text with its paragraph breaks. It reads the words and the breaks, not the look: fonts, colours,
 * pictures and tables' borders are left out.
 */
export function rtfToText(rtf: string): string {
  let out = ''
  // One entry per open group: whether its text is left out, and how many characters follow a \uN as its fallback.
  const stack: { skip: boolean }[] = [{ skip: false }]
  let skipChars = 0
  let i = 0
  const top = () => stack[stack.length - 1]!
  const cp1252 = new TextDecoder('windows-1252')
  while (i < rtf.length) {
    const c = rtf[i]!
    if (c === '{') {
      stack.push({ skip: top().skip })
      i++
      // {\* is a destination that may be ignored; so is a group that starts with a name we skip.
      if (rtf[i] === '\\' && rtf[i + 1] === '*') top().skip = true
      else {
        const m = /^\\([a-zA-Z]+)/.exec(rtf.slice(i, i + 24))
        if (m && SKIPPED.has(m[1]!)) top().skip = true
      }
    } else if (c === '}') {
      if (stack.length > 1) stack.pop()
      i++
    } else if (c === '\\') {
      const next = rtf[i + 1] ?? ''
      if (next === '\\' || next === '{' || next === '}') {
        if (!top().skip && skipChars === 0) out += next
        else if (skipChars > 0) skipChars--
        i += 2
      } else if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4)
        if (!top().skip && skipChars === 0) out += cp1252.decode(new Uint8Array([parseInt(hex, 16) || 63]))
        else if (skipChars > 0) skipChars--
        i += 4
      } else if (next === '~') {
        if (!top().skip) out += ' '
        i += 2
      } else if (next === '-' || next === '_' || next === '|' || next === ':') {
        i += 2
      } else if (/[a-zA-Z]/.test(next)) {
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40))!
        const word = m[1]!
        const param = m[2] !== undefined ? parseInt(m[2], 10) : undefined
        i += m[0].length
        if (top().skip) continue
        if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') out += '\n'
        else if (word === 'tab') out += '\t'
        else if (word === 'emdash') out += '—'
        else if (word === 'endash') out += '–'
        else if (word === 'bullet') out += '•'
        else if (word === 'lquote') out += '‘'
        else if (word === 'rquote') out += '’'
        else if (word === 'ldblquote') out += '“'
        else if (word === 'rdblquote') out += '”'
        else if (word === 'cell') out += '\t'
        else if (word === 'row') out += '\n'
        else if (word === 'u' && param !== undefined) {
          out += String.fromCharCode(param < 0 ? param + 65536 : param)
          skipChars = 1
        }
      } else i += 2
    } else if (c === '\r' || c === '\n') {
      i++
    } else {
      if (!top().skip) {
        if (skipChars > 0) skipChars--
        else out += c
      }
      i++
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
