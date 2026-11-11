import { describe, expect, it } from 'vitest'
import { odfBlocks } from './opendoc'
import { outline, slugify } from './outline'
import { parseNotebook } from './notebook'
import { rtfToText } from './rtf'
import { columnName, decodeText, guessDelimiter, parseDelimited, sizeLabel } from './text'

const bytes = (...n: number[]) => new Uint8Array(n).buffer

describe('reading text', () => {
  it('reads UTF-8, with or without a byte order mark, and UTF-16 with one', () => {
    expect(decodeText(new TextEncoder().encode('héllo ✓').buffer as ArrayBuffer)).toEqual({ text: 'héllo ✓', cut: false })
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69)).text).toBe('hi')
    expect(decodeText(bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00)).text).toBe('hi')
    expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69)).text).toBe('hi')
  })

  it('cuts a long file at the limit and says so', () => {
    const r = decodeText(new TextEncoder().encode('abcdefghij').buffer as ArrayBuffer, 4)
    expect(r).toEqual({ text: 'abcd', cut: true })
  })

  it('names sizes and spreadsheet columns', () => {
    expect(sizeLabel(512)).toBe('512 B')
    expect(sizeLabel(2048)).toBe('2.0 KB')
    expect(sizeLabel(5 * 1024 * 1024)).toBe('5.0 MB')
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA'])
  })
})

describe('delimited files', () => {
  it('splits rows and cells, with quotes, doubled quotes, line breaks inside a cell and both kinds of line end', () => {
    expect(parseDelimited('a,b,c\r\n1,"two, 2","say ""hi"""\n"line\nbreak",,end')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, 2', 'say "hi"'],
      ['line\nbreak', '', 'end']
    ])
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('x;y\n1;2', ';')).toEqual([['x', 'y'], ['1', '2']])
  })

  it('keeps a last row that has no line end, and an empty file is no rows', () => {
    expect(parseDelimited('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseDelimited('')).toEqual([])
    expect(parseDelimited('a,\n')).toEqual([['a', '']])
  })

  it('guesses the separator from the first line', () => {
    expect(guessDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(guessDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(guessDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(guessDelimiter('just words')).toBe(',')
  })
})

describe('Markdown outline', () => {
  it('lists the headings with anchors, not the ones in code, and makes repeated anchors different', () => {
    const md = '# Title\n\ntext\n\n## Setup\n\n```bash\n# not a heading\n```\n\n## Setup\n\n### Café & bar *now*\n\n~~~\n## also not\n~~~\n'
    expect(outline(md)).toEqual([
      { level: 1, text: 'Title', id: 'title' },
      { level: 2, text: 'Setup', id: 'setup' },
      { level: 2, text: 'Setup', id: 'setup-1' },
      { level: 3, text: 'Café & bar now', id: 'café-bar-now' }
    ])
  })

  it('makes an anchor of any text', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('`code` thing')).toBe('code-thing')
    expect(slugify('!!!')).toBe('section')
  })
})

describe('notebooks', () => {
  const nb = JSON.stringify({
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'text'] },
      { cell_type: 'code', execution_count: 3, source: 'print(1)', outputs: [{ output_type: 'stream', name: 'stdout', text: ['\u001b[31mone\u001b[0m\n'] }] },
      { cell_type: 'code', execution_count: null, source: ['x'], outputs: [{ output_type: 'execute_result', data: { 'text/plain': '42' } }, { output_type: 'display_data', data: { 'image/png': 'iVBO\nRw0K', 'text/plain': '<fig>' } }, { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[0;31mTraceback\u001b[0m', 'ValueError: bad'] }] },
      { cell_type: 'raw', source: 'raw text' }
    ]
  })

  it('reads cells, run counts and outputs, dropping colour codes', () => {
    const n = parseNotebook(nb)
    expect(n.language).toBe('python')
    expect(n.cells.map((c) => [c.kind, c.count])).toEqual([['markdown', null], ['code', 3], ['code', null], ['raw', null]])
    expect(n.cells[0]!.source).toBe('# Title\ntext')
    expect(n.cells[1]!.outputs).toEqual([{ kind: 'text', text: 'one\n' }])
    expect(n.cells[2]!.outputs).toEqual([
      { kind: 'text', text: '42' },
      { kind: 'image', mime: 'image/png', data: 'iVBORw0K' },
      { kind: 'text', error: true, text: 'Traceback\nValueError: bad' }
    ])
  })

  it('refuses a file that is not a notebook', () => {
    expect(() => parseNotebook('{"a": 1}')).toThrow(/not a notebook/)
    expect(() => parseNotebook('nonsense')).toThrow()
  })
})

describe('RTF', () => {
  it('reads the words and the breaks, and leaves out fonts, colours and the pieces that are not text', () => {
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}{\colortbl;\red255\green0\blue0;}{\*\generator Word;}{\info{\title Hidden}}\f0\fs24 Hello \b bold\b0  world.\par Second line\tab tabbed\par Caf\'e9 \u8364? and \{braces\}\par}`
    expect(rtfToText(rtf)).toBe('Hello bold world.\nSecond line\ttabbed\nCafé € and {braces}')
  })

  it('handles quotes, dashes and a negative unicode value', () => {
    expect(rtfToText(String.raw`{\rtf1 \ldblquote hi\rdblquote \emdash \u-10179?\u-8704?}`)).toBe('“hi”—' + String.fromCharCode(-10179 + 65536) + String.fromCharCode(-8704 + 65536))
  })

  it('does not fail on an empty or broken file', () => {
    expect(rtfToText('')).toBe('')
    expect(rtfToText('{\\rtf1 unclosed {group text')).toBe('unclosed group text')
  })
})

describe('OpenDocument text', () => {
  const doc = `<office:document-content><office:body><office:text>
    <text:h text:outline-level="1">Report &amp; plan</text:h>
    <text:p>First <text:span>part</text:span> here.<text:line-break/>Next<text:tab/>line<text:s text:c="2"/>end</text:p>
    <text:list><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p><text:list><text:list-item><text:p>Deep</text:p></text:list-item></text:list></text:list-item></text:list>
    <table:table><table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:table-cell/><table:table-cell><text:p>C1</text:p></table:table-cell></table:table-row></table:table>
    <text:p>After &#8364; &#x41;</text:p>
  </office:text></office:body></office:document-content>`

  it('reads headings, paragraphs, lists, table rows and entities, in order', () => {
    expect(odfBlocks(doc)).toEqual([
      { type: 'heading', level: 1, text: 'Report & plan' },
      { type: 'paragraph', text: 'First part here.\nNext line end' },
      { type: 'item', depth: 1, text: 'One' },
      { type: 'item', depth: 1, text: 'Two' },
      { type: 'item', depth: 2, text: 'Deep' },
      { type: 'row', cells: ['A1', '', 'C1'] },
      { type: 'paragraph', text: 'After € A' }
    ])
  })

  it('marks the slides of a presentation and reads their text', () => {
    const odp = '<draw:page draw:name="a"><draw:frame><draw:text-box><text:p>Slide one</text:p></draw:text-box></draw:frame></draw:page><draw:page><draw:frame><text:p>Two</text:p></draw:frame></draw:page>'
    expect(odfBlocks(odp)).toEqual([{ type: 'slide', number: 1 }, { type: 'paragraph', text: 'Slide one' }, { type: 'slide', number: 2 }, { type: 'paragraph', text: 'Two' }])
  })
})
