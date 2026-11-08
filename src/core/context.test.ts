import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTEXT_FILE_BYTES, CONTEXT_TOTAL_BYTES, contextText } from './context'

let project: string
const put = (rel: string, content: string | Buffer) => {
  const full = join(project, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'celeste-context-'))
})
afterEach(() => rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

describe('telling the agent about files the person added', () => {
  it('says nothing when nothing was added', () => {
    expect(contextText(project, [])).toBe('')
  })

  it('puts a small file in whole, with its path, so the agent does not have to go and read it', () => {
    put('src/a.ts', 'export const a = 1\nexport const b = 2\n')
    const text = contextText(project, [{ path: 'src/a.ts', kind: 'file' }])
    expect(text).toContain('added as context')
    expect(text).toContain('File: src/a.ts\n```\nexport const a = 1\nexport const b = 2\n```')
  })

  it('writes several in the order given, once each, with the path written either way round', () => {
    put('a.txt', 'first')
    put('dir/b.txt', 'second')
    const text = contextText(project, [
      { path: 'dir\\b.txt', kind: 'file' },
      { path: 'a.txt', kind: 'file' },
      { path: '/a.txt', kind: 'file' }
    ])
    expect(text.indexOf('File: dir/b.txt')).toBeGreaterThan(-1)
    expect(text.indexOf('File: dir/b.txt')).toBeLessThan(text.indexOf('File: a.txt'))
    expect(text.match(/File: a\.txt/g)).toHaveLength(1)
  })

  it('uses a longer fence when the file itself has fences in it', () => {
    put('notes.md', 'Example:\n```js\nlet x\n```\n')
    const text = contextText(project, [{ path: 'notes.md', kind: 'file' }])
    expect(text).toContain('````\nExample:\n```js\nlet x\n```\n````')
  })

  it('names a folder, and what is in it', () => {
    put('src/a.ts', 'x')
    put('src/b.ts', 'x')
    put('src/inner/c.ts', 'x')
    const text = contextText(project, [{ path: 'src', kind: 'dir' }])
    expect(text).toContain('Folder: src/ (contains inner/, a.ts, b.ts). Look at what you need from it.')
    expect(text).not.toContain('```')
  })

  it('names a long folder by its first entries and counts the rest', () => {
    for (let i = 0; i < 55; i++) put(`many/f${String(i).padStart(2, '0')}.txt`, 'x')
    expect(contextText(project, [{ path: 'many', kind: 'dir' }])).toMatch(/f39\.txt, and 15 more\)/)
  })

  it('names a file that is too large, one that is not text, and one that is gone, and puts none of them in', () => {
    put('big.txt', 'x'.repeat(CONTEXT_FILE_BYTES + 1))
    put('logo.png', Buffer.from([137, 80, 78, 71, 0, 1]))
    const text = contextText(project, [
      { path: 'big.txt', kind: 'file' },
      { path: 'logo.png', kind: 'file' },
      { path: 'gone.txt', kind: 'file' }
    ])
    expect(text).toMatch(/File: big\.txt \(\d+ KB, too large to include here/)
    expect(text).toContain('File: logo.png (6 bytes, not text, so it is not included).')
    expect(text).toContain('File: gone.txt (it could not be read; it may have been moved or removed).')
    expect(text).not.toContain('```')
  })

  it('stops putting files in once enough have gone in, and names the rest', () => {
    const size = CONTEXT_FILE_BYTES - 10
    const count = Math.ceil(CONTEXT_TOTAL_BYTES / size) + 1
    const refs = Array.from({ length: count }, (_, i) => {
      put(`f${i}.txt`, 'y'.repeat(size))
      return { path: `f${i}.txt`, kind: 'file' as const }
    })
    const text = contextText(project, refs)
    // Not every file went in whole, and the last one is only named.
    expect(text.split('```').length - 1).toBeLessThan(count * 2)
    expect(text.slice(text.indexOf(`File: f${count - 1}.txt`))).toMatch(/^File: f\d+\.txt \(\d+ KB, too large to include here/)
  })

  it('cannot be made to read outside the project', () => {
    writeFileSync(join(project, '..', 'celeste-outside.txt'), 'private')
    const text = contextText(project, [
      { path: '../celeste-outside.txt', kind: 'file' },
      { path: 'a/../../celeste-outside.txt', kind: 'file' },
      { path: '.git/config', kind: 'file' },
      { path: '..', kind: 'dir' }
    ])
    expect(text).not.toContain('private')
    expect(text.match(/could not be read/g)).toHaveLength(4)
    rmSync(join(project, '..', 'celeste-outside.txt'), { force: true })
  })
})
