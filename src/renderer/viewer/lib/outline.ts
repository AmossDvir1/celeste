export interface Heading {
  level: number
  text: string
  id: string
}

/** The anchor a heading is given. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~[\]()]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  )
}

/** The headings of a Markdown document (not the ones inside a code block), with unique anchors. */
export function outline(source: string): Heading[] {
  const list: Heading[] = []
  const seen = new Map<string, number>()
  let fence: string | null = null
  for (const line of source.split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      fence = fence === null ? f[1]![0]! : fence === f[1]![0] ? null : fence
      continue
    }
    if (fence) continue
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const text = m[2]!.replace(/[`*_~]/g, '')
    const base = slugify(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    list.push({ level: m[1]!.length, text, id: n === 0 ? base : `${base}-${n}` })
  }
  return list
}
