/** What an OpenDocument file's text becomes: a flat list of blocks, in order. */
export type OdfBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'item'; depth: number; text: string }
  | { type: 'row'; cells: string[] }
  | { type: 'slide'; number: number }

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, dec, hex) => ENTITIES[m] ?? String.fromCodePoint(dec ? parseInt(dec, 10) : parseInt(hex, 16)))

/**
 * The text of the `content.xml` of an .odt (a document) or .odp (a presentation): headings, paragraphs, list items, table rows, and for
 * a presentation a marker for each slide. It reads the words, not the look.
 */
export function odfBlocks(xml: string): OdfBlock[] {
  const blocks: OdfBlock[] = []
  const tokens = xml.matchAll(/<(\/?)([\w:.-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g)
  let text: string | null = null
  let heading = 0
  let listDepth = 0
  let slide = 0
  let row: string[] | null = null
  let inCell = false
  let cellText = ''
  const flush = () => {
    if (text === null) return
    const t = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim()
    if (t) {
      if (inCell) cellText += (cellText ? '\n' : '') + t
      else if (heading) blocks.push({ type: 'heading', level: heading, text: t })
      else if (listDepth > 0) blocks.push({ type: 'item', depth: listDepth, text: t })
      else blocks.push({ type: 'paragraph', text: t })
    }
    text = null
    heading = 0
  }
  for (const m of tokens) {
    const [, closing, name, attrs, selfClosing, chars] = m
    if (chars !== undefined) {
      if (text !== null) text += decode(chars)
      continue
    }
    const tag = name!
    if (closing) {
      if (tag === 'text:p' || tag === 'text:h') flush()
      else if (tag === 'text:list') listDepth = Math.max(0, listDepth - 1)
      else if (tag === 'table:table-cell' && inCell) {
        row?.push(cellText)
        inCell = false
        cellText = ''
      } else if (tag === 'table:table-row' && row) {
        blocks.push({ type: 'row', cells: row })
        row = null
      }
      continue
    }
    if (tag === 'text:h' && !selfClosing) {
      text = ''
      heading = Number(/text:outline-level="(\d+)"/.exec(attrs ?? '')?.[1] ?? 1)
    } else if (tag === 'text:p' && !selfClosing) text = ''
    else if (tag === 'text:list') listDepth++
    else if (tag === 'draw:page') blocks.push({ type: 'slide', number: ++slide })
    else if (tag === 'table:table-row') row = []
    else if (tag === 'table:table-cell' && !selfClosing) {
      inCell = true
      cellText = ''
    } else if (tag === 'table:table-cell' && selfClosing) row?.push('')
    else if (text !== null && tag === 'text:line-break') text += '\n'
    else if (text !== null && tag === 'text:tab') text += '\t'
    else if (text !== null && tag === 'text:s') text += ' '.repeat(Number(/text:c="(\d+)"/.exec(attrs ?? '')?.[1] ?? 1))
  }
  return blocks
}
