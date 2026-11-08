import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ENTRIES, MAX_PREVIEW_BYTES, listFolder, readPreview } from './files'

let outer: string
let project: string
const put = (rel: string, content: string | Buffer = 'x') => {
  const full = join(project, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

beforeEach(() => {
  outer = mkdtempSync(join(tmpdir(), 'celeste-files-'))
  project = join(outer, 'project')
  mkdirSync(project)
})
afterEach(() => rmSync(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

describe('listing a project folder', () => {
  it('lists folders first, then files, by name with numbers in order, and hides .git', () => {
    put('b.txt', 'bb')
    put('a10.txt')
    put('a2.txt')
    put('zeta/inner.txt')
    put('Alpha/inner.txt')
    put('.git/config', 'secret')
    put('.gitignore', '*.log')
    const { entries, more } = listFolder(project, '')
    expect(more).toBe(0)
    expect(entries.map((e) => `${e.kind}:${e.name}`)).toEqual(['dir:Alpha', 'dir:zeta', 'file:.gitignore', 'file:a2.txt', 'file:a10.txt', 'file:b.txt'])
    expect(entries.find((e) => e.name === 'b.txt')?.size).toBe(2)
    expect(entries.find((e) => e.name === 'zeta')?.size).toBeUndefined()
  })

  it('lists inside a folder, whichever way the path is written', () => {
    put('src/deep/one.ts')
    put('src/two.ts')
    for (const path of ['src', 'src/', './src', 'src\\', '/src']) expect(listFolder(project, path).entries.map((e) => e.name)).toEqual(['deep', 'two.ts'])
    expect(listFolder(project, 'src/deep').entries.map((e) => e.name)).toEqual(['one.ts'])
    expect(listFolder(project, '.').entries.map((e) => e.name)).toEqual(['src'])
  })

  it('lists at most 2000 things and counts the rest', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) put(`many/f${String(i).padStart(5, '0')}.txt`, '')
    const { entries, more } = listFolder(project, 'many')
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(more).toBe(5)
  })

  it('says so for a folder that is gone or is a file', () => {
    put('a.txt')
    expect(() => listFolder(project, 'nope')).toThrow(/not there any more/)
    expect(() => listFolder(project, 'a.txt')).toThrow(/not a folder/)
    expect(() => listFolder(join(outer, 'missing-project'), '')).toThrow(/not there any more/)
  })
})

describe('what a path may be', () => {
  it('refuses to go up, to start from a drive, to enter .git, or to be something odd', () => {
    put('a.txt')
    for (const path of ['..', '../x', 'a/../../x', '..\\x', 'sub/../..', 'C:', 'C:/Windows', '.git', 'sub/.git/config', '.GIT', 'x\0y']) {
      expect(() => listFolder(project, path), path).toThrow()
      expect(() => readPreview(project, path), path).toThrow()
    }
    expect(() => listFolder(project, 42 as unknown as string)).toThrow(/Invalid path/)
    expect(() => listFolder(project, 'a'.repeat(1001))).toThrow(/Invalid path/)
  })

  it('treats a path that starts with a slash as inside the project, never as the machine’s root', () => {
    put('etc/hosts', 'project copy')
    expect(readPreview(project, '/etc/hosts')).toMatchObject({ kind: 'text', text: 'project copy' })
    expect(readPreview(project, '/definitely/not/here')).toEqual({ kind: 'missing' })
  })

  it('does not follow a link out of the project, for a folder or for a file inside it', () => {
    writeFileSync(join(outer, 'secret.txt'), 'outside')
    mkdirSync(join(outer, 'outside-folder'))
    writeFileSync(join(outer, 'outside-folder', 'secret.txt'), 'outside too')
    put('inside/real.txt', 'inside')
    // A junction on Windows needs no special rights, and is a link like any other for this purpose.
    symlinkSync(join(outer, 'outside-folder'), join(project, 'escape'), 'junction')
    symlinkSync(join(project, 'inside'), join(project, 'shortcut'), 'junction')

    expect(() => listFolder(project, 'escape')).toThrow(/outside the project/)
    expect(() => readPreview(project, 'escape/secret.txt')).toThrow(/outside the project/)
    // The link is not listed beside the real things, and a link that stays inside is.
    expect(listFolder(project, '').entries.map((e) => e.name)).toEqual(['inside', 'shortcut'])
    expect(readPreview(project, 'shortcut/real.txt')).toMatchObject({ kind: 'text', text: 'inside' })
  })
})

describe('previewing a file', () => {
  it('gives the text, how long it is, and keeps accents and line endings', () => {
    put('a.txt', 'one\ntwo\nthree\n')
    put('crlf.txt', 'one\r\ntwo\r\n')
    put('accents.txt', 'héllo wörld ✓\n')
    put('no-newline.txt', 'one\ntwo')
    put('empty.txt', '')
    expect(readPreview(project, 'a.txt')).toEqual({ kind: 'text', text: 'one\ntwo\nthree\n', size: 14, lines: 3 })
    expect(readPreview(project, 'crlf.txt')).toMatchObject({ kind: 'text', text: 'one\r\ntwo\r\n', lines: 2 })
    expect(readPreview(project, 'accents.txt')).toMatchObject({ kind: 'text', text: 'héllo wörld ✓\n' })
    expect(readPreview(project, 'no-newline.txt')).toMatchObject({ lines: 2 })
    expect(readPreview(project, 'empty.txt')).toEqual({ kind: 'text', text: '', size: 0, lines: 0 })
  })

  it('says a file is not text, is too large, or is not there', () => {
    put('image.bin', Buffer.from([137, 80, 78, 71, 0, 1, 2]))
    put('big.txt', Buffer.alloc(MAX_PREVIEW_BYTES + 1, 97))
    put('limit.txt', Buffer.alloc(MAX_PREVIEW_BYTES, 97))
    mkdirSync(join(project, 'folder'))
    expect(readPreview(project, 'image.bin')).toEqual({ kind: 'binary', size: 7 })
    expect(readPreview(project, 'big.txt')).toEqual({ kind: 'large', size: MAX_PREVIEW_BYTES + 1 })
    expect(readPreview(project, 'limit.txt')).toMatchObject({ kind: 'text', size: MAX_PREVIEW_BYTES })
    expect(readPreview(project, 'gone.txt')).toEqual({ kind: 'missing' })
    expect(readPreview(project, 'folder')).toEqual({ kind: 'missing' })
    expect(readPreview(join(outer, 'no-such-project'), 'a.txt')).toEqual({ kind: 'missing' })
  })
})
