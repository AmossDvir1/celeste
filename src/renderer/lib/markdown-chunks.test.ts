import { describe, expect, it } from 'vitest'
import { splitMarkdown } from './markdown-chunks'

const para = (n: number) => `Paragraph ${n}: ${'the quick brown fox jumps over the lazy dog. '.repeat(6).trim()}`

describe('cutting a long reply into pieces', () => {
  it('leaves a short reply whole', () => {
    expect(splitMarkdown('Hello\n\nthere')).toEqual(['Hello\n\nthere'])
  })

  it('cuts between plain paragraphs and headings, and nowhere else', () => {
    const text = [para(1), para(2), '## A heading', para(3), para(4), para(5)].join('\n\n') + '\n\n'
    const pieces = splitMarkdown(text)
    expect(pieces.length).toBeGreaterThan(1)
    // Nothing is lost: joined again, it is the same text (the blank lines between pieces aside).
    expect(pieces.join('\n\n').trim().replace(/\n+/g, '\n')).toBe(text.trim().replace(/\n+/g, '\n'))
    for (const p of pieces.slice(1)) expect(/^(Paragraph|##)/.test(p)).toBe(true)
  })

  it('never cuts inside a code block, even at a blank line, and never before a list, a quote, a table or something indented', () => {
    const code = '```ts\nconst a = 1\n\nconst b = 2\n\n\n'.concat(para(9), '\n```')
    const list = ['- first', '', '- second', '', '- third'].join('\n')
    const text = [para(1), code, para(2), list, para(3), '> quoted\n\n> more', para(4), '| a | b |\n|---|---|\n| 1 | 2 |', '    indented code', para(5), para(6), 'The end.'].join('\n\n')
    const pieces = splitMarkdown(text)
    for (const p of pieces) {
      // Every code fence is closed within its piece.
      expect((p.match(/^ {0,3}```/gm) ?? []).length % 2).toBe(0)
      // A piece starts with something that can start one.
      expect(/^(Paragraph|The end)/.test(p) || /^```/.test(p)).toBe(true)
    }
    const list3 = pieces.find((p) => p.includes('- first'))
    expect(list3).toContain('- third')
  })

  it('does not cut a text with reference links, which belong to the whole', () => {
    const text = [para(1), para(2), para(3), para(4), 'See [the docs][1].', '', '[1]: https://example.com'].join('\n\n')
    expect(splitMarkdown(text)).toEqual([text])
  })

  it('keeps the pieces already cut the same while more text arrives, so only the last one is drawn again', () => {
    const full = Array.from({ length: 14 }, (_, i) => para(i + 1)).join('\n\n') + '\n\n'
    let previous: string[] = []
    for (let n = 600; n <= full.length; n += 37) {
      const pieces = splitMarkdown(full.slice(0, n))
      // All but the last piece were already there, unchanged, a moment before.
      for (let i = 0; i < previous.length - 1; i++) expect(pieces[i]).toBe(previous[i])
      previous = pieces
    }
    expect(previous.length).toBeGreaterThan(2)
  })
})
