import { TEXT_CUT_BYTES } from '@shared/preview'

/** Turns the first part of a file into text: UTF-8 (with or without a byte order mark) or UTF-16 with one. `cut` says the file was longer. */
export function decodeText(buf: ArrayBuffer, limit = TEXT_CUT_BYTES): { text: string; cut: boolean } {
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, limit))
  const cut = buf.byteLength > limit
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), cut }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), cut }
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  return { text: new TextDecoder('utf-8').decode(bytes.subarray(start)), cut }
}

/** The rows and columns of a comma or tab separated file, with quotes, doubled quotes and line breaks inside a quoted cell. */
export function parseDelimited(text: string, delimiter: ',' | '\t' | ';' = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** A guess at the separator of a delimited file, from its first line: the one that appears most outside quotes. */
export function guessDelimiter(text: string): ',' | '\t' | ';' {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (d: string) => first.split(d).length - 1
  const best = (['\t', ';', ','] as const).reduce((a, d) => (count(d) > count(a) ? d : a), ',' as ',' | '\t' | ';')
  return count(best) > 0 ? best : ','
}

/** A column's letters, as a spreadsheet names it: 0 is A, 25 is Z, 26 is AA. */
export function columnName(index: number): string {
  let n = index
  let name = ''
  do {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}

/** The size of a number of bytes, for a label. */
export function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
